"use client";

/**
 * The phone brief's next events (mobile redesign PR2, MB1): the running and
 * upcoming timed events of the day as a row of chips — the time muted, then
 * the title. Below 360px one line instead: the next event to come ("Next ·
 * 15:00 Design review"), or the running one when nothing else is left.
 * Nothing at all while the calendar loads, fails or has nothing ahead; the
 * calendar card (and Calendar itself) own those states.
 */

import { useT } from "../../lib/i18n";
import { type NextEvent, nextEvents } from "./brief-model";
import { clock } from "./calendar-column";
import type { TimeContext } from "./mail-column";
import type { CalendarEventWire } from "./model";

interface NextEventsProps {
  events: readonly CalendarEventWire[];
  time: TimeContext;
  compact: boolean;
}

export function NextEvents({ events, time, compact }: NextEventsProps) {
  const { t } = useT();
  const next = nextEvents(events, time.now);
  if (next.length === 0) return null;
  const when = (item: NextEvent) =>
    item.now ? t("today.brief.next.now") : clock(item.event.startTime, time);

  if (compact) {
    const item = next.find((e) => !e.now) ?? next[0];
    return (
      <p
        data-testid="brief-next-line"
        className="flex min-w-0 items-baseline gap-1.5 text-role-meta text-ink-muted"
      >
        <span className="shrink-0">
          {item.now ? t("today.brief.next.now") : t("today.brief.next.one")} ·
        </span>
        {!item.now && <span className="shrink-0 tabular-nums">{when(item)}</span>}
        <span className="min-w-0 truncate text-ink">{item.event.title}</span>
      </p>
    );
  }

  return (
    <ul
      data-testid="brief-next-strip"
      aria-label={t("today.brief.next.label")}
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none]"
    >
      {next.map((item) => (
        <li
          key={item.event.id}
          className="flex min-h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-chip bg-surface-panel px-2.5 ring-1 ring-inset ring-line"
        >
          <span
            className={`shrink-0 text-role-caption tabular-nums ${item.now ? "font-semibold text-ink-soft" : "text-ink-muted"}`}
          >
            {when(item)}
          </span>
          <span className="min-w-0 truncate text-role-meta text-ink">{item.event.title}</span>
        </li>
      ))}
    </ul>
  );
}
