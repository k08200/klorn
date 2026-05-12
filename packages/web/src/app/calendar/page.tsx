"use client";

import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { EveSignalField } from "../../components/brand-visuals";
import { API_BASE, apiFetch, getStoredAuthToken } from "../../lib/api";
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

interface DayGroup {
  key: string;
  label: string;
  events: CalendarEvent[];
}

interface MeetingPrepPack {
  readiness: "ready" | "watch" | "needs_review";
  checklist: string[];
  relatedEmails: Array<{ id: string; from: string; subject: string; snippet: string | null }>;
  openTasks: Array<{ id: string; title: string; priority: string; dueDate: string | null }>;
  openCommitments: Array<{ id: string; title: string; owner: string; dueText: string | null }>;
}

export default function CalendarPage() {
  return (
    <AuthGuard>
      <CalendarView />
    </AuthGuard>
  );
}

function CalendarView() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [googleConnected, setGoogleConnected] = useState<boolean | null>(null);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ events: CalendarEvent[] }>("/api/calendar?days=14");
      setEvents(data.events);
    } catch (err) {
      captureClientError(err, { scope: "calendar.load" });
      setError("캘린더 일정을 불러오지 못했어요.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEvents();
    apiFetch<{ connected: boolean }>("/api/auth/google/status")
      .then((data) => setGoogleConnected(data.connected))
      .catch((err) => {
        captureClientError(err, { scope: "calendar.google-status" });
        setGoogleConnected(false);
      });
  }, [loadEvents]);

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    setSyncMessage(null);
    try {
      const result = await apiFetch<{ success?: boolean; synced?: number; error?: string }>(
        "/api/calendar/sync",
        { method: "POST", body: JSON.stringify({}) },
      );
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
          ? `Google Calendar에서 ${synced}개 일정을 가져왔어요.`
          : "Google Calendar 동기화 완료. 앞으로 14일 일정이 없습니다.",
      );
      await loadEvents();
    } catch (err) {
      captureClientError(err, { scope: "calendar.sync" });
      setError("Google Calendar 동기화에 실패했어요.");
    } finally {
      setSyncing(false);
    }
  };

  const groups = groupByDay(events);
  const todayCount = groups.find((group) => group.label === "오늘")?.events.length ?? 0;
  const nextEvent = events
    .map((event) => ({ event, start: new Date(event.startTime) }))
    .filter(({ start }) => start.getTime() >= Date.now())
    .sort((a, b) => a.start.getTime() - b.start.getTime())[0]?.event;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 md:py-10">
      <header className="mb-6 overflow-hidden rounded-lg border border-stone-700/45 bg-stone-950/55 shadow-2xl shadow-black/10">
        <div className="h-1 bg-gradient-to-r from-teal-300 via-amber-300 to-stone-600" />
        <div className="p-5 md:p-6">
          <div className="grid gap-5 lg:grid-cols-[1fr_300px] lg:items-stretch">
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
                캘린더
              </p>
              <h1 className="text-2xl font-semibold tracking-tight text-stone-50">
                준비가 필요한 미팅을 찾습니다
              </h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-stone-500">
                앞으로 14일의 미팅을 준비 자료와 관련 업무 신호와 함께 확인하세요.
              </p>
            </div>
            <div className="relative min-h-40 overflow-hidden rounded-lg border border-stone-800 bg-black/20">
              <EveSignalField className="absolute inset-0 border-0" />
              <button
                type="button"
                onClick={syncNow}
                disabled={syncing}
                className="absolute right-3 top-3 rounded-md border border-stone-700 bg-stone-950/75 px-3 py-1.5 text-xs text-stone-300 backdrop-blur transition hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-100 disabled:opacity-50"
              >
                {syncing ? "동기화 중..." : "지금 동기화"}
              </button>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-3 overflow-hidden rounded-lg border border-stone-800 bg-black/20">
            <CalendarStat label="14일" value={events.length} />
            <CalendarStat label="오늘" value={todayCount} />
            <CalendarStat
              label="다음"
              value={nextEvent ? formatTime(new Date(nextEvent.startTime)) : "-"}
            />
          </div>
          {nextEvent && (
            <div className="mt-4 rounded-lg border border-amber-300/15 bg-amber-300/5 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-300/80">
                다음 준비 대상
              </p>
              <p className="mt-1 truncate text-sm font-medium text-stone-100">
                {nextEvent.title || "제목 없음"}
              </p>
            </div>
          )}
        </div>
      </header>

      {loading && (
        <div className="rounded-lg border border-stone-800 bg-stone-950/35 px-4 py-5 text-center text-sm text-stone-500">
          일정 맥락을 조립하는 중...
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
        <div className="rounded-lg border border-stone-700/45 bg-stone-950/35 p-6 text-center">
          <p className="mb-1 text-sm text-stone-300">
            {googleConnected === false
              ? "Google Calendar가 아직 연결되지 않았어요."
              : "앞으로 14일 일정이 없습니다."}
          </p>
          <p className="mb-4 text-xs text-stone-500">
            {googleConnected === false
              ? "연결 후 동기화하면 Jigeum이 실제 캘린더 상태를 기준으로 브리핑합니다."
              : "Google 연결은 정상입니다. 캘린더가 비어 있으면 빈 상태 그대로 브리핑에 반영됩니다."}
          </p>
          {googleConnected === false ? (
            <a
              href={`${API_BASE}/api/auth/google?token=${getStoredAuthToken() || ""}`}
              className="inline-flex rounded-lg bg-amber-300 px-4 py-2 text-sm text-stone-950 transition hover:bg-amber-200"
            >
              Google 연결
            </a>
          ) : (
            <button
              type="button"
              onClick={syncNow}
              disabled={syncing}
              className="rounded-lg bg-amber-300 px-4 py-2 text-sm text-stone-950 transition hover:bg-amber-200 disabled:opacity-50"
            >
              {syncing ? "동기화 중..." : "다시 동기화"}
            </button>
          )}
        </div>
      )}

      {!loading && events.length > 0 && (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.key}>
              <h2 className="sticky top-0 z-10 -mx-4 bg-[#10100d]/92 px-4 py-2 text-[13px] font-medium text-stone-300 backdrop-blur-xl">
                <span>{g.label}</span>
                <span className="ml-2 text-[11px] font-normal text-stone-500">
                  {g.events.length}
                </span>
              </h2>
              <ul className="space-y-2 mt-2">
                {g.events.map((ev) => (
                  <EventRow key={ev.id} event={ev} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function CalendarStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="border-r border-stone-800 px-4 py-3 last:border-r-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">
        {label}
      </p>
      <p className="mt-1 truncate text-2xl font-semibold text-stone-100">{value}</p>
    </div>
  );
}

function EventRow({ event }: { event: CalendarEvent }) {
  const [prepOpen, setPrepOpen] = useState(false);
  const [prepLoading, setPrepLoading] = useState(false);
  const [prep, setPrep] = useState<MeetingPrepPack | null>(null);
  const [prepError, setPrepError] = useState<string | null>(null);
  const start = new Date(event.startTime);
  const end = new Date(event.endTime);
  const timeLabel = event.allDay ? "하루 종일" : `${formatTime(start)}–${formatTime(end)}`;

  const togglePrep = async () => {
    if (prepOpen) {
      setPrepOpen(false);
      return;
    }
    setPrepOpen(true);
    if (prep) return;
    setPrepLoading(true);
    setPrepError(null);
    try {
      setPrep(await apiFetch<MeetingPrepPack>(`/api/calendar/${event.id}/prep-pack`));
    } catch (err) {
      captureClientError(err, { scope: "calendar.prep_pack", eventId: event.id });
      setPrepError("미팅 준비 자료를 만들지 못했어요.");
    } finally {
      setPrepLoading(false);
    }
  };

  return (
    <li className="relative overflow-hidden rounded-lg border border-stone-700/45 bg-stone-950/45 p-4 pl-5 transition hover:border-amber-500/30 hover:bg-amber-500/5 active:bg-stone-900/70">
      <div className="absolute bottom-0 left-0 top-0 w-1 bg-gradient-to-b from-teal-300 via-amber-300 to-stone-700" />
      <div className="grid gap-3 md:grid-cols-[96px_1fr]">
        <div className="rounded-lg border border-stone-800 bg-black/20 px-3 py-2 text-[12px] font-medium tabular-nums text-stone-400">
          {timeLabel}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-stone-100">
            {event.title || "제목 없음"}
          </p>
          {event.location && (
            <p className="mt-0.5 truncate text-xs text-stone-500">{event.location}</p>
          )}
          {event.meetingLink && (
            <a
              href={event.meetingLink}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-amber-300 hover:text-amber-200"
            >
              미팅 참여
              <svg
                aria-hidden="true"
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={togglePrep}
              className="inline-flex items-center gap-1 rounded-md border border-amber-300/20 bg-amber-300/10 px-2.5 py-1.5 text-xs text-amber-200 transition hover:bg-amber-300/15 hover:text-amber-100"
            >
              준비 자료
            </button>
          </div>
        </div>
      </div>
      {prepOpen && (
        <div className="mt-3 rounded-lg border border-stone-800 bg-black/20 p-3">
          {prepLoading && <p className="text-xs text-stone-500">미팅 근거를 모으는 중...</p>}
          {prepError && <p className="text-xs text-red-300">{prepError}</p>}
          {prep && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span
                  className={`text-[11px] font-medium rounded px-1.5 py-0.5 border ${readinessClass(
                    prep.readiness,
                  )}`}
                >
                  {readinessLabel(prep.readiness)}
                </span>
                <span className="text-[11px] text-stone-500">
                  메일 {prep.relatedEmails.length} · 작업 {prep.openTasks.length} · 약속{" "}
                  {prep.openCommitments.length}
                </span>
              </div>
              <ul className="space-y-1.5">
                {prep.checklist.map((item) => (
                  <li
                    key={item}
                    className="rounded-md border border-stone-800/70 bg-stone-950/40 px-2 py-1.5 text-xs text-stone-300"
                  >
                    {item}
                  </li>
                ))}
              </ul>
              {prep.relatedEmails.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] font-medium text-stone-500">관련 메일</p>
                  <ul className="space-y-1">
                    {prep.relatedEmails.map((email) => (
                      <li key={email.id} className="truncate text-xs text-stone-300">
                        {email.subject}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {prep.openTasks.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] font-medium text-stone-500">미팅 전 할 일</p>
                  <ul className="space-y-1">
                    {prep.openTasks.map((task) => (
                      <li key={task.id} className="truncate text-xs text-stone-300">
                        {task.title}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function readinessLabel(readiness: MeetingPrepPack["readiness"]): string {
  switch (readiness) {
    case "ready":
      return "준비됨";
    case "watch":
      return "관찰";
    case "needs_review":
      return "준비 필요";
  }
}

function readinessClass(readiness: MeetingPrepPack["readiness"]): string {
  switch (readiness) {
    case "ready":
      return "text-emerald-300 bg-emerald-500/10 border-emerald-500/20";
    case "watch":
      return "text-amber-300 bg-amber-400/10 border-amber-400/20";
    case "needs_review":
      return "text-red-300 bg-red-500/10 border-red-500/20";
  }
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function groupByDay(events: CalendarEvent[]): DayGroup[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getTime() + 86400000);

  const groups = new Map<string, DayGroup>();
  for (const ev of events) {
    const d = new Date(ev.startTime);
    const dayKey = dayKeyFor(d);
    if (!groups.has(dayKey)) {
      groups.set(dayKey, { key: dayKey, label: dayLabel(d, today, tomorrow), events: [] });
    }
    groups.get(dayKey)?.events.push(ev);
  }
  return [...groups.values()];
}

function dayKeyFor(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(d: Date, today: Date, tomorrow: Date): string {
  if (sameDay(d, today)) return "오늘";
  if (sameDay(d, tomorrow)) return "내일";
  return d.toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
