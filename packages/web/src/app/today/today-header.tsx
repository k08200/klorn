"use client";

/**
 * Today's header (productization plan §1, P6): the title, the date in the
 * user's zone and the day strip. The connected accounts and their health live
 * in the sidebar's Accounts group (SidebarAccounts) — the header no longer
 * repeats them. The sidebar is desktop-only, so on a phone the header keeps
 * one line for the accounts that need attention (reconnect / syncing) and the
 * retry when the list could not be read; a healthy phone shows nothing extra.
 */

import Link from "next/link";
import Button from "../../components/ui/button";
import { LANE_DOT_CLASS, useLaneName } from "../../components/ui/lane-chip";
import { SourceBadge } from "../../components/ui/source-badge";
import type { AccountHealth, ConnectedAccount } from "../../lib/connected-accounts";
import { useT } from "../../lib/i18n";
import { sourceGlyph } from "../../lib/source-provider";
import type { ConnectedAccountsState } from "../../lib/use-connected-accounts";
import { laneThreads, type TimeContext } from "./mail-column";
import { MAIL_HREF, preselectMailLane } from "./mail-link";
import { todayHeaderSummary, todayLaneCount, todayWaitingKey } from "./model";
import { useLaneCounts, useLaneMail } from "./use-today-data";

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
      <div className="flex flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h1 className="text-display text-ink">{t("nav.v2.today")}</h1>
          <p className="text-body text-ink-muted">
            <time dateTime={time.now.toISOString().slice(0, 10)}>{longDate(time)}</time>
          </p>
        </div>
        {showAccounts && <DayStrip />}
      </div>
      {showAccounts && <AccountAttention accounts={accounts} />}
    </header>
  );
}

/**
 * The day in one calm line (founder decision 2026-10-24): counts only for the
 * lanes that need the user — Push (the PUSH block's windowed count, the same
 * cache entry) and Meeting — then one quiet "N waiting in Mail" for Queue +
 * Info that opens Mail. Silent is never counted here. Nothing shows until the
 * lane counts arrive, and a failed read shows nothing; Push is left out while
 * its windowed read is pending or failed rather than showing the whole lane.
 */
function DayStrip() {
  const { t } = useT();
  const laneName = useLaneName();
  const { counts } = useLaneCounts(true);
  const push = useLaneMail("PUSH", true);
  if (!counts) return null;
  const { needs, calm, waiting } = todayHeaderSummary({
    push: todayLaneCount(
      "PUSH",
      laneThreads(counts, "PUSH"),
      push.loading || push.failed ? null : push.total,
    ),
    meeting: todayLaneCount("MEETING", laneThreads(counts, "MEETING"), null),
    queue: laneThreads(counts, "QUEUE"),
    info: laneThreads(counts, "INFO"),
  });
  return (
    <ul
      aria-label={t("today.strip.label")}
      className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-caption tabular-nums text-ink-muted"
    >
      {needs.map(({ lane, count }) => (
        <li key={lane} className="flex items-center gap-1.5 text-ink-soft">
          <span aria-hidden="true" className={`size-1.5 rounded-full ${LANE_DOT_CLASS[lane]}`} />
          {t("today.strip.lane", { count: String(count), lane: laneName(lane) })}
        </li>
      ))}
      {calm && <li>{t("today.lane.push.empty")}</li>}
      {waiting > 0 && (
        <li>
          <Link
            href={MAIL_HREF}
            onClick={() => preselectMailLane("QUEUE")}
            className="focus-ring rounded-control text-ink-muted underline-offset-2 transition-colors duration-120 ease-fluid hover:text-ink-soft hover:underline"
          >
            {t(todayWaitingKey(waiting), { count: String(waiting) })}
          </Link>
        </li>
      )}
    </ul>
  );
}

/**
 * Phone only (the sidebar is hidden below md): the accounts that need
 * attention, or the retry when the list failed. Nothing while loading or when
 * every account is synced — the sidebar states health on wider screens.
 */
function AccountAttention({ accounts }: { accounts: ConnectedAccountsState }) {
  const { t } = useT();
  if (accounts.failed) {
    return (
      <div role="alert" className="flex items-center gap-2 md:hidden">
        <p className="text-label font-normal text-state-danger-ink">{t("today.accounts.error")}</p>
        <Button variant="secondary" size="sm" onClick={accounts.retry}>
          {t("today.retry")}
        </Button>
      </div>
    );
  }
  const attention = accounts.loading ? [] : accounts.accounts.filter((a) => a.health !== "synced");
  if (attention.length === 0) return null;
  return (
    <nav
      aria-label={t("today.accounts.label")}
      className="relative -mx-4 flex items-center overflow-x-auto px-2 md:hidden"
    >
      <ul className="flex items-center gap-1">
        {attention.map((account) => (
          <li key={account.scope} className="shrink-0">
            <AccountChip account={account} />
          </li>
        ))}
      </ul>
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
