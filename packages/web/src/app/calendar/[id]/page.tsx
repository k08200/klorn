"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { apiFetch } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { captureClientError } from "../../../lib/sentry";

type Readiness = "ready" | "watch" | "needs_review";

interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  startTime: string;
  endTime: string;
  location: string | null;
  meetingLink: string | null;
  allDay: boolean;
  color: string | null;
  googleId: string | null;
}

interface PrepEmail {
  id: string;
  from: string;
  subject: string;
  snippet: string | null;
  receivedAt: string;
  isRead: boolean;
}

interface PrepTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
}

interface PrepCommitment {
  id: string;
  title: string;
  owner: string;
  dueAt: string | null;
  dueText: string | null;
  confidence: number;
}

interface PrepPack {
  generatedAt: string;
  readiness: Readiness;
  checklist: string[];
  relatedEmails: PrepEmail[];
  openTasks: PrepTask[];
  openCommitments: PrepCommitment[];
}

const READINESS_META: Record<Readiness, { label: string; className: string }> = {
  ready: {
    label: "Ready",
    className: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  },
  watch: {
    label: "Watch items",
    className: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  },
  needs_review: {
    label: "Needs review",
    className: "border-red-500/30 bg-red-500/10 text-red-300",
  },
};

// `timeZone` is the user's stored IANA zone — never rely on the browser
// default. 24-hour format keeps AM/PM ambiguity out of the rendered range.
function formatRange(start: string, end: string, allDay: boolean, timeZone: string): string {
  const s = new Date(start);
  const e = new Date(end);
  if (allDay) {
    return s.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone,
    });
  }
  const sameLocalDay =
    s.toLocaleDateString("en-CA", { timeZone }) === e.toLocaleDateString("en-CA", { timeZone });
  const dateStr = s.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone,
  });
  const startTime = s.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
  const endTime = e.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
  if (sameLocalDay) {
    return `${dateStr} · ${startTime} – ${endTime}`;
  }
  const longRange = (d: Date) =>
    d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    });
  return `${longRange(s)} → ${longRange(e)}`;
}

function ExternalLinkIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function CalendarEventDetail({ id }: { id: string }) {
  const router = useRouter();
  const { user } = useAuth();
  const userTimezone = user?.timezone ?? "Asia/Seoul";
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [pack, setPack] = useState<PrepPack | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      apiFetch<CalendarEvent>(`/api/calendar/${id}`),
      apiFetch<PrepPack>(`/api/calendar/${id}/prep-pack`).catch(() => null),
    ])
      .then(([ev, pk]) => {
        setEvent(ev);
        setPack(pk);
      })
      .catch((err) => {
        captureClientError(err, { scope: "calendar-detail.load" });
        setError("Event not found.");
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiFetch(`/api/calendar/${id}`, { method: "DELETE" });
      router.push("/calendar");
    } catch (err) {
      captureClientError(err, { scope: "calendar-detail.delete" });
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="h-32 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30" />
        <div className="mt-4 h-40 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30" />
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12 text-center">
        <p className="text-sm text-stone-400">{error ?? "Event not found."}</p>
        <Link
          href="/calendar"
          className="mt-3 inline-block text-[12px] text-amber-300 hover:underline"
        >
          ← Back to calendar
        </Link>
      </div>
    );
  }

  const readiness = pack ? READINESS_META[pack.readiness] : null;

  return (
    <div className="min-h-dvh bg-[#0f1115]">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <Link
          href="/calendar"
          className="mb-4 inline-flex items-center gap-1 text-[12px] text-stone-500 hover:text-stone-300"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Calendar
        </Link>

        {/* Header */}
        <section className="rounded-2xl border border-stone-800 bg-stone-900/40 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="break-words text-xl font-semibold text-stone-100">{event.title}</h1>
              <p className="mt-1 text-[13px] text-stone-400">
                {formatRange(event.startTime, event.endTime, event.allDay, userTimezone)}
              </p>
              {event.location && (
                <p className="mt-1 break-words text-[12px] text-stone-500">📍 {event.location}</p>
              )}
              {event.meetingLink && (
                <a
                  href={event.meetingLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-[12px] text-amber-300 hover:text-amber-200"
                >
                  Join meeting
                  <ExternalLinkIcon />
                </a>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {confirmDelete ? (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="rounded-md px-2 py-1 text-[11px] text-stone-500 hover:text-stone-300 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleting}
                    className="rounded-md bg-red-600/20 px-2 py-1 text-[11px] text-red-400 hover:bg-red-600/30 transition disabled:opacity-50"
                  >
                    {deleting ? "Deleting…" : "Delete"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="rounded-md p-1.5 text-stone-700 transition hover:text-red-400"
                  aria-label="Delete event"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {event.description && (
            <p className="mt-4 whitespace-pre-wrap rounded-lg border border-stone-800 bg-black/20 p-3 text-[13px] leading-6 text-stone-300">
              {event.description}
            </p>
          )}
        </section>

        {/* Prep pack */}
        {pack && (
          <section className="mt-6 rounded-2xl border border-stone-800 bg-stone-900/30 p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-amber-200">
                  Prep pack
                </p>
                <p className="mt-0.5 text-[11px] text-stone-600">
                  Mail {pack.relatedEmails.length} · Tasks {pack.openTasks.length} · Commitments{" "}
                  {pack.openCommitments.length}
                </p>
              </div>
              {readiness && (
                <span
                  className={`rounded-md border px-2 py-1 text-[11px] font-medium ${readiness.className}`}
                >
                  {readiness.label}
                </span>
              )}
            </div>

            {pack.checklist.length > 0 && (
              <ul className="space-y-1.5">
                {pack.checklist.map((item) => (
                  <li
                    key={item}
                    className="rounded-md border border-stone-800 bg-stone-950/40 px-3 py-2 text-[12px] text-stone-300"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            )}

            {pack.relatedEmails.length > 0 && (
              <div className="mt-5">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-stone-500">
                  Related mail
                </p>
                <ul className="space-y-1.5">
                  {pack.relatedEmails.map((m) => (
                    <li
                      key={m.id}
                      className="rounded-md border border-stone-800 bg-stone-950/40 p-3 text-[12px]"
                    >
                      <Link
                        href={`/email/${m.id}`}
                        className="block transition hover:bg-stone-900/40"
                      >
                        <p className="break-words font-medium text-stone-200">{m.subject}</p>
                        <p className="mt-0.5 truncate text-[11px] text-stone-500">{m.from}</p>
                        {m.snippet && (
                          <p className="mt-1 line-clamp-2 text-[11px] text-stone-500">
                            {m.snippet}
                          </p>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {pack.openTasks.length > 0 && (
              <div className="mt-5">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-stone-500">
                  Open tasks
                </p>
                <ul className="space-y-1.5">
                  {pack.openTasks.map((t) => (
                    <li
                      key={t.id}
                      className="rounded-md border border-stone-800 bg-stone-950/40 px-3 py-2 text-[12px] text-stone-300"
                    >
                      {t.title}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {pack.openCommitments.length > 0 && (
              <div className="mt-5">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-stone-500">
                  Open commitments
                </p>
                <ul className="space-y-1.5">
                  {pack.openCommitments.map((c) => (
                    <li
                      key={c.id}
                      className="rounded-md border border-stone-800 bg-stone-950/40 px-3 py-2 text-[12px] text-stone-300"
                    >
                      <span className="mr-2 text-[10px] uppercase tracking-wider text-stone-600">
                        {c.owner === "USER"
                          ? "I owe"
                          : c.owner === "COUNTERPARTY"
                            ? "They owe"
                            : "—"}
                      </span>
                      {c.title}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

export default function CalendarEventPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  if (!id) return null;
  return (
    <AuthGuard>
      <CalendarEventDetail id={id} />
    </AuthGuard>
  );
}
