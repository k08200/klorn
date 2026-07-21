"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { EveSignalField } from "../../components/brand-visuals";
import { LinkedCalendars } from "../../components/linked-calendars";
import { type NewEventInitial, NewEventModal } from "../../components/new-event-modal";
import VoiceButton from "../../components/voice-button";
import { apiFetch, startGoogleConnect } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";

interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  startTime: string;
  endTime: string;
  location: string | null;
  meetingLink: string | null;
  allDay: boolean;
}

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
  const { t } = useT();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  // Always have a deterministic IANA zone in hand — never rely on browser
  // default (iOS PWA has been observed to fall back to UTC).
  const userTimezone = user?.timezone ?? "Asia/Seoul";
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
  const [viewMonth, setViewMonth] = useState<Date>(() => firstOfMonth(new Date(), "Asia/Seoul"));

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
      setError("Could not load calendar events.");
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
          ? `Imported ${synced} events from Google Calendar.`
          : "Google Calendar is synced. No events in the next 14 days.",
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.calendar.all });
    },
    onError: (err) => {
      captureClientError(err, { scope: "calendar.sync" });
      setError("Could not sync Google Calendar.");
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

  const monthLabel = viewMonth.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: userTimezone,
  });
  const goPrevMonth = () => setViewMonth(addMonths(viewMonth, -1, userTimezone));
  const goNextMonth = () => setViewMonth(addMonths(viewMonth, 1, userTimezone));
  const goToday = () => setViewMonth(firstOfMonth(new Date(), userTimezone));

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-3 md:py-10">
      {/* MOBILE — native large-title header (desktop hero below, untouched) */}
      <header className="mb-5 flex items-end justify-between gap-3 md:hidden">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-none tracking-tight text-slate-900">
            {t("nav.calendar")}
          </h1>
          <p className="mt-1.5 truncate text-sm text-slate-500">
            {nextEvent ? `Next: ${nextEvent.title || "Untitled"}` : "Your next 14 days"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <VoiceButton
            onTranscript={(text) => void handleVoiceTranscript(text)}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200"
          />
          <button
            type="button"
            onClick={() => {
              invalidateVoiceRequests();
              setVoiceInitial(null);
              setNewEventOpen(true);
            }}
            aria-label="New event"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-stone-950 transition active:bg-accent/90"
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
            aria-label="Sync calendar"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-50 text-slate-500 transition active:bg-slate-100 disabled:opacity-50"
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

      {/* DESKTOP — unchanged */}
      <header className="mb-6 hidden overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl shadow-black/10 md:block">
        <div className="h-1 bg-gradient-to-r from-sky-300 via-sky-200/40 to-transparent" />
        <div className="p-5 md:p-6">
          {/* Mobile = content-first: the decorative work-signal panel and the
              3-stat dashboard are hidden below their breakpoints so the month
              shows sooner. A compact Sync replaces the panel's Sync on phones. */}
          <div className="grid gap-5 lg:grid-cols-[1fr_300px] lg:items-stretch">
            <div className="min-w-0">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-600 md:mb-2">
                Klorn · Calendar
              </p>
              <div className="flex items-start justify-between gap-3">
                <h1 className="text-lg font-semibold tracking-tight text-slate-900 md:text-2xl">
                  {t("calendar.needPrep")}
                </h1>
                {/* One button pair for every breakpoint, anchored to the title
                    row. (They used to be absolutely positioned over the signal
                    panel on lg+, which covered the WORK SIGNALS header.) */}
                <div className="flex shrink-0 items-center gap-2">
                  <VoiceButton
                    onTranscript={(text) => void handleVoiceTranscript(text)}
                    className="flex min-h-9 w-9 items-center justify-center rounded-md border border-slate-200"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      invalidateVoiceRequests();
                      setVoiceInitial(null);
                      setNewEventOpen(true);
                    }}
                    className="min-h-9 rounded-md bg-accent px-3 text-xs font-semibold text-stone-950 transition hover:bg-accent/90"
                  >
                    {t("calendar.newEvent")}
                  </button>
                  <button
                    type="button"
                    onClick={syncNow}
                    disabled={syncing}
                    className="min-h-9 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-500 transition hover:bg-slate-100 disabled:opacity-50"
                  >
                    {syncing ? t("common.syncing") : t("common.syncNow")}
                  </button>
                </div>
              </div>
              <p className="mt-2 hidden max-w-xl text-sm leading-6 text-slate-500 md:block">
                The next 14 days of events alongside the work signals that touch them.
              </p>
            </div>
            <div className="relative hidden min-h-40 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 lg:block">
              <EveSignalField className="absolute inset-0 border-0" />
            </div>
          </div>
          <div className="mt-5 hidden grid-cols-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 md:grid">
            <CalendarStat label="Month" value={events.length} />
            <CalendarStat label="Today" value={eventsByDay.get(todayKey)?.length ?? 0} />
            <CalendarStat
              label="Next"
              value={nextEvent ? formatTime(new Date(nextEvent.startTime), userTimezone) : "-"}
            />
          </div>
          {nextEvent && (
            <div className="mt-4 rounded-lg border border-sky-300/15 bg-sky-300/5 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-600">
                Next prep target
              </p>
              <p className="mt-1 truncate text-sm font-medium text-slate-900">
                {nextEvent.title || "Untitled"}
              </p>
            </div>
          )}
        </div>
      </header>

      <div className="mb-6">
        <Suspense fallback={null}>
          <LinkedCalendars />
        </Suspense>
      </div>

      {loading && (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-5 text-center text-sm text-slate-400">
          Gathering calendar context...
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {syncMessage && !error && (
        <div className="mb-4 rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-4 py-3 text-sm text-emerald-200">
          {syncMessage}
        </div>
      )}

      {!loading && !error && events.length === 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-center">
          <p className="mb-1 text-sm text-slate-500">
            {googleConnected === false
              ? "Google Calendar is not connected yet."
              : "No events in the next 14 days."}
          </p>
          <p className="mb-4 text-xs text-slate-400">
            {googleConnected === false
              ? "Connect and sync so Klorn can brief from your real calendar."
              : "Google is connected. An empty calendar stays empty in the briefing."}
          </p>
          {googleConnected === false ? (
            <button
              type="button"
              onClick={() => {
                void startGoogleConnect();
              }}
              className="inline-flex min-h-11 items-center rounded-lg bg-sky-500 px-4 py-2 text-sm text-stone-950 transition hover:bg-sky-200"
            >
              Connect Google
            </button>
          ) : (
            <button
              type="button"
              onClick={syncNow}
              disabled={syncing}
              className="min-h-11 rounded-lg bg-sky-500 px-4 py-2 text-sm text-stone-950 transition hover:bg-sky-200 disabled:opacity-50"
            >
              {syncing ? "Syncing..." : "Sync again"}
            </button>
          )}
        </div>
      )}

      {/* A 6×7 month grid is unreadable at ~56px/column on a phone (event times
          clip to "00:3"). Desktop keeps the grid; mobile gets a forward-looking
          agenda list grouped by day, which matches the hero's "next 14 days". */}
      {!loading && (
        <>
          <div className="hidden md:block">
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
          {events.length > 0 && (
            <div className="md:hidden">
              <AgendaList events={events} todayKey={todayKey} timeZone={userTimezone} />
            </div>
          )}
        </>
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
          setSyncMessage(`"${title}" created in your Google Calendar.`);
          void queryClient.invalidateQueries({ queryKey: queryKeys.calendar.all });
        }}
      />
      {voiceParsing && (
        <output className="fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-900 shadow-lg md:bottom-8">
          {t("calendar.voiceParsing")}
        </output>
      )}
    </div>
  );
}

