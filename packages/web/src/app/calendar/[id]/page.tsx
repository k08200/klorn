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
    className: "bg-emerald-500/10 text-emerald-600 ring-1 ring-inset ring-emerald-500/20",
  },
  watch: {
    label: "Watch items",
    className: "bg-amber-500/10 text-amber-600 ring-1 ring-inset ring-amber-500/20",
  },
  needs_review: {
    label: "Needs review",
    className: "bg-rose-500/10 text-rose-600 ring-1 ring-inset ring-rose-500/20",
  },
};

// ─── Sender display (file-local copies of the email flagship's monogram
// avatar helpers — kept local on purpose, no cross-page import) ────────────

/** "Jane Doe <jane@x.com>" → "Jane Doe"; bare addresses stay as-is. */
function senderName(from: string): string {
  const match = /^"?([^"<]+)"?\s*</.exec(from);
  return (match ? match[1] : from).trim();
}

// Latin ("Jamie Rivera" → JR), single-word senders ("Stripe" → S), and CJK
// names (first grapheme). Falls back to "@" for empty/degenerate strings.
function senderInitials(name: string): string {
  const words = name
    .replace(/["'()[\]]/g, "")
    .split(/[\s·|,]+/)
    .filter(Boolean);
  if (words.length === 0) return "@";
  const initials = words
    .slice(0, 2)
    .map((w) => w[0])
    .join("");
  return initials.toUpperCase();
}

// Deterministic gradient per sender so the same sender always gets the same
// color (recognition over decoration). Simple 31-hash over the name.
const AVATAR_GRADIENTS = [
  "from-sky-400 to-blue-500",
  "from-teal-400 to-emerald-500",
  "from-indigo-500 to-violet-600",
  "from-amber-400 to-orange-500",
  "from-rose-400 to-pink-500",
  "from-cyan-400 to-sky-600",
  "from-slate-600 to-slate-800",
];

function avatarGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

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
        <div className="h-32 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
        <div className="mt-4 h-40 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12 text-center">
        <p className="text-sm text-slate-500">{error ?? "Event not found."}</p>
        <Link
          href="/calendar"
          className="mt-3 inline-block text-[12px] text-sky-600 hover:underline"
        >
          ← Back to calendar
        </Link>
      </div>
    );
  }

  const readiness = pack ? READINESS_META[pack.readiness] : null;

  return (
    <div className="min-h-dvh">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <Link
          href="/calendar"
          className="mb-4 inline-flex items-center gap-1 text-[12px] text-slate-400 hover:text-slate-500"
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
        <section className="panel-elevated rounded-2xl border border-slate-200/70 bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="break-words text-xl font-semibold text-slate-900">{event.title}</h1>
              <p className="mt-1 text-[13px] text-slate-500">
                {formatRange(event.startTime, event.endTime, event.allDay, userTimezone)}
              </p>
              {event.location && (
                <p className="mt-1 break-words text-[12px] text-slate-400">📍 {event.location}</p>
              )}
              {event.meetingLink && (
                <a
                  href={event.meetingLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-[12px] text-sky-600 hover:text-sky-600"
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
                    className="ease-strong rounded-md px-2 py-1 text-[11px] text-slate-400 transition duration-150 hover:text-slate-600"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleting}
                    className="ease-strong rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 transition duration-150 hover:bg-red-100 active:scale-[0.97] disabled:opacity-50"
                  >
                    {deleting ? "Deleting…" : "Delete"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="ease-strong rounded-md p-1.5 text-slate-300 transition duration-150 hover:text-red-500"
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
            <p className="mt-4 whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 text-[13px] leading-6 text-slate-500">
              {event.description}
            </p>
          )}
        </section>

        {/* Prep pack */}
        {pack && (
          <section className="panel-elevated mt-6 rounded-2xl border border-slate-200/70 bg-white p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-sky-600">
                  Prep pack
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  Mail {pack.relatedEmails.length} · Tasks {pack.openTasks.length} · Commitments{" "}
                  {pack.openCommitments.length}
                </p>
              </div>
              {readiness && (
                <span
                  className={`rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ${readiness.className}`}
                >
                  {readiness.label}
                </span>
              )}
            </div>

            {pack.checklist.length > 0 && (
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-100">
                {pack.checklist.map((item) => (
                  <li key={item} className="row-wash px-3 py-2 text-[12px] text-slate-500">
                    {item}
                  </li>
                ))}
              </ul>
            )}

            {pack.relatedEmails.length > 0 && (
              <div className="mt-5">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                  Related mail
                </p>
                <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-100">
                  {pack.relatedEmails.map((m) => {
                    const name = senderName(m.from);
                    return (
                      <li key={m.id} className="row-wash relative text-[12px]">
                        {!m.isRead && (
                          <span
                            aria-hidden="true"
                            className="absolute left-0 top-0 h-full w-[3px] bg-sky-400"
                          />
                        )}
                        <Link
                          href={`/email/${m.id}`}
                          className="flex items-start gap-3 p-3 transition duration-150"
                        >
                          <span
                            aria-hidden="true"
                            className={`avatar-ring mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[12px] font-semibold text-white ${avatarGradient(name)}`}
                          >
                            {senderInitials(name)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block break-words font-medium text-slate-900">
                              {m.subject}
                            </span>
                            <span className="mt-0.5 block truncate text-[11px] text-slate-400">
                              {name}
                            </span>
                            {m.snippet && (
                              <span className="mt-1 line-clamp-2 block text-[11px] text-slate-400">
                                {m.snippet}
                              </span>
                            )}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {pack.openTasks.length > 0 && (
              <div className="mt-5">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                  Open tasks
                </p>
                <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-100">
                  {pack.openTasks.map((t) => (
                    <li key={t.id} className="row-wash px-3 py-2 text-[12px] text-slate-500">
                      {t.title}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {pack.openCommitments.length > 0 && (
              <div className="mt-5">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                  Open commitments
                </p>
                <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-100">
                  {pack.openCommitments.map((c) => (
                    <li key={c.id} className="row-wash px-3 py-2 text-[12px] text-slate-500">
                      <span
                        className={`mr-2 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ${
                          c.owner === "USER"
                            ? "bg-sky-500/10 text-sky-600 ring-1 ring-inset ring-sky-500/20"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
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
