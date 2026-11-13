"use client";

/**
 * Account health (Settings -> Accounts): every connected mail account in one
 * list — provider, status, last successful sync, the reason a sync failed in
 * plain language, and a link to the account's own controls when only the user
 * can fix it (a refused password or a revoked grant).
 *
 * Re-read every minute while the page is open, so a mailbox whose password was
 * revoked reads "Reconnect needed" right after the next poll (every 5 minutes).
 */

import type { AccountHealthEntry, AccountHealthResponse } from "@klorn/contract";
import { useCallback, useEffect, useState } from "react";
import { ListSkeleton } from "../../../components/skeleton";
import StatusChip from "../../../components/ui/status-chip";
import {
  accountSectionId,
  lastSyncCopy,
  PROVIDER_LABEL,
  statusChip,
  syncProblemKey,
} from "../../../lib/account-health";
import { apiFetch } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { captureClientError } from "../../../lib/sentry";
import { PANEL, PRIMARY_BTN, SECTION_TITLE } from "./shared";

const REFRESH_MS = 60_000;

function AccountRow({ account, now }: { account: AccountHealthEntry; now: number }) {
  const { t } = useT();
  const chip = statusChip(account.status);
  const sync = lastSyncCopy(account.lastSyncedAt, now, account.provider);
  const problem = syncProblemKey(account.status, account.errorCode, account.provider);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        <p className="font-medium">
          {PROVIDER_LABEL[account.provider]}
          {account.kind === "primary" && (
            <span className="ml-2 text-role-caption text-ink-dim">
              {t("accountHealth.primary")}
            </span>
          )}
        </p>
        {account.email && (
          <p className="truncate text-role-caption text-ink-dim">{account.email}</p>
        )}
        <p className="text-role-caption text-ink-mid">{t(sync.key, sync.vars)}</p>
        {problem && <p className="mt-1 text-role-body text-state-danger-ink">{t(problem)}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <StatusChip status={chip.chip} label={t(chip.labelKey)} />
        {account.action === "reconnect" && (
          <a
            href={`#${accountSectionId(account.provider, account.kind)}`}
            className={`${PRIMARY_BTN} min-h-11`}
          >
            {t("accountHealth.action.reconnect")}
          </a>
        )}
      </div>
    </li>
  );
}

export function AccountHealthSection() {
  const { t } = useT();
  const [accounts, setAccounts] = useState<AccountHealthEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<AccountHealthResponse>("/api/email/accounts/health");
      setAccounts(data.accounts);
      setFailed(false);
    } catch (err) {
      captureClientError(err, { scope: "account-health.load" });
      setFailed(true);
    } finally {
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <section className="mb-8" aria-labelledby="account-health-title">
      <h2 id="account-health-title" className={SECTION_TITLE}>
        {t("accountHealth.title")}
      </h2>
      <p className="mb-3 text-role-body text-ink-mid">{t("accountHealth.desc")}</p>
      <div className={PANEL}>
        {failed && !accounts ? (
          <p role="alert" className="p-4 text-role-body text-state-danger-ink">
            {t("accountHealth.loadFailed")}
          </p>
        ) : !accounts ? (
          <div className="p-4">
            <ListSkeleton count={2} />
          </div>
        ) : accounts.length === 0 ? (
          <p className="p-4 text-role-body text-ink-mid">{t("accountHealth.empty")}</p>
        ) : (
          <ul className="divide-y divide-line-soft" aria-live="polite">
            {accounts.map((account) => (
              <AccountRow key={account.id ?? "primary"} account={account} now={now} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
