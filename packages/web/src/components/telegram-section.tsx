"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { captureClientError } from "../lib/sentry";
import { useConfirm } from "./confirm-dialog";
import { useToast } from "./toast";

interface TelegramLinkCode {
  code: string;
  expiresAt: string;
  deepLink: string | null;
}

// apiFetch throws `API <status>: <json body>` — surface the server's error
// message when present (e.g. "Telegram is not configured…"), else fallback.
function parseApiError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : "";
  const match = msg.match(/API \d+: (.+)/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[1]).error || fallback;
  } catch {
    return fallback;
  }
}

export function TelegramSection() {
  const [linked, setLinked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [linkCode, setLinkCode] = useState<TelegramLinkCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const { confirm } = useConfirm();

  const loadStatus = useCallback(async (): Promise<boolean> => {
    try {
      const data = await apiFetch<{ linked: boolean }>("/api/telegram/link");
      setLinked(data.linked);
      if (data.linked) setLinkCode(null);
      return data.linked;
    } catch (err) {
      captureClientError(err, { scope: "telegram.status" });
      setError("Could not load Telegram link status.");
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const startLink = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const data = await apiFetch<TelegramLinkCode>("/api/telegram/link", { method: "POST" });
      setLinkCode(data);
    } catch (err) {
      captureClientError(err, { scope: "telegram.link" });
      setError(parseApiError(err, "Could not start Telegram linking."));
    } finally {
      setSubmitting(false);
    }
  };

  const checkLinked = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const nowLinked = await loadStatus();
    if (nowLinked) {
      toast("Telegram connected.", "success");
    } else {
      toast("Not linked yet — open the link and press Start first.", "info");
    }
    setSubmitting(false);
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: "Disconnect Telegram",
      message: "Klorn stops sending interrupts to your Telegram chat. You can relink any time.",
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/telegram/link", { method: "DELETE" });
      setLinked(false);
      setLinkCode(null);
      toast("Telegram disconnected.", "info");
    } catch (err) {
      captureClientError(err, { scope: "telegram.unlink" });
      setError("Could not disconnect Telegram.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-4 bg-stone-950/35 border border-stone-700/45 rounded-xl p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-medium">Telegram</h3>
          <p className="text-sm text-stone-400">
            {linked
              ? "Connected — PUSH-tier interrupts also arrive in your Telegram chat."
              : "Receive PUSH-tier interrupts in a Telegram chat."}
          </p>
        </div>
        {loading ? (
          <span className="text-sm text-stone-500">Loading...</span>
        ) : linked ? (
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-sm text-green-400 flex items-center gap-1">
              <span className="w-2 h-2 bg-green-400 rounded-full" />
              Connected
            </span>
            <button
              type="button"
              onClick={disconnect}
              disabled={submitting}
              className="text-xs text-stone-500 hover:text-red-400 transition disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        ) : (
          !linkCode && (
            <button
              type="button"
              onClick={startLink}
              disabled={submitting}
              className="shrink-0 bg-amber-300 hover:bg-amber-200 disabled:opacity-50 text-stone-950 px-4 py-2 rounded-lg text-sm font-medium transition"
            >
              {submitting ? "..." : "Connect Telegram"}
            </button>
          )
        )}
      </div>

      {!linked && !loading && linkCode && (
        <div className="mt-3 space-y-2 rounded-lg border border-stone-800 bg-stone-900/40 p-3">
          {linkCode.deepLink ? (
            <p className="text-sm text-stone-300">
              Open{" "}
              <a
                href={linkCode.deepLink}
                target="_blank"
                rel="noreferrer"
                className="break-all text-amber-300 underline hover:text-amber-200"
              >
                {linkCode.deepLink}
              </a>{" "}
              and press <span className="font-medium text-stone-200">Start</span>.
            </p>
          ) : (
            <p className="text-sm text-stone-300">
              Send <span className="font-mono text-stone-200">/start {linkCode.code}</span> to your
              Klorn bot in Telegram.
            </p>
          )}
          <p className="text-xs text-stone-500">
            Code: <span className="font-mono text-stone-300">{linkCode.code}</span> · expires at{" "}
            {new Date(linkCode.expiresAt).toLocaleTimeString()}.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={checkLinked}
              disabled={submitting}
              className="rounded-md bg-amber-300 px-3 py-1.5 text-xs font-medium text-stone-950 transition hover:bg-amber-200 disabled:opacity-50"
            >
              {submitting ? "..." : "Check connection"}
            </button>
            <button
              type="button"
              onClick={startLink}
              disabled={submitting}
              className="rounded-md border border-stone-700 px-3 py-1.5 text-xs text-stone-300 transition hover:bg-stone-800 disabled:opacity-50"
            >
              New code
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
