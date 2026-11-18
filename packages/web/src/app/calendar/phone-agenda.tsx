"use client";

/**
 * Calendar on a phone (mobile redesign PR5, MB1 "Editorial Brief"), below
 * 600px. The page opens on one day:
 *
 *   eyebrow   the day ("11월 18일 화요일") · its meetings, like Today's brief
 *   title     Calendar, with Voice / New event / Sync on the right
 *   nav       previous day · Today · next day (44px), and Agenda | Month
 *   agenda    the day's events: a time column, a 3px bar in the event's
 *             colour, the title, then the place or the meeting provider
 *
 * A row opens a bottom sheet with the details, Join (an https link only, via
 * safeMeetingHref) and a link to the full event page. Month keeps the compact
 * touch month (compact-month.tsx) one tap away. From 600px the page is as
 * before; the caller hides this below the rail step only.
 */

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { type CalendarEvent, formatTime } from "../../components/calendar/month-utils";
import Button from "../../components/ui/button";
import { Sheet } from "../../components/ui/sheet";
import { type ToggleChip, ToggleChips } from "../../components/ui/toggle-chips";
import { useT } from "../../lib/i18n";
import { safeMeetingHref } from "../../lib/meeting-link";
import { eventBarColor } from "../today/model";
import { dateForKey, dayAgenda, meetingProviderName, timedCount } from "./agenda-model";

export type PhoneCalendarView = "agenda" | "month";

