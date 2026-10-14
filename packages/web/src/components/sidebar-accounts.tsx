"use client";

/**
 * The sidebar's Accounts group (productization plan §1, P6, UNIFIED_HOME):
 * every connected source with a health dot. It is a status list, not a
 * switcher (FD-2) — each row opens Settings → Accounts, where a source is
 * reconnected or added. Health is stated in words for assistive tech and
 * spelled out visibly whenever an account needs attention.
 */

import Link from "next/link";
import type { AccountHealth } from "../lib/connected-accounts";
import { useT } from "../lib/i18n";
import { sourceGlyph } from "../lib/source-provider";
import { useConnectedAccounts } from "../lib/use-connected-accounts";

const ACCOUNTS_HREF = "/settings/accounts";

const HEALTH_LABEL_KEY: Record<AccountHealth, string> = {
  synced: "today.accounts.synced",
  syncing: "today.accounts.syncing",
  reconnect: "today.accounts.reconnect",
};

const HEALTH_DOT: Record<AccountHealth, string> = {
  synced: "bg-state-ok-ink",
  syncing: "bg-accent-solid motion-safe:animate-pulse",
  reconnect: "bg-state-danger-ink",
};

export default function SidebarAccounts() {
  const { t } = useT();
  const { accounts, loading, failed } = useConnectedAccounts();
  // Nothing to state while loading or after a failed read: Today's own strip
  // carries the retry, and the rail never shows a guess.
  if (loading || failed) return null;
  return (
    <section aria-labelledby="sidebar-accounts" className="px-2 pt-6">
      <h2 id="sidebar-accounts" className="px-3 pb-1 text-caption font-medium text-ink-muted">
        {t("nav.v2.accounts")}
      </h2>
      <ul className="space-y-0.5">
        {accounts.map((account) => {
          const attention = account.health !== "synced";
          return (
            <li key={account.scope}>
              <Link
                href={ACCOUNTS_HREF}
                className="focus-ring flex min-h-10 items-center gap-2 rounded-lg px-3 py-1.5 text-label font-normal text-ink-mid transition-colors duration-120 ease-fluid hover:bg-surface-hover/70 hover:text-ink"
              >
                <span
                  aria-hidden="true"
                  className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-control border border-line bg-surface-raised px-1 text-caption font-semibold tracking-tight text-ink-soft"
                >
                  {sourceGlyph(account.provider).glyph}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    <span className="sr-only">{sourceGlyph(account.provider).name}: </span>
                    {account.email ?? sourceGlyph(account.provider).name}
                  </span>
                  {attention && (
                    <span
                      aria-hidden="true"
                      className={`block truncate text-caption ${account.health === "reconnect" ? "text-state-danger-ink" : "text-ink-muted"}`}
                    >
                      {t(HEALTH_LABEL_KEY[account.health])}
                    </span>
                  )}
                </span>
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 rounded-full ${HEALTH_DOT[account.health]}`}
                />
                <span className="sr-only">, {t(HEALTH_LABEL_KEY[account.health])}</span>
              </Link>
            </li>
          );
        })}
        <li>
          <Link
            href={ACCOUNTS_HREF}
            className="focus-ring flex min-h-10 items-center rounded-lg px-3 py-1.5 text-label font-normal text-ink-muted transition-colors duration-120 ease-fluid hover:bg-surface-hover/70 hover:text-ink"
          >
            {t("today.accounts.add")}
          </Link>
        </li>
      </ul>
    </section>
  );
}
