"use client";

import { useCallback, useEffect, useState } from "react";
import { TIER_COUNT } from "@/lib/tiers";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { captureClientError } from "../lib/sentry";
import { useConfirm } from "./confirm-dialog";
import { FirstSyncNote } from "./imap-connect-notes";
import { isEntitlementRefusal, MailAccountProGate } from "./mail-account-pro-gate";
import Button from "./ui/button";
import ErrorAlert from "./ui/error-alert";
import { Input } from "./ui/input";
import StatusChip from "./ui/status-chip";

interface NaverImapStatus {
  connected: boolean;
  /** Whether a NEW mailbox may be connected now (first free, second Pro). */
  canConnect?: boolean;
  email: string | null;
  host: string | null;
  connectedAt: string | null;
}

interface ConnectResponse {
  ok: boolean;
  email?: string;
  host?: string;
  message?: string;
  /** true = the first poll started now; false/absent = next scheduler tick. */
  firstSync?: boolean;
}

const DEFAULT_HOST = "imap.naver.com:993";

const PASSWORD_HELP_URL = "https://help.naver.com/service/3007/contents/?lang=ko";

interface NaverImapSectionProps {
  /**
   * Rendered inside another surface that already names it (the first run's
   * sheet): no panel chrome and no heading of its own. The form, the
   * requests and every state are the same.
   */
  embedded?: boolean;
  /** A mailbox was connected or disconnected; the caller refreshes its list. */
  onChanged?: () => void;
}

export function NaverImapSection({ embedded = false, onChanged }: NaverImapSectionProps = {}) {
  const { user } = useAuth();
  const { confirm } = useConfirm();
  const { t } = useT();
  // The first mail account is free whatever the provider; a second one is
  // Pro. The server answers `canConnect` on /status (always true while the
  // paywall is off); `entitled` is only the fallback for an older API. An
  // already-connected mailbox stays visible so a user who downgraded can
  // still see and disconnect it.
  const entitled = user?.entitled !== false;
  const [status, setStatus] = useState<NaverImapStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [hostInput, setHostInput] = useState(DEFAULT_HOST);
  const [submitting, setSubmitting] = useState(false);
  // Set by a connect: whether its first poll started now (shown under the account).
  const [firstSync, setFirstSync] = useState<boolean | null>(null);
  // The server refused with the Pro gate even though /status said otherwise
  // (e.g. another mailbox was connected meanwhile): show the same upgrade
  // panel, not a raw API error.
  const [proGated, setProGated] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<NaverImapStatus>("/api/naver-imap/status");
      setStatus(data);
    } catch (err) {
      captureClientError(err, { scope: "naver-imap.status" });
      setError(t("imap.naver.error.status"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const data = await apiFetch<ConnectResponse>("/api/naver-imap/connect", {
        method: "POST",
        body: JSON.stringify({
          email: emailInput.trim(),
          password: passwordInput,
          host: hostInput.trim() || DEFAULT_HOST,
        }),
      });
      if (!data.ok) {
        setError(data.message || t("imap.error.connectFailed"));
      } else {
        setEmailInput("");
        setPasswordInput("");
        setFirstSync(data.firstSync === true);
        await loadStatus();
        onChanged?.();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isEntitlementRefusal(msg)) {
        setProGated(true);
        return;
      }
      captureClientError(err, { scope: "naver-imap.connect" });
      setError(msg || t("imap.error.connectFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisconnect = async () => {
    if (submitting) return;
    const ok = await confirm({
      title: t("imap.naver.confirmDisconnect.title"),
      message: t("imap.confirmDisconnect.message"),
      confirmLabel: t("settings.disconnect"),
      danger: true,
    });
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/naver-imap/disconnect", { method: "POST" });
      await loadStatus();
      onChanged?.();
    } catch (err) {
      captureClientError(err, { scope: "naver-imap.disconnect" });
      setError(t("imap.error.disconnectFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      className={
        embedded
          ? undefined
          : "panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-5"
      }
    >
      <header className={embedded ? "hidden" : "mb-3 flex items-start justify-between gap-3"}>
        <div>
          <h2 className="text-base font-semibold text-ink">{t("imap.naver.title")}</h2>
          <p className="mt-1 text-xs text-ink-mid">
            {t("imap.naver.body", { count: String(TIER_COUNT) })}
          </p>
        </div>
        {status?.connected && <StatusChip status="connected" />}
      </header>

      {loading ? (
        <div className="text-xs text-ink-dim">{t("common.loading")}</div>
      ) : status?.connected ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-line-soft bg-surface-raised/70 p-3 text-sm text-ink">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{status.email}</p>
                <p className="text-[11px] text-ink-dim">
                  {t("imap.hostSince", { host: status.host ?? "—" })}{" "}
                  {status.connectedAt ? new Date(status.connectedAt).toLocaleString("en-US") : "—"}
                </p>
              </div>
              <Button
                variant="danger"
                size="sm"
                onClick={() => void handleDisconnect()}
                disabled={submitting}
                className="shrink-0"
              >
                {t("settings.disconnect")}
              </Button>
            </div>
          </div>
          {firstSync !== null && <FirstSyncNote started={firstSync} />}
          {error && (
            <p role="alert" className="text-xs text-state-danger-ink">
              {error}
            </p>
          )}
        </div>
      ) : !(status?.canConnect ?? entitled) || proGated ? (
        <MailAccountProGate />
      ) : (
        <form onSubmit={handleConnect} className="space-y-3">
          <Input
            id="naver-email"
            label={t("imap.naver.emailLabel")}
            type="email"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="you@naver.com"
            required
            autoComplete="off"
          />
          <div>
            <Input
              id="naver-password"
              label={t("imap.naver.passwordLabel")}
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder={t("imap.naver.passwordPlaceholder")}
              required
              autoComplete="off"
            />
            <p className="mt-1 text-[11px] text-ink-mid">
              {t("imap.naver.help.before")}{" "}
              <a
                href={PASSWORD_HELP_URL}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-ink-soft"
              >
                {t("imap.naver.help.link")}
              </a>
              {t("imap.naver.help.after")}
            </p>
          </div>
          <details className="text-xs text-ink-mid">
            <summary className="cursor-pointer">{t("imap.naver.advancedHost")}</summary>
            <div className="mt-2">
              <Input
                aria-label={t("imap.naver.hostLabel")}
                type="text"
                value={hostInput}
                onChange={(e) => setHostInput(e.target.value)}
                placeholder={DEFAULT_HOST}
              />
            </div>
          </details>
          {error && <ErrorAlert>{error}</ErrorAlert>}
          <Button
            type="submit"
            variant="primary"
            disabled={submitting || !emailInput || !passwordInput}
            loading={submitting}
          >
            {t("imap.naver.connect")}
          </Button>
        </form>
      )}
    </section>
  );
}
