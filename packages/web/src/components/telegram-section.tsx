"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { captureClientError } from "../lib/sentry";
import { useConfirm } from "./confirm-dialog";
import { useToast } from "./toast";
import Button from "./ui/button";
import StatusChip from "./ui/status-chip";

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
    <div className="mt-4 bg-slate-50 border border-slate-200 rounded-xl p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-medium">Telegram</h3>
          <p className="text-sm text-slate-500">
            {linked
              ? "Connected — PUSH-tier interrupts also arrive in your Telegram chat."
              : "Receive PUSH-tier interrupts in a Telegram chat."}
          </p>
        </div>
        {loading ? (
          <span className="text-sm text-slate-500">Loading...</span>
        ) : linked ? (
          <div className="flex shrink-0 items-center gap-3">
            <StatusChip status="connected" />
            <Button
              variant="danger"
              size="sm"
              onClick={() => void disconnect()}
              disabled={submitting}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          !linkCode && (
            <Button
              variant="primary"
              onClick={() => void startLink()}
              disabled={submitting}
              loading={submitting}
              className="shrink-0"
            >
              Connect Telegram
            </Button>
          )
        )}
      </div>

      {!linked && !loading && linkCode && (
        <div className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-white p-3">
          {linkCode.deepLink ? (
            <p className="text-sm text-slate-500">
              Open{" "}
              <a
                href={linkCode.deepLink}
                target="_blank"
                rel="noreferrer"
                className="break-all text-sky-600 underline hover:text-sky-600"
              >
                {linkCode.deepLink}
              </a>{" "}
              and press <span className="font-medium text-slate-900">Start</span>.
            </p>
          ) : (
            <p className="text-sm text-slate-500">
              Send <span className="font-mono text-slate-900">/start {linkCode.code}</span> to your
              Klorn bot in Telegram.
            </p>
          )}
          <p className="text-xs text-slate-400">
            Code: <span className="font-mono text-slate-500">{linkCode.code}</span> · expires at{" "}
            {new Date(linkCode.expiresAt).toLocaleTimeString("en-US")}.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void checkLinked()}
              disabled={submitting}
              loading={submitting}
            >
              Check connection
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void startLink()}
              disabled={submitting}
            >
              New code
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
