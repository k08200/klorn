"use client";

/**
 * The sync status of one connected IMAP mailbox (iCloud, Naver), under its card
 * in Settings -> Accounts: last successful sync, why the last one failed in
 * plain language, and — when the provider refused the stored app password —
 * an inline reconnect form. Apple revokes app-specific passwords when the Apple
 * Account password changes; the poll flags that at once, so this reads
 * "Reconnect needed" after one poll.
 */

import { useState } from "react";
import {
  ACCOUNT_HEALTH_REFRESH_EVENT,
  type ImapStatusAccount,
  imapAccountStatus,
  lastSyncCopy,
  syncProblemKey,
} from "../lib/account-health";
import { apiFetch } from "../lib/api";
import { useT } from "../lib/i18n";
import { captureClientError } from "../lib/sentry";
import Button from "./ui/button";
import { Input } from "./ui/input";

interface ImapAccountStatusProps {
  kind: "icloud" | "naver";
  account: ImapStatusAccount;
  /** The reconnect succeeded: the caller reloads its status. */
  onReconnected: () => void | Promise<void>;
}

export function ImapAccountStatus({ kind, account, onReconnected }: ImapAccountStatusProps) {
  const { t } = useT();
  const provider = kind === "icloud" ? "ICLOUD" : "NAVER";
  const status = imapAccountStatus(account);
  const sync = lastSyncCopy(account.lastSyncedAt, Date.now(), provider);
  const problem = syncProblemKey(status, account.syncErrorCode ?? null, provider);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  const reconnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFailed(false);
    try {
      const data = await apiFetch<{ ok: boolean }>(`/api/${kind}-imap/connect`, {
        method: "POST",
        body: JSON.stringify({ email: account.email, password }),
      });
      if (!data.ok) {
        setFailed(true);
        return;
      }
      setPassword("");
      await onReconnected();
      window.dispatchEvent(new Event(ACCOUNT_HEALTH_REFRESH_EVENT));
    } catch (err) {
      // A refused password (4xx) is the user's to fix, not an error to report.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.startsWith("API 4")) {
        captureClientError(err, { scope: `${kind}-imap.reconnect` });
      }
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-2 space-y-2">
      <p className="text-role-caption text-ink-mid">{t(sync.key, sync.vars)}</p>
      {problem && (
        <p
          role={status === "reconnect" ? "alert" : undefined}
          className="text-role-body text-state-danger-ink"
        >
          {t(problem)}
        </p>
      )}
      {status === "reconnect" && (
        <form onSubmit={reconnect} className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1">
            <Input
              id={`${kind}-reconnect-password`}
              label={t("accountHealth.reconnect.passwordLabel")}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>
          <Button type="submit" size="sm" disabled={submitting || !password} className="min-h-11">
            {t("accountHealth.reconnect.submit")}
          </Button>
          {failed && (
            <p role="alert" className="w-full text-role-caption text-state-danger-ink">
              {t("accountHealth.reconnect.failed")}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
