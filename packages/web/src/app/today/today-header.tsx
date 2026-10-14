"use client";

/**
 * Today's header (productization plan §1, P6): the title, the date in the
 * user's zone, and the accounts strip — every connected source as a
 * SourceBadge with its address and its health in words. There is no account
 * switcher (FD-2): the strip states what is connected and links to where
 * accounts are managed.
 */

import Link from "next/link";
import Button from "../../components/ui/button";
import { Skeleton, SkeletonGroup } from "../../components/ui/skeleton";
import { SourceBadge } from "../../components/ui/source-badge";
import type { AccountHealth, ConnectedAccount } from "../../lib/connected-accounts";
import { useT } from "../../lib/i18n";
import { sourceGlyph } from "../../lib/source-provider";
import type { ConnectedAccountsState } from "../../lib/use-connected-accounts";
import type { TimeContext } from "./mail-column";

export const ACCOUNTS_HREF = "/settings/accounts";

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

const HEALTH_TEXT: Record<AccountHealth, string> = {
  synced: "text-ink-muted",
  syncing: "text-ink-soft",
  reconnect: "font-medium text-state-danger-ink",
};

function longDate(time: TimeContext): string {
  return new Intl.DateTimeFormat(time.locale, {
    timeZone: time.timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(time.now);
}

interface TodayHeaderProps {
  time: TimeContext;
  accounts: ConnectedAccountsState;
  /** Hide the strip, e.g. while nothing is connected. */
  showAccounts: boolean;
}

export function TodayHeader({ time, accounts, showAccounts }: TodayHeaderProps) {
  const { t } = useT();
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-display text-ink">{t("nav.v2.today")}</h1>
        <p className="text-body text-ink-muted">
          <time dateTime={time.now.toISOString().slice(0, 10)}>{longDate(time)}</time>
        </p>
      </div>
      {showAccounts && <AccountsStrip accounts={accounts} />}
    </header>
  );
}

function AccountsStrip({ accounts }: { accounts: ConnectedAccountsState }) {
  const { t } = useT();
  return (
    <nav
      aria-label={t("today.accounts.label")}
      // One row that scrolls sideways on a phone; it never widens the page.
      // `relative` keeps the visually hidden health labels (absolutely
      // positioned) inside this scroller instead of widening the page.
      className="relative -mx-4 flex items-center gap-2 overflow-x-auto px-2 md:mx-0 md:overflow-visible md:px-0"
    >
      {accounts.loading && (
        <SkeletonGroup label={t("today.accounts.loading")} className="flex gap-2">
          <Skeleton variant="block" width="w-40" height="h-8" />
          <Skeleton variant="block" width="w-40" height="h-8" />
        </SkeletonGroup>
      )}
      {accounts.failed && (
        <div role="alert" className="flex items-center gap-2">
          <p className="text-label font-normal text-state-danger-ink">
            {t("today.accounts.error")}
          </p>
          <Button variant="secondary" size="sm" onClick={accounts.retry}>
            {t("today.retry")}
          </Button>
        </div>
      )}
      {!accounts.loading && !accounts.failed && (
        <ul className="flex items-center gap-1 md:-mx-2 md:flex-wrap">
          {accounts.accounts.map((account) => (
            <li key={account.scope} className="shrink-0">
              <AccountChip account={account} />
            </li>
          ))}
          <li className="shrink-0">
            <Link
              href={ACCOUNTS_HREF}
              className="focus-ring inline-flex min-h-11 items-center rounded-control px-2 text-label text-accent-deep hover:underline"
            >
              {t("today.accounts.add")}
            </Link>
          </li>
        </ul>
      )}
    </nav>
  );
}

function AccountChip({ account }: { account: ConnectedAccount }) {
  const { t } = useT();
  const name = account.email ?? sourceGlyph(account.provider).name;
  return (
    <Link
      href={ACCOUNTS_HREF}
      className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-control px-2 transition-colors duration-120 ease-fluid hover:bg-surface-hover"
    >
      <SourceBadge provider={account.provider} />
      <span className="max-w-44 truncate text-label font-normal text-ink-soft">{name}</span>
      <span
        className={`inline-flex items-center gap-1.5 text-caption ${HEALTH_TEXT[account.health]}`}
      >
        <span
          aria-hidden="true"
          className={`size-1.5 rounded-full ${HEALTH_DOT[account.health]}`}
        />
        {/* Health in words for everyone: always spoken, and spelled out on
            screen whenever the account needs attention. */}
        <span className={account.health === "synced" ? "sr-only" : undefined}>
          {t(HEALTH_LABEL_KEY[account.health])}
        </span>
      </span>
    </Link>
  );
}
