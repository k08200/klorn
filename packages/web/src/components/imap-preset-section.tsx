"use client";

/**
 * One app-password IMAP preset (Daum, Kakao, Yahoo, AOL, Fastmail, Zoho, Zoho
 * organization) in Settings -> Accounts and inside the first run's connect
 * sheet. ONE component for every preset, driven by lib/imap-presets.ts; it
 * behaves like the iCloud card: each connected mailbox with its last sync, why
 * a sync failed and an inline reconnect (ImapAccountStatus), a disconnect per
 * mailbox, and — with none connected — the address + app password form.
 *
 * IMAP_PRESETS_ENABLED is server-side: while it is off, or the user is outside
 * the rollout cohort, every /api/<slug>-imap route answers 404 and this card
 * renders nothing. No skeleton before the first status either: for most users
 * the card does not exist, and a flash-then-vanish panel is worse.
 */

import { useCallback, useEffect, useId, useState } from "react";
import { TIER_COUNT } from "@/lib/tiers";
import {
  ACCOUNT_HEALTH_REFRESH_EVENT,
  IMAP_STATUS_REFRESH_EVENT,
  type ImapStatusAccount,
  imapAccountStatus,
} from "../lib/account-health";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import type { ImapPreset } from "../lib/imap-presets";
import { captureClientError } from "../lib/sentry";
import { useConfirm } from "./confirm-dialog";
import { ImapAccountStatus } from "./imap-account-status";
import { classifyImapConnectFailure, type ImapConnectFailure } from "./imap-connect-error";
import { FirstSyncNote } from "./imap-connect-notes";
import { isEntitlementRefusal, MailAccountProGate } from "./mail-account-pro-gate";
import { BetaChip } from "./ui/beta-chip";
import Button from "./ui/button";
import ErrorAlert from "./ui/error-alert";
import { Input } from "./ui/input";
import StatusChip from "./ui/status-chip";

/** A mailbox as `/api/<slug>-imap/status` lists it. */
interface PresetAccount extends ImapStatusAccount {
  host: string | null;
  connectedAt: string;
}

interface PresetStatus {
  /** Whether a NEW mailbox may be connected now (the first is free, a second Pro). */
  canConnect?: boolean;
  accounts?: PresetAccount[];
}

interface ConnectResponse {
  ok: boolean;
  message?: string;
  /** true = the first poll started now; false/absent = next scheduler tick. */
  firstSync?: boolean;
}

type Translate = (key: string, vars?: Record<string, string>) => string;

/** The iCloud card's panel; it carries its own mb-8 because it may render nothing. */
const PANEL_CLASS = "panel-elevated mb-8 rounded-card border border-line/70 bg-surface-panel p-5";

const refreshAccountHealth = () => window.dispatchEvent(new Event(ACCOUNT_HEALTH_REFRESH_EVENT));

interface ImapPresetSectionProps {
  preset: ImapPreset;
  /**
   * Rendered inside a surface that already names it (the first run's sheet):
   * no panel chrome and no heading of its own. Requests and states are the same.
   */
  embedded?: boolean;
  /** A mailbox was connected or disconnected; the caller refreshes its list. */
  onChanged?: () => void;
}

/**
 * `/api/<slug>-imap/status`, reloaded when Account health's Reconnect link is
 * pressed. `unavailable`: the route answered 404 (flag off, or outside the cohort).
 */
function usePresetStatus(preset: ImapPreset) {
  const { t } = useT();
  const [status, setStatus] = useState<PresetStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await apiFetch<PresetStatus>(`/api/${preset.slug}-imap/status`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("API 404")) {
        setUnavailable(true);
        return;
      }
      captureClientError(err, { scope: `${preset.slug}-imap.status` });
      setError(t("imapPreset.error.status", { provider: preset.label }));
    } finally {
      setLoading(false);
    }
  }, [preset.slug, preset.label, t]);

  useEffect(() => {
    void loadStatus();
    // Account health's Reconnect link: the flag may be newer than this card.
    const refresh = () => void loadStatus();
    window.addEventListener(IMAP_STATUS_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(IMAP_STATUS_REFRESH_EVENT, refresh);
  }, [loadStatus]);

  return { status, loading, unavailable, error, setError, loadStatus };
}