function AgendaList({
  events,
  todayKey,
  timeZone,
}: {
  events: CalendarEvent[];
  todayKey: string;
  timeZone: string;
}) {
  // Group upcoming events (today onward) by local day, ascending. Past days are
  // dropped — an agenda is forward-looking, unlike the month grid.
  const byDay = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const key = dayKeyForInZone(new Date(ev.startTime), timeZone);
    if (key < todayKey) continue;
    const list = byDay.get(key);
    if (list) list.push(ev);
    else byDay.set(key, [ev]);
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [, list] of days) {
    list.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  }

  if (days.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">
        Nothing coming up this month.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {days.map(([key, list]) => (
        <div key={key}>
          <div className="mb-1.5 flex items-center gap-2 px-0.5">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
              {new Date(list[0].startTime).toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                timeZone,
              })}
            </h3>
            {key === todayKey && (
              <span className="rounded-full bg-sky-500 px-2 py-0.5 text-[10px] font-semibold text-stone-950">
                Today
              </span>
            )}
          </div>
          <ul className="space-y-1.5">
            {list.map((ev) => (
              <li key={ev.id}>
                <Link
                  href={`/calendar/${ev.id}`}
                  className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 transition hover:bg-slate-100"
                >
                  <span className="w-14 shrink-0 pt-0.5 text-right text-xs tabular-nums text-slate-500">
                    {ev.allDay ? "All day" : formatTime(new Date(ev.startTime), timeZone)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900">
                      {ev.title || "Untitled"}
                    </span>
                    {ev.location && (
                      <span className="mt-0.5 block truncate text-[11px] text-slate-400">
                        {ev.location}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
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
  const cells = buildMonthCells(viewMonth, timeZone);
  // Weekday header — Sun..Sat matches Google Calendar's default in Korea.
  // Locale "en-US" gives short names regardless of the user's browser locale.
  const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const viewMonthIdx = monthIndexInZone(viewMonth, timeZone);

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPrev}
            aria-label="Previous month"
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={onNext}
            aria-label="Next month"
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
          >
            ›
          </button>
          <h2 className="ml-1 text-base font-medium text-slate-900">{monthLabel}</h2>
        </div>
        <button
          type="button"
          onClick={onToday}
          className="rounded-md border border-slate-200 px-3 py-1 text-xs text-slate-500 transition hover:border-sky-500/40 hover:bg-sky-500/10 hover:text-sky-100"
        >
          Today
        </button>
      </div>
      <div className="grid grid-cols-7 border-b border-slate-200 bg-white">
        {weekdayLabels.map((d) => (
          <div
            key={d}
            className="px-2 py-1.5 text-center text-[11px] font-medium uppercase tracking-[0.12em] text-slate-400"
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
  const dayLabel = new Date(`${cell.key}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone,
  });
  const openDay = () => {
    if (events.length > 0) router.push(`/calendar/${events[0].id}`);
  };
  const dayNumberClass = `inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[11px] font-medium tabular-nums transition ${
    isToday ? "bg-sky-500 text-white" : inMonth ? "text-slate-500" : "text-slate-500"
  }`;

  return (
    <div
      className={`min-h-[96px] border-b border-r border-slate-200 px-1.5 py-1 transition ${
        inMonth ? "bg-white" : "bg-white text-slate-500"
      }`}
    >
      <div className="mb-1 flex items-center justify-between">
        {events.length > 0 ? (
          <button
            type="button"
            onClick={openDay}
            aria-label={`${dayLabel} — ${events.length} event${events.length === 1 ? "" : "s"}`}
            className={`${dayNumberClass} hover:ring-1 hover:ring-sky-300/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
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
            className="block truncate px-1 text-[10px] text-slate-400 hover:text-sky-600"
          >
            +{hidden} more
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
  const start = new Date(event.startTime);
  const timeLabel = event.allDay ? "" : formatTime(start, timeZone);
  return (
    <Link
      href={`/calendar/${event.id}`}
      title={`${timeLabel ? `${timeLabel} · ` : ""}${event.title || "Untitled"}`}
      className={`flex items-center gap-1 truncate rounded px-1 py-0.5 text-[11px] transition ${
        dimmed
          ? "text-slate-500 hover:bg-slate-100 hover:text-slate-500"
          : "text-slate-900 hover:bg-sky-500/10 hover:text-sky-100"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${dimmed ? "bg-slate-100" : "bg-sky-500"}`}
      />
      {timeLabel && <span className="shrink-0 tabular-nums text-slate-400">{timeLabel}</span>}
      <span className="truncate">{event.title || "Untitled"}</span>
    </Link>
  );
}

function CalendarStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="border-r border-slate-200 px-4 py-3 last:border-r-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {label}
      </p>
      <p className="mt-1 truncate text-2xl font-semibold text-slate-900">{value}</p>
    </div>
  );
}

// 24-hour format keeps "13:00" unambiguous (the AM/PM split has been a
// dogfood pain point — "04:00 AM" in the calendar looked like 4 in the
// morning when the underlying event was 13:00 KST). The timezone arg is
// the user's stored IANA zone, NOT the browser default.
function formatTime(d: Date, timeZone: string): string {
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
}

// Day grouping must also respect the user's timezone — otherwise an event
// at 23:30 KST stored as 14:30 UTC ends up grouped under the wrong local
// day (the browser would call it "today" while the user calls it "tomorrow").
function dayKeyForInZone(d: Date, timeZone: string): string {
  // en-CA returns YYYY-MM-DD, which is exactly the key shape we want and is
  // stable across locales.
  return d.toLocaleDateString("en-CA", { timeZone });
}

// ─── Month grid helpers ──────────────────────────────────────────────────
//
// All date math respects the user's IANA timezone so cell boundaries match
// what the user calls "Monday" — not what the browser calls "Monday" based
// on its locale guess.

interface MonthCell {
  /** YYYY-MM-DD in the user's timezone — used as map key for events. */
  key: string;
  /** 1..31 — day number to display. */
  dayNumber: number;
  /** 0=Jan..11=Dec — index of the month this cell belongs to. */
  monthIndex: number;
}

/** Pinned first-of-month at 00:00 in the given timezone. */
function firstOfMonth(d: Date, timeZone: string): Date {
  // Use ISO date-parts in the user's timezone, then construct a UTC moment
  // that represents 00:00 of that local day. This is the only safe way to
  // round-trip "month start" without lying about offsets.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  // Construct YYYY-MM-01 at noon UTC — noon avoids DST edges that 00:00
  // can land on for some zones.
  return new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));
}

/** Add N months (can be negative). Day pinned to 1. */
function addMonths(d: Date, n: number, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const totalMonths = (year - 1970) * 12 + (month - 1) + n;
  const newYear = 1970 + Math.floor(totalMonths / 12);
  const newMonth = totalMonths - (newYear - 1970) * 12;
  return new Date(Date.UTC(newYear, newMonth, 1, 12, 0, 0));
}

/** Month index 0..11 in the given timezone for a date. */
function monthIndexInZone(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    month: "2-digit",
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === "month")?.value) - 1;
}

/** Sunday-first weekday index 0..6 in the given timezone for a date. */
function weekdayInZone(d: Date, timeZone: string): number {
  // Intl gives short names; map Sun..Sat to 0..6.
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(d);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[wd] ?? 0;
}

/** Build the 42-cell month grid (6 rows × 7 days) including leading/trailing
 * padding from the adjacent months — same behavior as Google Calendar. */
function buildMonthCells(viewMonth: Date, timeZone: string): MonthCell[] {
  const monthStart = firstOfMonth(viewMonth, timeZone);
  const firstWeekday = weekdayInZone(monthStart, timeZone);
  // Anchor 12:00 UTC keeps DST jumps from skipping a day.
  const anchor = new Date(monthStart.getTime() - firstWeekday * 86400000);
  const cells: MonthCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(anchor.getTime() + i * 86400000);
    cells.push({
      key: dayKeyForInZone(d, timeZone),
      dayNumber: Number(new Intl.DateTimeFormat("en-CA", { timeZone, day: "2-digit" }).format(d)),
      monthIndex: monthIndexInZone(d, timeZone),
    });
  }
  return cells;
}

/** Range to fetch — first and last cell of the visible grid, expanded by
 * one day on each side so events overlapping the boundary aren't dropped. */
function monthGridRange(viewMonth: Date, timeZone: string): { start: Date; end: Date } {
  const cells = buildMonthCells(viewMonth, timeZone);
  // Cells are sorted; take ends and pad by 24h.
  const firstKey = cells[0].key;
  const lastKey = cells[cells.length - 1].key;
  // `key` is YYYY-MM-DD in user TZ — parse back via Date for the API range.
  // Use noon UTC so the range covers a full local day on both ends regardless
  // of DST.
  const start = new Date(`${firstKey}T00:00:00Z`);
  const end = new Date(`${lastKey}T23:59:59Z`);
  start.setUTCHours(start.getUTCHours() - 12);
  end.setUTCHours(end.getUTCHours() + 12);
  // Suppress no-unused-vars on timeZone — used by the helpers above; keeping
  // it in the signature so future callers don't need to import zone state.
  void timeZone;
  return { start, end };
}
