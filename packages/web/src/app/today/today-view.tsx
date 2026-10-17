"use client";

/**
 * Today — the home (productization plan §1, P6, UNIFIED_HOME): every connected
 * account's mail by lane, the day's merged calendar and the assistant, at a
 * glance. Design detail pass W1: the lanes column `minmax(560px, 1fr)` beside
 * one 320px rail (Calendar, Files, Assistant as cards) once the page itself is
 * at least 912px wide (a container query, so the sidebar's width is already
 * accounted for); below that one scroll in the order PUSH, MEETING, calendar,
 * QUEUE, INFO, files, assistant.
 *
 * This file owns the layout and the page-level states; each block loads, fails
 * and retries on its own (see use-today-data).
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import EmptyState from "../../components/ui/empty-state";
import { useAuth } from "../../lib/auth";
import { filesEnabled } from "../../lib/home";
import { useT } from "../../lib/i18n";
import { useConnectedAccounts } from "../../lib/use-connected-accounts";
import { AssistantColumn } from "./assistant-column";
import { CalendarColumn } from "./calendar-column";
import { RecentFilesBlock } from "./files-block";
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
        <div className="@container">
          <div className="flex flex-col gap-7 @min-[912px]:grid @min-[912px]:grid-cols-[minmax(560px,1fr)_320px] @min-[912px]:items-start @min-[912px]:gap-8">
            <MailColumn accounts={accounts.accounts} time={time} />
            <aside
              aria-label={t("today.rail.label")}
              className="contents @min-[912px]:flex @min-[912px]:flex-col @min-[912px]:gap-5"
            >
              <CalendarColumn time={time} className="order-3" />
              {filesEnabled(user) && (
                <RecentFilesBlock timeZone={time.timeZone} className="order-6" />
              )}
              <AssistantColumn className="order-7" />
            </aside>
          </div>
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
