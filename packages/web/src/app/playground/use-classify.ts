"use client";

/**
 * The playground's two calls: classify — one inference, either on Klorn's own
 * account (key-free demo) or on the visitor's key — and the "Wrong lane?"
 * feedback. Errors come back as i18n keys plus an optional upstream detail, so
 * the page renders them in the visitor's language; the server's own English
 * message is never shown.
 *
 * The request body and the refusal mapping live in classify-wire.ts, pure and
 * unit-tested; this hook is the React shell around them.
 */

import type { LiveTier, Tier } from "@klorn/contract";
import { useCallback, useState } from "react";
import { API_BASE } from "@/lib/api";
import {
  type ClassifyRequest,
  classifyErrorFor,
  classifyRequestBody,
  type WireError,
} from "./classify-wire";
import type { DecidedBy } from "./decided";
import { KLORN_MODEL_ID } from "./models";

export interface Features {
  confidence: number;
  senderTrust: number;
  reversibility: number;
  urgency: number;
}

export interface ClassifyResult {
  tier: Tier;
  reason: string;
  features: Features;
  source: string;
  decidedBy?: DecidedBy;
}

export interface SortedResult extends ClassifyResult {
  model: string;
  seconds: number;
  /** The subject that was classified — feedback reports this, not a later edit. */
  subject: string;
}

/** Same ceiling the old page used: a stalled model fails fast, not forever. */
export const CLASSIFY_TIMEOUT_SECONDS = 40;
const CLASSIFY_TIMEOUT_MS = CLASSIFY_TIMEOUT_SECONDS * 1000;

function isResult(data: unknown): data is ClassifyResult {
  if (!data || typeof data !== "object") return false;
  const d = data as Partial<ClassifyResult>;
  return typeof d.tier === "string" && typeof d.features === "object" && d.features !== null;
}

/**
 * The model the result card names. On the demo path the server pins the call to
 * its own JUDGE_MODEL and ignores any model we send, so reporting the picker's
 * value would name a model that never ran.
 */
function modelThatRan(request: ClassifyRequest): string {
  return request.mode === "byok" ? request.model.trim() : KLORN_MODEL_ID;
}

export function useClassify() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SortedResult | null>(null);
  const [error, setError] = useState<WireError | null>(null);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  const classify = useCallback(async (input: ClassifyRequest): Promise<boolean> => {
    setLoading(true);
    setError(null);
    setResult(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
    const started = performance.now();
    try {
      const res = await fetch(`${API_BASE}/api/playground/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(classifyRequestBody(input)),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as unknown;
        setError(classifyErrorFor(res.status, data, input.mode));
        return false;
      }
      const data: unknown = await res.json();
      if (!isResult(data)) {
        // A 200 whose body is not a verdict is the same class of failure as a
        // 5xx, so it reads by mode too.
        setError(classifyErrorFor(res.status, null, input.mode));
        return false;
      }
      const seconds = Math.round((performance.now() - started) / 100) / 10;
      setResult({
        ...data,
        model: modelThatRan(input),
        seconds,
        subject: input.subject.trim(),
      });
      return true;
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "AbortError";
      if (!timedOut) {
        setError({ key: "playground.error.network" });
      } else {
        // The BYOK timeout copy says to pick a faster model; in demo mode there
        // is no model to pick, so it would point at a control that isn't there.
        setError({
          key: input.mode === "demo" ? "playground.error.demoTimeout" : "playground.error.timeout",
        });
      }
      return false;
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }, []);

  return { loading, result, error, setError, classify, reset };
}

export type FeedbackState =
  | { status: "idle" }
  | { status: "sending"; tier: LiveTier }
  | { status: "sent"; tier: LiveTier }
  | { status: "error" };

/** Thanks only once the server accepted it; a failure says so. */
export async function sendFeedback(result: SortedResult, correctTier: LiveTier): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/playground/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: result.subject,
        predictedTier: result.tier,
        correctTier,
        model: result.model.slice(0, 120),
        source: result.source.slice(0, 40),
      }),
    });
    return res.ok;
  } catch {
    // Network failure: the caller shows the error state.
    return false;
  }
}
