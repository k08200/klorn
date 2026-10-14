"use client";

/**
 * Today, column B — today's events from every connected calendar in one
 * timeline (productization plan §1, P6). Each event carries a 3px bar in its
 * calendar's colour when the provider recorded one, and says which account it
 * came from. Overlapping events are flagged in words, not by colour alone, and
 * a "now" marker shows where the day stands.
 */

import Link from "next/link";
import { SourceBadge } from "../../components/ui/source-badge";
import { useT } from "../../lib/i18n";
import { BlockError, BlockLink, BlockNote, LinesSkeleton, TodayBlock } from "./block";
import type { TimeContext } from "./mail-column";
import {
  type CalendarEventWire,
  eventBarColor,
  eventPhase,
  eventSourceProvider,
  findConflicts,
  nowMarkerIndex,
  orderEvents,
} from "./model";
import { useTodayEvents } from "./use-today-data";

const CALENDAR_HREF = "/calendar";

function clock(iso: string, time: TimeContext): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(time.locale, {
    timeZone: time.timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function CalendarColumn({
  time,
  className = "",
}: {
  time: TimeContext;
  className?: string;
}) {
  const { t } = useT();
  const calendar = useTodayEvents(time.now, time.timeZone, true);
  const ordered = orderEvents(calendar.events);
  const conflicts = findConflicts(ordered);
  const marker = nowMarkerIndex(ordered, time.now);
  const loaded = !calendar.loading && !calendar.failed;
  return (
    <TodayBlock
      headingId="today-calendar"
      title={t("today.calendar.title")}
      hint={
        loaded && conflicts.size > 0
          ? t("today.calendar.overlaps", { count: String(conflicts.size) })
          : undefined
      }
      count={loaded ? ordered.length : null}
      countLabel={loaded ? t("today.calendar.count", { count: String(ordered.length) }) : undefined}
      className={className}
    >
      {calendar.loading && <LinesSkeleton lines={4} label={t("today.calendar.loading")} />}
      {calendar.failed && (
        <BlockError message={t("today.calendar.error")} onRetry={calendar.retry} />
      )}
      {loaded && ordered.length === 0 && <BlockNote>{t("today.calendar.empty")}</BlockNote>}
      {loaded && ordered.length > 0 && (
        <ol className="flex flex-col pt-1">
          {ordered.map((event, index) => (
            <li key={event.id}>
              {marker === index && <NowMarker time={time} />}
              <EventRow event={event} time={time} conflict={conflicts.has(event.id)} />
            </li>
          ))}
          {marker === ordered.length && (
            <li>
              <NowMarker time={time} />
            </li>
          )}
        </ol>
      )}
      <BlockLink href={CALENDAR_HREF}>{t("today.calendar.open")}</BlockLink>
    </TodayBlock>
  );
}

function NowMarker({ time }: { time: TimeContext }) {
  const { t } = useT();
  return (
    <p className="flex items-center gap-2 py-1 text-caption font-medium text-accent-deep">
      <span className="w-16 shrink-0 text-right">
        {t("today.calendar.now")}
        <span className="sr-only"> {clock(time.now.toISOString(), time)}</span>
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-accent-solid" />
    </p>
  );
}

interface EventRowProps {
  event: CalendarEventWire;
  time: TimeContext;
  conflict: boolean;
}

function EventRow({ event, time, conflict }: EventRowProps) {
  const { t } = useT();
  const phase = eventPhase(event, time.now);
  const past = phase === "past";
  const color = eventBarColor(event.color);
  const provider = eventSourceProvider(event.provider);
  const source = event.sourceLabel ?? t("today.calendar.primary");
  return (
    <Link
      href={`${CALENDAR_HREF}/${event.id}`}
      className="focus-ring -mx-3 flex min-h-13 items-stretch gap-3 rounded-card px-3 py-2 transition-colors duration-120 ease-fluid hover:bg-surface-hover max-md:min-h-16"
    >
      <span
        className={`flex w-16 shrink-0 flex-col items-end text-caption tabular-nums ${past ? "text-ink-muted" : "text-ink-soft"}`}
      >
        {event.allDay ? (
          <span>{t("today.calendar.allDay")}</span>
        ) : (
          <>
            <time dateTime={event.startTime} className={past ? "" : "font-medium text-ink"}>
              {clock(event.startTime, time)}
            </time>
            <time dateTime={event.endTime} className="text-ink-muted">
              {clock(event.endTime, time)}
            </time>
          </>
        )}
      </span>
      <span
        aria-hidden="true"
        className={`w-[3px] shrink-0 rounded-full ${color ? "" : "bg-line-strong"}`}
        style={color ? { backgroundColor: color } : undefined}
      />
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className={`min-w-0 truncate text-label ${past ? "text-ink-muted" : "text-ink"}`}>
            {event.title || t("today.calendar.untitled")}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-caption text-ink-muted">
          {provider && <SourceBadge provider={provider} />}
          <span className="min-w-0 truncate">
            {event.location ? `${source} · ${event.location}` : source}
          </span>
        </span>
        {conflict && (
          <span className="flex items-center gap-1 text-caption font-medium text-state-warn-ink">
            <OverlapGlyph />
            {t("today.calendar.conflict")}
          </span>
        )}
      </span>
    </Link>
  );
}

function OverlapGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 2.5 14 13H2L8 2.5Z" />
      <path d="M8 6.5v3" />
      <path d="M8 11.4v.1" />
    </svg>
  );
}
