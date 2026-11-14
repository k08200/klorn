"use client";

/**
 * Generic IMAP accounts (a user-supplied mail server) in Settings -> Accounts —
 * DISPLAY ONLY. Connecting one stays off (GENERIC_IMAP_ENABLED is off in prod,
 * and its connect routes answer 404), so this card offers no form, no reconnect
 * and no disconnect, and never calls those routes. It reads the same
 * Account health list as the section above and shows each such account's
 * address, status in words and last sync; with none, it renders nothing.
 */

import type { AccountHealthEntry, AccountHealthResponse } from "@klorn/contract";
import { useCallback, useEffect, useState } from "react";
import {
  ACCOUNT_HEALTH_REFRESH_EVENT,
  genericImapAccounts,
  genericImapProblemKey,
  lastSyncCopy,
  statusChip,
} from "../lib/account-health";
import { apiFetch } from "../lib/api";
import { useT } from "../lib/i18n";
import { captureClientError } from "../lib/sentry";
import StatusChip from "./ui/status-chip";

export function GenericImapAccountsSection() {
  const { t } = useT();
  const [accounts, setAccounts] = useState<AccountHealthEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<AccountHealthResponse>("/api/email/accounts/health");
      setAccounts(genericImapAccounts(data.accounts));
    } catch (err) {
      // Account health above already says the list could not be loaded.
      captureClientError(err, { scope: "generic-imap-accounts.load" });
    } finally {
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener(ACCOUNT_HEALTH_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(ACCOUNT_HEALTH_REFRESH_EVENT, refresh);
  }, [load]);

  if (accounts.length === 0) return null;

  return (
    <section
      id="account-imap"
      aria-labelledby="account-imap-title"
      className="panel-elevated mb-8 scroll-mt-24 rounded-card border border-line/70 bg-surface-panel p-5"
    >
      <h2 id="account-imap-title" className="text-role-head text-ink">
        {t("imapGeneric.title")}
      </h2>
      <p className="mt-1 mb-3 text-role-body text-ink-mid">{t("imapGeneric.body")}</p>
      <ul className="divide-y divide-line-soft rounded-control border border-line-soft bg-surface-raised/70">
        {accounts.map((account) => (
          <GenericImapRow key={account.id ?? account.email} account={account} now={now} />
        ))}
      </ul>
    </section>
  );
}

function GenericImapRow({ account, now }: { account: AccountHealthEntry; now: number }) {
  const { t } = useT();
  const chip = statusChip(account.status);
  const sync = lastSyncCopy(account.lastSyncedAt, now, account.provider);
  const problem = genericImapProblemKey(account);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <p className="truncate font-medium text-ink">{account.email ?? "—"}</p>
        <p className="text-role-caption text-ink-mid">{t(sync.key, sync.vars)}</p>
        {problem && <p className="mt-1 text-role-body text-state-danger-ink">{t(problem)}</p>}
      </div>
      <StatusChip status={chip.chip} label={t(chip.labelKey)} />
    </li>
  );
}
