"use client";

/**
 * The playground's two calls: classify (one paid inference on the visitor's
 * own key) and the "Wrong lane?" feedback. Errors come back as i18n keys plus
 * an optional upstream detail, so the page renders them in the visitor's
 * language; the server's own English message is never shown.
 */

import type { LiveTier, Tier } from "@klorn/contract";
import { useCallback, useState } from "react";
import { API_BASE } from "@/lib/api";
import type { DecidedBy } from "./decided";
import type { PlaygroundProvider } from "./models";

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

export interface PlaygroundError {
  key: string;
  detail?: string;
}

export interface ClassifyInput {
  from: string;
  subject: string;
  body: string;
  provider: PlaygroundProvider;
  apiKey: string;
  model: string;
}

/** Same ceiling the old page used: a stalled model fails fast, not forever. */
export const CLASSIFY_TIMEOUT_SECONDS = 40;
const CLASSIFY_TIMEOUT_MS = CLASSIFY_TIMEOUT_SECONDS * 1000;
/** Upstream detail is shown verbatim (already key-scrubbed server-side); cap it. */
const DETAIL_MAX = 300;

function isResult(data: unknown): data is ClassifyResult {
  if (!data || typeof data !== "object") return false;
  const d = data as Partial<ClassifyResult>;
  return typeof d.tier === "string" && typeof d.features === "object" && d.features !== null;
}

async function errorFor(res: Response): Promise<PlaygroundError> {
  if (res.status === 429) return { key: "playground.error.rateLimited" };
  const data = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  const detail = typeof data?.detail === "string" ? data.detail.slice(0, DETAIL_MAX) : undefined;
  if (res.status === 400) return { key: "playground.error.invalid" };
  return { key: "playground.error.failed", detail };
}

export function useClassify() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SortedResult | null>(null);
  const [error, setError] = useState<PlaygroundError | null>(null);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  const classify = useCallback(async (input: ClassifyInput): Promise<boolean> => {
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
        body: JSON.stringify({
          from: input.from.trim(),
          subject: input.subject.trim(),
          snippet: input.body.trim() || undefined,
          provider: input.provider,
          apiKey: input.apiKey.trim(),
          model: input.model.trim() || undefined,
        }),
      });
      if (!res.ok) {
        setError(await errorFor(res));
        return false;
      }
      const data: unknown = await res.json();
      if (!isResult(data)) {
        setError({ key: "playground.error.failed" });
        return false;
      }
      const seconds = Math.round((performance.now() - started) / 100) / 10;
      setResult({ ...data, model: input.model.trim(), seconds, subject: input.subject.trim() });
      return true;
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "AbortError";
      setError({ key: timedOut ? "playground.error.timeout" : "playground.error.network" });
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
