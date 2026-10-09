"use client";

/**
 * Today — the home (productization plan §1, P6, UNIFIED_HOME): every connected
 * account's mail by lane, the day's merged calendar and the assistant strip,
 * at a glance. Three columns from 1280px, two from 768px, and one scroll on a
 * phone in the order PUSH, MEETING, calendar, QUEUE, INFO, assistant.
 *
 * This file owns the layout and the page-level states; each block loads, fails
 * and retries on its own (see use-today-data).
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import EmptyState from "../../components/ui/empty-state";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { useConnectedAccounts } from "../../lib/use-connected-accounts";
import { AssistantColumn } from "./assistant-column";
import { CalendarColumn } from "./calendar-column";
import { MailColumn, type TimeContext } from "./mail-column";
import { ACCOUNTS_HREF, TodayHeader } from "./today-header";
import { useRefreshOnNewMail } from "./use-today-data";

const DEFAULT_TIME_ZONE = "Asia/Seoul";
/** How often the clock moves: the "now" marker and the row times follow it. */
const CLOCK_TICK_MS = 60_000;

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function TodayView() {
  const { t, locale } = useT();
  const { user, hasMailSource } = useAuth();
  const router = useRouter();
  const now = useNow();
  const time: TimeContext = { now, locale, timeZone: user?.timezone ?? DEFAULT_TIME_ZONE };
  // Server truth, not the length of a list: a source the account list does not
  // show yet is still a source.
  const noSource = hasMailSource === false;
  const accounts = useConnectedAccounts(!noSource);
  useRefreshOnNewMail();

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
      <TodayHeader time={time} accounts={accounts} showAccounts={!noSource} />
      {noSource ? (
        <EmptyState
          headingLevel="h2"
          icon={<PlugGlyph />}
          title={t("today.connect.title")}
          description={t("today.connect.body")}
          primaryAction={{
            label: t("today.connect.action"),
            onClick: () => router.push(ACCOUNTS_HREF),
          }}
          className="rounded-card border border-line bg-surface-panel md:py-20"
        />
      ) : (
        <div className="flex flex-col gap-8 md:grid md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] md:items-start md:gap-x-10 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
          <MailColumn
            accounts={accounts.accounts}
            time={time}
            className="md:col-start-1 md:row-span-2 md:row-start-1 xl:row-span-1"
          />
          <CalendarColumn time={time} className="order-3 md:col-start-2 md:row-start-1" />
          <AssistantColumn className="order-6 md:col-start-2 md:row-start-2 xl:col-start-3 xl:row-start-1" />
        </div>
      )}
    </div>
  );
}

function PlugGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8ZM12 17v4" />
    </svg>
  );
}