/** The day in the user's language, e.g. "11월 18일 화요일" / "Wednesday, November 18". */
function longDay(key: string, locale: string): string {
  const date = dateForKey(key);
  if (!date) return key;
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

function ChevronGlyph({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={direction === "left" ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"} />
    </svg>
  );
}

interface PhoneDayHeaderProps {
  dayKey: string;
  /** The day's events; the eyebrow counts its timed ones. Null while loading. */
  events: readonly CalendarEvent[] | null;
  view: PhoneCalendarView;
  onViewChange: (view: PhoneCalendarView) => void;
  onShiftDay: (delta: number) => void;
  onToday: () => void;
  /** Voice, New event, Sync: the page's own compact actions. */
  actions: ReactNode;
}

export function PhoneDayHeader({
  dayKey,
  events,
  view,
  onViewChange,
  onShiftDay,
  onToday,
  actions,
}: PhoneDayHeaderProps) {
  const { t, locale } = useT();
  const meetings = events ? timedCount(events) : 0;
  const views: ReadonlyArray<ToggleChip<PhoneCalendarView>> = [
    { id: "agenda", content: t("calendar.phone.view.agenda") },
    { id: "month", content: t("calendar.phone.view.month") },
  ];
  return (
    <header className="mb-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            data-testid="calendar-day-eyebrow"
            className="text-role-meta font-medium uppercase tracking-[0.08em] text-ink-muted [word-break:keep-all]"
          >
            <time dateTime={dayKey}>{longDay(dayKey, locale)}</time>
            {meetings > 0 &&
              ` · ${t(meetings === 1 ? "today.brief.meetings.one" : "today.brief.meetings.many", {
                count: String(meetings),
              })}`}
          </p>
          <h1 className="mt-1 text-role-page text-ink">{t("nav.calendar")}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={t("calendar.phone.prevDay")}
          onClick={() => onShiftDay(-1)}
        >
          <ChevronGlyph direction="left" />
        </Button>
        <Button variant="ghost" className="min-h-11 px-3" onClick={onToday}>
          {t("nav.v2.today")}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={t("calendar.phone.nextDay")}
          onClick={() => onShiftDay(1)}
        >
          <ChevronGlyph direction="right" />
        </Button>
        <span className="flex-1" />
        <ToggleChips
          chips={views}
          value={view}
          onChange={onViewChange}
          label={t("calendar.phone.view.label")}
          className="shrink-0"
        />
      </div>
    </header>
  );
}

interface PhoneAgendaProps {
  dayKey: string;
  events: readonly CalendarEvent[];
  timeZone: string;
}

export function PhoneAgenda({ dayKey, events, timeZone }: PhoneAgendaProps) {
  const { t, locale } = useT();
  const [openId, setOpenId] = useState<string | null>(null);
  const ordered = dayAgenda(events);
  const opened = ordered.find((event) => event.id === openId) ?? null;
  return (
    <section
      data-testid="calendar-agenda"
      aria-label={t("calendar.phone.agendaLabel", { date: longDay(dayKey, locale) })}
    >
      {ordered.length === 0 ? (
        <p className="rounded-card bg-surface-raised px-4 py-6 text-center text-role-body text-ink-muted">
          {t("calendar.phone.empty")}
        </p>
      ) : (
        <ul className="flex flex-col">
          {ordered.map((event) => (
            <li key={event.id} className="border-b border-line-soft last:border-b-0">
              <AgendaRow event={event} timeZone={timeZone} onOpen={() => setOpenId(event.id)} />
            </li>
          ))}
        </ul>
      )}
      <EventSheet
        event={opened}
        dayKey={dayKey}
        timeZone={timeZone}
        onClose={() => setOpenId(null)}
      />
    </section>
  );
}

/** The place under the title: the location, else the meeting provider, else the linked account. */
function placeLine(event: CalendarEvent): string | null {
  const provider = meetingProviderName(safeMeetingHref(event.meetingLink));
  const parts = [event.location, provider].filter((part): part is string => Boolean(part));
  if (parts.length > 0) return parts.join(" · ");
  return event.sourceLabel ?? null;
}

function AgendaRow({
  event,
  timeZone,
  onOpen,
}: {
  event: CalendarEvent;
  timeZone: string;
  onOpen: () => void;
}) {
  const { t, locale } = useT();
  const color = eventBarColor(event.color);
  const place = placeLine(event);
  return (
    <Button
      variant="ghost"
      onClick={onOpen}
      aria-haspopup="dialog"
      className="-mx-3.5 w-[calc(100%+1.75rem)]"
    >
      <span className="flex min-h-14 w-full items-stretch gap-3 py-2.5 text-left">
        <span className="flex w-12 shrink-0 flex-col pt-0.5 text-role-meta tabular-nums">
          {event.allDay ? (
            <span className="text-ink-soft">{t("today.calendar.allDay")}</span>
          ) : (
            <>
              <time dateTime={event.startTime} className="font-medium text-ink">
                {formatTime(new Date(event.startTime), timeZone, locale)}
              </time>
              <time dateTime={event.endTime} className="text-ink-muted">
                {formatTime(new Date(event.endTime), timeZone, locale)}
              </time>
            </>
          )}
        </span>
        <span
          aria-hidden="true"
          data-testid="agenda-bar"
          className={`w-[3px] shrink-0 rounded-full ${color ? "" : "bg-accent-solid"}`}
          style={color ? { backgroundColor: color } : undefined}
        />
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <span className="truncate text-role-body font-semibold text-ink">
            {event.title || t("common.untitled")}
          </span>
          {place && <span className="truncate text-role-meta text-ink-muted">{place}</span>}
        </span>
      </span>
    </Button>
  );
}

function EventSheet({
  event,
  dayKey,
  timeZone,
  onClose,
}: {
  event: CalendarEvent | null;
  dayKey: string;
  timeZone: string;
  onClose: () => void;
}) {
  const { t, locale } = useT();
  // Keep the last event drawn while the sheet slides out.
  const [shown, setShown] = useState<CalendarEvent | null>(event);
  if (event && event !== shown) setShown(event);
  const current = event ?? shown;
  const join = safeMeetingHref(current?.meetingLink);
  const provider = meetingProviderName(join);
  const when = current
    ? current.allDay
      ? `${longDay(dayKey, locale)} · ${t("today.calendar.allDay")}`
      : `${longDay(dayKey, locale)} · ${formatTime(new Date(current.startTime), timeZone, locale)}–${formatTime(new Date(current.endTime), timeZone, locale)}`
    : "";
  return (
    <Sheet
      open={event !== null}
      onClose={onClose}
      title={current ? current.title || t("common.untitled") : ""}
      description={when}
      closeLabel={t("common.close")}
      handle
      footer={
        current && (
          <Link
            href={`/calendar/${current.id}`}
            className="focus-ring inline-flex min-h-11 items-center rounded-control px-3 text-role-label text-ink-soft transition-colors duration-120 ease-fluid hover:bg-surface-hover hover:text-ink"
          >
            {t("calendar.phone.openDetails")}
          </Link>
        )
      }
    >
      {current && (
        <div className="flex flex-col gap-4">
          {join && (
            <a
              href={join}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-accent-solid px-4 text-role-label font-semibold text-accent-solid-ink transition-colors duration-120 ease-fluid hover:bg-accent-solid-hover"
            >
              {t("calendar.phone.join")}
              {provider && <span className="font-normal opacity-90">· {provider}</span>}
            </a>
          )}
          {current.location && (
            <DetailLine label={t("calendar.phone.location")}>{current.location}</DetailLine>
          )}
          {current.sourceLabel && (
            <DetailLine label={t("calendar.phone.calendar")}>{current.sourceLabel}</DetailLine>
          )}
          {current.description && (
            <p className="line-clamp-6 whitespace-pre-line text-role-body text-ink-soft [overflow-wrap:anywhere]">
              {current.description}
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}

function DetailLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="flex flex-col gap-0.5">
      <span className="text-role-meta text-ink-muted">{label}</span>
      <span className="text-role-body text-ink [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}
