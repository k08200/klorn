"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useT } from "../lib/i18n";
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
  const { t } = useT();

  const loadStatus = useCallback(async (): Promise<boolean> => {
    try {
      const data = await apiFetch<{ linked: boolean }>("/api/telegram/link");
      setLinked(data.linked);
      if (data.linked) setLinkCode(null);
      return data.linked;
    } catch (err) {
      captureClientError(err, { scope: "telegram.status" });
      setError(t("telegram.error.status"));
      return false;
    } finally {
      setLoading(false);
    }
  }, [t]);

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
      setError(parseApiError(err, t("telegram.error.link")));
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
      toast(t("telegram.toast.connected"), "success");
    } else {
      toast(t("telegram.toast.notLinked"), "info");
    }
    setSubmitting(false);
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: t("telegram.confirmDisconnect.title"),
      message: t("telegram.confirmDisconnect.message"),
      confirmLabel: t("settings.disconnect"),
      danger: true,
    });
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/telegram/link", { method: "DELETE" });
      setLinked(false);
      setLinkCode(null);
      toast(t("telegram.toast.disconnected"), "info");
    } catch (err) {
      captureClientError(err, { scope: "telegram.unlink" });
      setError(t("telegram.error.disconnect"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="panel-elevated mt-3 rounded-2xl border border-line/70 bg-surface-panel p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-medium text-ink">Telegram</h3>
          <p className="text-sm text-ink-mid">
            {linked ? t("telegram.body.connected") : t("telegram.body.idle")}
          </p>
        </div>
        {loading ? (
          <span className="text-sm text-ink-mid">{t("common.loading")}</span>
        ) : linked ? (
          <div className="flex shrink-0 items-center gap-3">
            <StatusChip status="connected" />
            <Button
              variant="danger"
              size="sm"
              onClick={() => void disconnect()}
              disabled={submitting}
            >
              {t("settings.disconnect")}
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
              {t("telegram.connect")}
            </Button>
          )
        )}
      </div>

      {!linked && !loading && linkCode && (
        <div className="mt-3 space-y-2 rounded-xl border border-line-soft bg-surface-raised/70 p-3">
          {linkCode.deepLink ? (
            <p className="text-sm text-ink-mid">
              {t("telegram.deepLink.before")}{" "}
              <a
                href={linkCode.deepLink}
                target="_blank"
                rel="noreferrer"
                className="break-all text-accent-deep underline hover:text-accent-deep"
              >
                {linkCode.deepLink}
              </a>{" "}
              {t("telegram.deepLink.middle")}{" "}
              <span className="font-medium text-ink">{t("telegram.startButton")}</span>
              {t("telegram.deepLink.after")}
            </p>
          ) : (
            <p className="text-sm text-ink-mid">
              {t("telegram.manual.before")}{" "}
              <span className="font-mono text-ink">/start {linkCode.code}</span>{" "}
              {t("telegram.manual.after")}
            </p>
          )}
          <p className="text-xs text-ink-dim">
            {t("telegram.codeLabel")}{" "}
            <span className="font-mono text-ink-mid">{linkCode.code}</span>{" "}
            {t("telegram.expiresAt", {
              time: new Date(linkCode.expiresAt).toLocaleTimeString("en-US"),
            })}
          </p>
          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void checkLinked()}
              disabled={submitting}
              loading={submitting}
            >
              {t("telegram.check")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void startLink()}
              disabled={submitting}
            >
              {t("telegram.newCode")}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-state-danger-ink">
          {error}
        </p>
      )}
    </div>
  );
}
