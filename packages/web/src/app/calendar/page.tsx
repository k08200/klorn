"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { CompactMonth } from "../../components/calendar/compact-month";
import {
  addMonths,
  buildMonthCells,
  type CalendarEvent,
  dayKeyForInZone,
  firstOfMonth,
  formatTime,
  type MonthCell,
  monthGridRange,
  monthIndexInZone,
  weekdayNames,
} from "../../components/calendar/month-utils";
import { LinkedCalendars } from "../../components/linked-calendars";
import { type NewEventInitial, NewEventModal } from "../../components/new-event-modal";
import { PAGE_SHELL } from "../../components/page-shell";
import ErrorAlert from "../../components/ui/error-alert";
import VoiceButton from "../../components/voice-button";
import { apiFetch, startGoogleConnect } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";
import { useDisplayTimeZone } from "../../lib/use-time-zone";

export default function CalendarPage() {
  return (
    <AuthGuard>
      <CalendarView />
    </AuthGuard>
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Parsed ISO timestamps → the dialog's local date/time input values. */
function isoToInitial(event: {
  title: string;
  startTime: string;
  endTime: string;
  location?: string;
}): NewEventInitial {
  const start = new Date(event.startTime);
  const end = new Date(event.endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { title: event.title, location: event.location };
  }
  return {
    title: event.title,
    date: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`,
    startTime: `${pad2(start.getHours())}:${pad2(start.getMinutes())}`,
    endTime: `${pad2(end.getHours())}:${pad2(end.getMinutes())}`,
    location: event.location,
  };
}

function CalendarView() {
  const { t, locale } = useT();
  const queryClient = useQueryClient();
  // Pinned zone > device zone (Automatic) > account zone > UTC; see
  // lib/time-zone.ts. Never the bare browser default inside formatters.
  const userTimezone = useDisplayTimeZone();
  const [error, setError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [newEventOpen, setNewEventOpen] = useState(false);
  // Voice-parsed prefill for the New event dialog; null = plain defaults.
  const [voiceInitial, setVoiceInitial] = useState<NewEventInitial | null>(null);
  const [voiceParsing, setVoiceParsing] = useState(false);
  // Staleness guard: any manual open/close of the dialog (or a newer mic
  // request) bumps this, so an in-flight parse can never clobber what the
  // user is doing or reopen a dialog they dismissed.
  const voiceRequestRef = useRef(0);

  const invalidateVoiceRequests = () => {
    voiceRequestRef.current++;
    setVoiceParsing(false);
  };

  // Speak → parse → open the New event dialog prefilled. The dialog IS the
  // confirm card; parse failure still opens it empty so speech never dead-ends.
  const handleVoiceTranscript = async (text: string) => {
    const requestId = ++voiceRequestRef.current;
    setVoiceParsing(true);
    let initial: NewEventInitial = { title: text };
    try {
      const { event } = await apiFetch<{
        event: { title: string; startTime: string; endTime: string; location?: string } | null;
      }>("/api/calendar/parse-event", { method: "POST", body: JSON.stringify({ text }) });
      if (event) initial = isoToInitial(event);
    } catch (err) {
      console.error("[CALENDAR] voice parse failed:", err);
      captureClientError(err);
    }
    if (voiceRequestRef.current !== requestId) return; // superseded by user action
    setVoiceParsing(false);
    setVoiceInitial(initial);
    setNewEventOpen(true);
  };
  const [googleConnected, setGoogleConnected] = useState<boolean | null>(null);
  // Month being viewed. Stored as a Date pinned to day 1 in user TZ so
  // prev/next navigation never falls into adjacent-month corners when
  // we add or subtract a month at the end of the calendar.
  const [viewMonth, setViewMonth] = useState<Date>(() => firstOfMonth(new Date(), userTimezone));

  // Range fetched = the visible 6×7 grid, which can spill into adjacent
  // months. Use the grid's anchor cells so events in the prev/next month
  // padding rows are loaded too.
  const gridRange = monthGridRange(viewMonth, userTimezone);
  const {
    data: events = [],
    isLoading: loading,
    error: eventsError,
  } = useQuery({
    queryKey: queryKeys.calendar.events({
      from: gridRange.start.toISOString(),
      to: gridRange.end.toISOString(),
    }),
    queryFn: async () => {
      const url = `/api/calendar?start=${encodeURIComponent(
        gridRange.start.toISOString(),
      )}&end=${encodeURIComponent(gridRange.end.toISOString())}`;
      const data = await apiFetch<{ events: CalendarEvent[] }>(url);
      return Array.isArray(data.events) ? data.events : [];
    },
  });

  useEffect(() => {
    if (eventsError) {
      captureClientError(eventsError, { scope: "calendar.load" });
      setError(t("calendar.error.load"));
    }
  }, [eventsError]);

  useEffect(() => {
    apiFetch<{ connected: boolean }>("/api/auth/google/status")
      .then((data) => setGoogleConnected(data.connected))
      .catch((err) => {
        captureClientError(err, { scope: "calendar.google-status" });
        setGoogleConnected(false);
      });
  }, []);

  const syncMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success?: boolean; synced?: number; error?: string }>("/api/calendar/sync", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onMutate: () => {
      setError(null);
      setSyncMessage(null);
    },
    onSuccess: (result) => {
      if (result.error) {
        if (result.error.toLowerCase().includes("google not connected")) {
          setGoogleConnected(false);
        }
        setError(result.error);
        return;
      }
      const synced = result.synced ?? 0;
      setGoogleConnected(true);
      setSyncMessage(
        synced > 0
          ? t("calendar.sync.imported", { count: String(synced) })
          : t("calendar.sync.empty"),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.calendar.all });
    },
    onError: (err) => {
      captureClientError(err, { scope: "calendar.sync" });
      setError(t("calendar.error.sync"));
    },
  });

  const syncing = syncMutation.isPending;
  const syncNow = () => syncMutation.mutate();

  const todayKey = dayKeyForInZone(new Date(), userTimezone);
  const nextEvent = events
    .map((event) => ({ event, start: new Date(event.startTime) }))
    .filter(({ start }) => start.getTime() >= Date.now())
    .sort((a, b) => a.start.getTime() - b.start.getTime())[0]?.event;

  // Group events by local day key (in user's timezone) so the grid cell
  // lookup is O(1) per cell.
  const eventsByDay = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const key = dayKeyForInZone(new Date(ev.startTime), userTimezone);
    const list = eventsByDay.get(key);
    if (list) list.push(ev);
    else eventsByDay.set(key, [ev]);
  }
  // Per-day, sort by start time so chips display in chronological order
  // within each cell.
  for (const list of eventsByDay.values()) {
    list.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  }

  const monthLabel = viewMonth.toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
    timeZone: userTimezone,
  });
  const goPrevMonth = () => setViewMonth(addMonths(viewMonth, -1, userTimezone));
  const goNextMonth = () => setViewMonth(addMonths(viewMonth, 1, userTimezone));
  const goToday = () => setViewMonth(firstOfMonth(new Date(), userTimezone));

  return (
    <div className={PAGE_SHELL}>
      {/* MOBILE — native large-title header (desktop hero below, untouched) */}
      <header className="mb-5 flex items-end justify-between gap-3 md:hidden">
        <div className="min-w-0">
          <h1 className="text-role-page text-ink">{t("nav.calendar")}</h1>
          <p className="mt-1.5 truncate text-role-body text-ink-mid">
            {nextEvent
              ? t("calendar.nextLabel", { title: nextEvent.title || t("common.untitled") })
              : t("calendar.next14Days")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <VoiceButton
            onTranscript={(text) => void handleVoiceTranscript(text)}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-line"
          />
          <button
            type="button"
            onClick={() => {
              invalidateVoiceRequests();
              setVoiceInitial(null);
              setNewEventOpen(true);
            }}
            aria-label={t("calendar.newEvent")}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-solid text-accent-solid-ink transition active:bg-accent-solid-hover"
          >
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing}
            aria-label={t("calendar.sync")}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-raised text-ink-mid transition active:bg-surface-hover disabled:opacity-50"
          >
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={syncing ? "animate-spin" : ""}
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
          </button>
        </div>
      </header>

      {/* DESKTOP — flat text header on the canvas, no boxed hero. New event is
          the single filled primary action; Voice and Sync collapse to quiet
          icon buttons and the subtitle carries the honest counts. */}
      <header className="mb-6 hidden items-start justify-between gap-4 md:flex">
        <div className="min-w-0">
          <h1 className="text-role-page text-ink">{t("nav.calendar")}</h1>
          <p className="mt-2 truncate text-role-body text-ink-mid">
            {nextEvent ? (
              <>
                {t("calendar.next")}{" "}
                <span className="font-medium text-ink-soft">
                  {nextEvent.title || t("common.untitled")}
                </span>{" "}
                <span className="mx-0.5 text-slate-300">·</span>{" "}
                {formatTime(new Date(nextEvent.startTime), userTimezone, locale)}
              </>
            ) : (
              t("calendar.nothingComingUp")
            )}
            {events.length > 0 && (
              <span className="text-ink-dim">
                {" "}
                <span className="mx-0.5 text-slate-300">·</span>{" "}
                {t("calendar.thisMonth", { count: String(events.length) })}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              invalidateVoiceRequests();
              setVoiceInitial(null);
              setNewEventOpen(true);
            }}
            className="glow-primary ease-strong inline-flex h-9 pointer-coarse:h-11 items-center gap-1.5 rounded-control bg-accent-solid px-3.5 text-role-label text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97]"
          >
            <svg
              aria-hidden="true"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t("calendar.newEvent")}
          </button>
          <VoiceButton
            onTranscript={(text) => void handleVoiceTranscript(text)}
            className="ease-strong inline-flex h-9 w-9 pointer-coarse:h-11 pointer-coarse:w-11 items-center justify-center rounded-control border border-line bg-surface-panel/70 text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97]"
          />
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing}
            aria-label={syncing ? t("common.syncing") : t("common.syncNow")}
            title={t("common.syncNow")}
            className="ease-strong inline-flex h-9 w-9 pointer-coarse:h-11 pointer-coarse:w-11 items-center justify-center rounded-control border border-line bg-surface-panel/70 text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] disabled:opacity-50"
          >
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={syncing ? "animate-spin" : undefined}
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        </div>
      </header>

      <div className="mb-6">
        <Suspense fallback={null}>
          <LinkedCalendars />
        </Suspense>
      </div>

      {loading && (
        <div className="rounded-card border border-line bg-surface-panel px-4 py-5 text-center text-role-body text-ink-dim">
          {t("calendar.gathering")}
        </div>
      )}

      {error && <ErrorAlert className="mb-4">{error}</ErrorAlert>}

      {syncMessage && !error && (
        <div className="mb-4 rounded-control border border-state-ok-line bg-state-ok-bg px-4 py-3 text-role-body text-state-ok-ink">
          {syncMessage}
        </div>
      )}

      {!loading && !error && events.length === 0 && (
        <div className="panel-elevated rounded-card border border-line/70 bg-surface-panel p-6 text-center">
          <p className="mb-1 text-role-body text-ink-mid">
            {googleConnected === false
              ? t("calendar.empty.notConnected")
              : t("calendar.empty.noEvents")}
          </p>
          <p className="mb-4 text-role-caption text-ink-dim">
            {googleConnected === false
              ? t("calendar.empty.notConnectedBody")
              : t("calendar.empty.noEventsBody")}
          </p>
          {googleConnected === false ? (
            <button
              type="button"
              onClick={() => {
                void startGoogleConnect();
              }}
              className="ease-strong inline-flex min-h-11 items-center rounded-control border border-line bg-surface-panel/70 px-4 py-2 text-role-label text-ink-muted shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97]"
            >
              {t("mail.connectGoogle")}
            </button>
          ) : (
            <button
              type="button"
              onClick={syncNow}
              disabled={syncing}
              className="ease-strong min-h-11 rounded-control border border-line bg-surface-panel/70 px-4 py-2 text-role-label text-ink-muted shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] disabled:opacity-50"
            >
              {syncing ? t("common.syncing") : t("calendar.syncAgain")}
            </button>
          )}
        </div>
      )}

      {/* The desktop month grid puts ~20px event links in each cell — too small
          for touch (44px rule), and 44px links would overflow the cells. On a
          coarse pointer, or when the calendar is under 600px wide, the compact
          month takes over: 44px day buttons with dots, and the selected day's
          events listed below (founder decision, option A). A fine pointer on
          a wide screen keeps the grid unchanged. Pure CSS switching, so there
          is no layout flash on load. */}
      {!loading && (
        <div className="@container">
          <div className="block @max-[600px]:hidden pointer-coarse:hidden">
            <MonthGrid
              viewMonth={viewMonth}
              monthLabel={monthLabel}
              onPrev={goPrevMonth}
              onNext={goNextMonth}
              onToday={goToday}
              eventsByDay={eventsByDay}
              todayKey={todayKey}
              timeZone={userTimezone}
            />
          </div>
          <div className="hidden @max-[600px]:block pointer-coarse:block">
            <CompactMonth
              viewMonth={viewMonth}
              monthLabel={monthLabel}
              onPrev={goPrevMonth}
              onNext={goNextMonth}
              onToday={goToday}
              eventsByDay={eventsByDay}
              todayKey={todayKey}
              timeZone={userTimezone}
            />
          </div>
        </div>
      )}

      <NewEventModal
        open={newEventOpen}
        initial={voiceInitial}
        onClose={() => {
          invalidateVoiceRequests();
          setNewEventOpen(false);
          setVoiceInitial(null);
        }}
        onCreated={(title) => {
          setSyncMessage(t("calendar.created", { title }));
          void queryClient.invalidateQueries({ queryKey: queryKeys.calendar.all });
        }}
      />
      {voiceParsing && (
        <output className="fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-full border border-line bg-surface-raised px-4 py-2 text-role-caption text-ink shadow-lg rail:bottom-8">
          {t("calendar.voiceParsing")}
        </output>
      )}
    </div>
  );
}

function MonthGrid({
  viewMonth,
  monthLabel,
  onPrev,
  onNext,
  onToday,
  eventsByDay,
  todayKey,
  timeZone,
}: {
  viewMonth: Date;
  monthLabel: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  eventsByDay: Map<string, CalendarEvent[]>;
  todayKey: string;
  timeZone: string;
}) {
  const { t, locale } = useT();
  const cells = buildMonthCells(viewMonth, timeZone);
  // Weekday header — Sun..Sat matches Google Calendar's default in Korea.
  // Named in the UI language (was a fixed English list, so ko showed Sun..Sat).
  const weekdayLabels = weekdayNames(locale);
  const viewMonthIdx = monthIndexInZone(viewMonth, timeZone);

  return (
    <div className="panel-elevated overflow-hidden rounded-card border border-line/70 bg-surface-panel">
      <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPrev}
            aria-label={t("calendar.prevMonth")}
            className="ease-strong flex h-11 w-11 items-center justify-center rounded-control text-ink-mid transition duration-150 hover:bg-surface-hover hover:text-ink active:scale-[0.97]"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={onNext}
            aria-label={t("calendar.nextMonth")}
            className="ease-strong flex h-11 w-11 items-center justify-center rounded-control text-ink-mid transition duration-150 hover:bg-surface-hover hover:text-ink active:scale-[0.97]"
          >
            ›
          </button>
          <h2 className="ml-1 text-role-head tracking-[-0.01em] text-ink">{monthLabel}</h2>
        </div>
        <button
          type="button"
          onClick={onToday}
          className="ease-strong rounded-control border border-line bg-surface-panel/70 px-3 py-1 pointer-coarse:min-h-11 text-role-caption font-medium text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97]"
        >
          {t("nav.v2.today")}
        </button>
      </div>
      <div className="grid grid-cols-7 border-b border-line-soft bg-surface-panel">
        {weekdayLabels.map((d) => (
          <div
            key={d}
            className="px-2 py-1.5 text-center text-role-caption font-medium uppercase tracking-[0.12em] text-ink-dim"
          >
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((cell) => {
          const events = eventsByDay.get(cell.key) ?? [];
          const inMonth = cell.monthIndex === viewMonthIdx;
          const isToday = cell.key === todayKey;
          return (
            <DayCell
              key={cell.key}
              cell={cell}
              events={events}
              inMonth={inMonth}
              isToday={isToday}
              timeZone={timeZone}
            />
          );
        })}
      </div>
    </div>
  );
}

function DayCell({
  cell,
  events,
  inMonth,
  isToday,
  timeZone,
}: {
  cell: MonthCell;
  events: CalendarEvent[];
  inMonth: boolean;
  isToday: boolean;
  timeZone: string;
}) {
  const { t, locale } = useT();
  // Show up to 3 chips per cell; collapse the rest into a "+N more" link
  // that drops the user into the first hidden event's day (proxy until we
  // wire a day modal).
  const MAX_VISIBLE = 3;
  const visible = events.slice(0, MAX_VISIBLE);
  const hidden = events.length - visible.length;
  const router = useRouter();

  // The date number is a focusable day trigger: it opens the day (its first
  // event) as a proxy day-view, so the cell is reachable by keyboard — the
  // event chips were previously the ONLY interactive targets in a cell.
  // cell.key is YYYY-MM-DD; anchor at noon UTC so the label doesn't slip a day
  // across timezone offsets (matches the noon-UTC convention used elsewhere).
  const dayLabel = new Date(`${cell.key}T12:00:00Z`).toLocaleDateString(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone,
  });
  const openDay = () => {
    if (events.length > 0) router.push(`/calendar/${events[0].id}`);
  };
  const dayNumberClass = `inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-role-caption font-medium tabular-nums transition ${
    isToday ? "bg-accent-solid text-accent-solid-ink" : inMonth ? "text-ink-muted" : "text-ink-dim"
  }`;

  return (
    <div
      className={`min-h-[96px] border-b border-r border-line-soft px-1.5 py-1 transition ${
        inMonth ? "bg-surface-panel" : "bg-surface-raised/40"
      }`}
    >
      <div className="mb-1 flex items-center justify-between">
        {events.length > 0 ? (
          <button
            type="button"
            onClick={openDay}
            aria-label={`${dayLabel} — ${events.length} event${events.length === 1 ? "" : "s"}`}
            // On touch the 24px number keeps its look but takes a 44px hit area.
            className={`${dayNumberClass} relative hover:ring-1 hover:ring-accent-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 pointer-coarse:after:content-['']`}
          >
            {cell.dayNumber}
          </button>
        ) : (
          <span className={dayNumberClass}>{cell.dayNumber}</span>
        )}
      </div>
      <div className="space-y-0.5">
        {visible.map((ev) => (
          <EventChip key={ev.id} event={ev} timeZone={timeZone} dimmed={!inMonth} />
        ))}
        {hidden > 0 && (
          <Link
            href={`/calendar/${events[MAX_VISIBLE].id}`}
            className="block truncate px-1 text-role-caption text-ink-dim hover:text-accent-deep"
          >
            {t("calendar.more", { count: String(hidden) })}
          </Link>
        )}
      </div>
    </div>
  );
}

function EventChip({
  event,
  timeZone,
  dimmed,
}: {
  event: CalendarEvent;
  timeZone: string;
  dimmed: boolean;
}) {
  const { t, locale } = useT();
  const start = new Date(event.startTime);
  const timeLabel = event.allDay ? "" : formatTime(start, timeZone, locale);
  return (
    <Link
      href={`/calendar/${event.id}`}
      title={`${timeLabel ? `${timeLabel} · ` : ""}${event.title || "Untitled"}`}
      className={`flex items-center gap-1 truncate rounded-chip px-1 py-0.5 text-role-caption transition duration-150 ${
        dimmed
          ? "text-ink-dim hover:bg-surface-hover hover:text-ink-mid"
          : "text-ink hover:bg-accent/10 hover:text-accent-deeper"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${dimmed ? "bg-slate-300" : "bg-accent-light"}`}
      />
      {timeLabel && <span className="shrink-0 tabular-nums text-ink-dim">{timeLabel}</span>}
      <span className="truncate">{event.title || t("common.untitled")}</span>
    </Link>
  );
}