export function ImapPresetSection({ preset, embedded = false, onChanged }: ImapPresetSectionProps) {
  const { user } = useAuth();
  const { confirm } = useConfirm();
  const { t } = useT();
  const { status, loading, unavailable, error, setError, loadStatus } = usePresetStatus(preset);
  const [busy, setBusy] = useState(false);
  const [firstSync, setFirstSync] = useState<boolean | null>(null);

  const afterChange = async () => {
    await loadStatus();
    onChanged?.();
    refreshAccountHealth();
  };

  const disconnect = async (email: string) => {
    if (busy) return;
    const ok = await confirm({
      title: t("imapPreset.confirmDisconnect.title", { email }),
      message: t("imap.confirmDisconnect.message"),
      confirmLabel: t("settings.disconnect"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/${preset.slug}-imap/disconnect`, {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setFirstSync(null);
      await afterChange();
    } catch (err) {
      captureClientError(err, { scope: `${preset.slug}-imap.disconnect` });
      setError(t("imap.error.disconnectFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (unavailable) return null;
  if (loading && !status) return null;

  const accounts = status?.accounts ?? [];
  // `entitled` is only the fallback for a status without `canConnect`.
  const mayConnect = status?.canConnect ?? user?.entitled !== false;

  // Embedded (the first run's sheet names it already): no panel and no heading.
  const chrome = embedded
    ? {}
    : { "aria-labelledby": `${preset.slug}-imap-title`, className: PANEL_CLASS };

  return (
    <section {...chrome}>
      {!embedded && <PresetHeader preset={preset} accounts={accounts} />}

      {loading ? (
        <div className="text-role-caption text-ink-dim">{t("common.loading")}</div>
      ) : accounts.length > 0 ? (
        <div className="space-y-4">
          {accounts.map((account) => (
            <PresetAccountRow
              key={account.email}
              preset={preset}
              account={account}
              busy={busy}
              onDisconnect={disconnect}
              onReconnected={loadStatus}
            />
          ))}
          {firstSync !== null && <FirstSyncNote started={firstSync} />}
        </div>
      ) : mayConnect ? (
        <PresetConnectForm
          preset={preset}
          onConnected={async (started) => {
            setFirstSync(started);
            await afterChange();
          }}
        />
      ) : (
        <MailAccountProGate />
      )}
      {error && (
        <div className="mt-3">
          <ErrorAlert>{error}</ErrorAlert>
        </div>
      )}
    </section>
  );
}

function PresetHeader({ preset, accounts }: { preset: ImapPreset; accounts: PresetAccount[] }) {
  const { t } = useT();
  const needsReconnect = accounts.some((account) => imapAccountStatus(account) === "reconnect");
  return (
    <header className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h2
          id={`${preset.slug}-imap-title`}
          className="flex items-center gap-2 text-role-head text-ink"
        >
          {preset.label}
          <BetaChip />
        </h2>
        <p className="mt-1 text-role-body text-ink-mid">
          {t("imapPreset.body", { provider: preset.label, count: String(TIER_COUNT) })}
        </p>
      </div>
      {accounts.length > 0 && (
        <StatusChip
          status={needsReconnect ? "failed" : "connected"}
          label={needsReconnect ? t("accountHealth.status.reconnect") : undefined}
        />
      )}
    </header>
  );
}

interface PresetAccountRowProps {
  preset: ImapPreset;
  account: PresetAccount;
  busy: boolean;
  onDisconnect: (email: string) => void;
  onReconnected: () => Promise<void>;
}

function PresetAccountRow({
  preset,
  account,
  busy,
  onDisconnect,
  onReconnected,
}: PresetAccountRowProps) {
  const { t, locale } = useT();
  const emailId = useId();
  return (
    <div>
      <div className="rounded-control border border-line-soft bg-surface-raised/70 p-3 text-role-body text-ink">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p id={emailId} className="truncate font-medium">
              {account.email}
            </p>
            <p className="text-role-caption text-ink-dim">
              {t("imap.hostSince", { host: account.host ?? "—" })}{" "}
              {new Date(account.connectedAt).toLocaleString(locale)}
            </p>
          </div>
          <Button
            variant="danger"
            size="sm"
            onClick={() => onDisconnect(account.email)}
            disabled={busy}
            aria-describedby={emailId}
            className="shrink-0"
          >
            {t("settings.disconnect")}
          </Button>
        </div>
      </div>
      <ImapAccountStatus kind={preset.slug} account={account} onReconnected={onReconnected} />
    </div>
  );
}

function failureText(failure: ImapConnectFailure, preset: ImapPreset, t: Translate): string {
  switch (failure.kind) {
    case "auth":
      return t("imapPreset.error.auth", { provider: preset.label });
    case "tooManyAttempts":
      return t("imapPreset.error.tooManyAttempts");
    case "server":
      return failure.message;
    default:
      return t("imap.error.connectFailed");
  }
}

/**
 * What a thrown connect shows: the sentence, or null for the Pro gate (the
 * upgrade note, not an error). Only the unexpected is reported: a refusal (4xx)
 * is the user's to fix.
 */
function connectFailureText(err: unknown, preset: ImapPreset, t: Translate): string | null {
  const message = err instanceof Error ? err.message : String(err);
  if (isEntitlementRefusal(message)) return null;
  const failure = classifyImapConnectFailure(message);
  if (failure.kind === "unexpected" && !message.startsWith("API 4")) {
    captureClientError(err, { scope: `${preset.slug}-imap.connect` });
  }
  return failureText(failure, preset, t);
}

interface PresetConnectFormProps {
  preset: ImapPreset;
  /** The connect succeeded; `firstSync`: its first poll started now. */
  onConnected: (firstSync: boolean) => Promise<void>;
}

function PresetConnectForm({ preset, onConnected }: PresetConnectFormProps) {
  const { t } = useT();
  const hintId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server refused with the Pro gate although /status allowed a connect
  // (another mailbox was connected meanwhile): the upgrade note, not an error.
  const [proGated, setProGated] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const data = await apiFetch<ConnectResponse>(`/api/${preset.slug}-imap/connect`, {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!data.ok) {
        setError(data.message || t("imap.error.connectFailed"));
        return;
      }
      setEmail("");
      setPassword("");
      await onConnected(data.firstSync === true);
    } catch (err) {
      const text = connectFailureText(err, preset, t);
      if (text === null) setProGated(true);
      else setError(text);
    } finally {
      setSubmitting(false);
    }
  };

  if (proGated) return <MailAccountProGate />;

  return (
    <form onSubmit={submit} className="space-y-3">
      <Input
        id={`${preset.slug}-email`}
        label={t("imapPreset.emailLabel")}
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={preset.emailPlaceholder}
        required
        autoComplete="email"
      />
      <div>
        <Input
          id={`${preset.slug}-password`}
          label={t(preset.passwordLabelKey)}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="new-password"
          aria-describedby={hintId}
        />
        <p id={hintId} className="mt-1 text-role-caption text-ink-mid">
          {t(preset.hintKey)}{" "}
          <a
            href={preset.helpUrl}
            target="_blank"
            rel="noreferrer"
            className="focus-ring rounded-control underline hover:text-ink-soft"
          >
            {t("imapPreset.help.link", { provider: preset.label })}
            <span className="sr-only"> {t("files.opensNewTab")}</span>
          </a>{" "}
          {t("imapPreset.help.stored")}
        </p>
      </div>
      {error && <ErrorAlert>{error}</ErrorAlert>}
      <Button
        type="submit"
        variant="primary"
        disabled={submitting || !email || !password}
        loading={submitting}
      >
        {t("imapPreset.connect", { provider: preset.label })}
      </Button>
    </form>
  );
}
