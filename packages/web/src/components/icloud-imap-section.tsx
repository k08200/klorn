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

interface ICloudImapStatus {
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

const APP_PASSWORD_HELP_URL = "https://support.apple.com/102654";

interface ICloudImapSectionProps {
  /**
   * Rendered inside another surface that already names it (the first run's
   * sheet): no panel chrome and no heading of its own. The form, the
   * requests and every state are the same.
   */
  embedded?: boolean;
  /** A mailbox was connected or disconnected; the caller refreshes its list. */
  onChanged?: () => void;
}

export function ICloudImapSection({ embedded = false, onChanged }: ICloudImapSectionProps = {}) {
  const { user } = useAuth();
  const { confirm } = useConfirm();
  const { t } = useT();
  // The first mail account is free whatever the provider; a second one is
  // Pro. The server answers `canConnect` on /status (always true while the
  // paywall is off); `entitled` is only the fallback for an older API. An
  // already-connected mailbox stays visible so a user who downgraded can
  // still see and disconnect it.
  const entitled = user?.entitled !== false;
  const [status, setStatus] = useState<ICloudImapStatus | null>(null);
  const [loading, setLoading] = useState(true);
  // ICLOUD_INBOX_ENABLED is server-side: while it's off every
  // /api/icloud-imap route 404s, and this section renders nothing — the
  // same "dark until flipped" pattern as the API surface itself.
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
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
      const data = await apiFetch<ICloudImapStatus>("/api/icloud-imap/status");
      setStatus(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("API 404")) {
        setUnavailable(true);
        return;
      }
      captureClientError(err, { scope: "icloud-imap.status" });
      setError(t("imap.icloud.error.status"));
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
      const data = await apiFetch<ConnectResponse>("/api/icloud-imap/connect", {
        method: "POST",
        body: JSON.stringify({
          email: emailInput.trim(),
          password: passwordInput,
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
      captureClientError(err, { scope: "icloud-imap.connect" });
      setError(msg || t("imap.error.connectFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisconnect = async () => {
    if (submitting) return;
    const ok = await confirm({
      title: t("imap.icloud.confirmDisconnect.title"),
      message: t("imap.confirmDisconnect.message"),
      confirmLabel: t("settings.disconnect"),
      danger: true,
    });
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/icloud-imap/disconnect", { method: "POST" });
      await loadStatus();
      onChanged?.();
    } catch (err) {
      captureClientError(err, { scope: "icloud-imap.disconnect" });
      setError(t("imap.error.disconnectFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  if (unavailable) return null;
  // No skeleton before the first status resolves: for most users (flag off)
  // this section does not exist, and a flash-then-vanish panel is worse than
  // a section that appears once confirmed available.
  if (loading && !status) return null;

  return (
    <section
      className={
        embedded
          ? undefined
          : "panel-elevated mb-8 rounded-2xl border border-line/70 bg-surface-panel p-5"
      }
    >
      <header className={embedded ? "hidden" : "mb-3 flex items-start justify-between gap-3"}>
        <div>
          <h2 className="text-base font-semibold text-ink">{t("imap.icloud.title")}</h2>
          <p className="mt-1 text-xs text-ink-mid">
            {t("imap.icloud.body", { count: String(TIER_COUNT) })}
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
            id="icloud-email"
            label={t("imap.icloud.emailLabel")}
            type="email"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="you@icloud.com"
            required
            autoComplete="off"
          />
          <div>
            <Input
              id="icloud-password"
              label={t("imap.icloud.passwordLabel")}
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="xxxx-xxxx-xxxx-xxxx"
              required
              autoComplete="off"
            />
            <p className="mt-1 text-[11px] text-ink-mid">
              {t("imap.icloud.help.before")}{" "}
              <a
                href={APP_PASSWORD_HELP_URL}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-ink-soft"
              >
                {t("imap.icloud.help.link")}
              </a>{" "}
              {t("imap.icloud.help.after")}
            </p>
          </div>
          {error && <ErrorAlert>{error}</ErrorAlert>}
          <Button
            type="submit"
            variant="primary"
            disabled={submitting || !emailInput || !passwordInput}
            loading={submitting}
          >
            {t("imap.icloud.connect")}
          </Button>
        </form>
      )}
    </section>
  );
}
