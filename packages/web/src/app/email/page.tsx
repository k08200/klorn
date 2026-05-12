"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { apiFetch } from "../../lib/api";
import { captureClientError } from "../../lib/sentry";

type Filter =
  | "all"
  | "reply-needed"
  | "urgent"
  | "unread"
  | "candidates"
  | "attachments"
  | "automated";

interface CandidateProfilePreview {
  name: string | null;
  role: string | null;
  contact: string | null;
  summary: string;
  missingFields: string[];
  confidence: number;
  evidenceCount: number;
  intakeStatus: string | null;
}

interface EmailRow {
  id: string;
  gmailId: string;
  from: string;
  subject: string;
  snippet: string | null;
  date: string;
  isRead: boolean;
  priority: "URGENT" | "NORMAL" | "LOW";
  category: string | null;
  summary: string | null;
  needsReply?: boolean;
  attachmentCount?: number;
  attachmentCandidateCount?: number;
  attachmentPendingCount?: number;
  attachmentFallbackCount?: number;
  attachmentUnsupportedCount?: number;
  attachmentCategories?: string[];
  candidateProfilePreview?: CandidateProfilePreview | null;
}

interface ListResponse {
  emails: EmailRow[];
  source: "gmail" | "demo";
  total: number;
  unread: number;
}

const FILTERS: { key: Filter; label: string; query: string }[] = [
  { key: "all", label: "All signals", query: "" },
  { key: "reply-needed", label: "Needs reply", query: "filter=reply-needed" },
  { key: "urgent", label: "Urgent", query: "filter=urgent" },
  { key: "unread", label: "Unread", query: "filter=unread" },
  { key: "automated", label: "Automated", query: "category=automated" },
];

export default function EmailPage() {
  return (
    <AuthGuard>
      <EmailView />
    </AuthGuard>
  );
}

function EmailView() {
  const [filter, setFilter] = useState<Filter>("all");
  const [emails, setEmails] = useState<EmailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [source, setSource] = useState<"gmail" | "demo" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (f: Filter) => {
    setLoading(true);
    setError(null);
    try {
      const q = FILTERS.find((x) => x.key === f)?.query || "";
      const path = `/api/email${q ? `?${q}` : ""}`;
      const data = await apiFetch<ListResponse>(path);
      setEmails(data.emails);
      setSource(data.source);
    } catch (err) {
      captureClientError(err, { scope: "email.load", filter: f });
      setError("Could not load mail signals.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filter);
  }, [filter, load]);

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    try {
      await apiFetch("/api/email/sync", { method: "POST", body: JSON.stringify({}) });
      await load(filter);
    } catch (err) {
      captureClientError(err, { scope: "email.sync" });
      setError("Could not sync Gmail.");
    } finally {
      setSyncing(false);
    }
  };

  const reanalyzeAttachments = async () => {
    setReanalyzing(true);
    setError(null);
    try {
      await apiFetch("/api/email/attachments/analyze", {
        method: "POST",
        body: JSON.stringify({ retryFallback: true, limit: 50 }),
      });
      await load(filter);
    } catch (err) {
      captureClientError(err, { scope: "email.attachments.analyzeAll" });
      setError("Could not rerun attachment analysis.");
    } finally {
      setReanalyzing(false);
    }
  };

  const unreadCount = emails.filter((email) => !email.isRead).length;
  const urgentCount = emails.filter((email) => email.priority === "URGENT").length;
  const replyCount = emails.filter((email) => email.needsReply).length;
  const candidateCount = emails.filter((email) => (email.attachmentCandidateCount ?? 0) > 0).length;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 md:py-10">
      <header className="mb-5 rounded-lg border border-stone-800 bg-[#111318] p-5 shadow-xl shadow-black/10 md:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
              Mail
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-stone-50">
              See the mail that needs action first
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-stone-500">
              Organized by urgency, reply need, and attachment context.
              {source === "demo" && <span className="ml-2 text-amber-300">Demo data</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing}
            className="h-9 w-fit rounded-md border border-stone-700 bg-stone-900 px-3 text-xs font-medium text-stone-300 transition hover:border-stone-600 hover:bg-stone-800 hover:text-stone-100 disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Sync now"}
          </button>
        </div>
        <div className="mt-5 grid grid-cols-3 overflow-hidden rounded-md border border-stone-800 bg-[#0f1115]">
          <SignalStat label="Unread" value={unreadCount} />
          <SignalStat label="Urgent" value={urgentCount} />
          <SignalStat label="Replies" value={replyCount} />
        </div>
      </header>

      <FilterTabs current={filter} onChange={setFilter} />

      {loading && <p className="px-1 py-3 text-sm text-stone-500">Loading...</p>}

      {error && (
        <div className="mt-3 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {!loading && !error && emails.length === 0 && (
        <div className="mt-4 rounded-lg border border-stone-800 bg-[#111318] p-6 text-center">
          <p className="text-sm text-stone-300">
            {filter === "all" ? "No mail signals yet." : "No signals match this filter."}
          </p>
          <p className="mt-1 text-xs text-stone-600">
            Once sync finishes, mail that needs action will rise to the top.
          </p>
        </div>
      )}

      {!loading && emails.length > 0 && (
        <ul className="mt-3 space-y-2.5">
          {emails.map((e) => (
            <EmailRowItem key={e.id} email={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SignalStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-r border-stone-800 px-4 py-3 last:border-r-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-stone-100">{value}</p>
    </div>
  );
}

function FilterTabs({ current, onChange }: { current: Filter; onChange: (f: Filter) => void }) {
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 scrollbar-hide">
      {FILTERS.map((f) => {
        const active = f.key === current;
        return (
          <button
            key={f.key}
            type="button"
            onClick={() => onChange(f.key)}
            className={`min-h-[32px] shrink-0 rounded-full px-3 py-1.5 text-xs transition ${
              active
                ? "bg-stone-100 text-stone-950"
                : "border border-stone-700 bg-[#111318] text-stone-400 hover:bg-stone-800 hover:text-stone-200"
            }`}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

function EmailRowItem({ email }: { email: EmailRow }) {
  const unread = !email.isRead;
  return (
    <li>
      <Link
        href={`/email/${email.id}`}
        className="block rounded-lg border border-stone-800 bg-[#111318] transition hover:border-stone-700 hover:bg-[#151821] active:bg-stone-900/70"
      >
        <div className="grid gap-3 p-4 md:grid-cols-[1fr_auto] md:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <PriorityBadge priority={email.priority} />
              {email.needsReply && <ReplyNeededBadge />}
              {(email.attachmentCandidateCount ?? 0) > 0 && <CandidateBadge />}
              {(email.attachmentCount ?? 0) > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded border border-sky-400/30 bg-sky-400/10 text-sky-300 font-medium shrink-0">
                  Attachments {email.attachmentCount}
                </span>
              )}
              {(email.attachmentPendingCount ?? 0) > 0 && (
                <span className="shrink-0 rounded border border-stone-600 bg-stone-900/70 px-1.5 py-0.5 text-[10px] font-medium text-stone-400">
                  Pending {email.attachmentPendingCount}
                </span>
              )}
              {(email.attachmentFallbackCount ?? 0) > 0 && (
                <span className="shrink-0 rounded border border-amber-400/25 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                  Basic analysis {email.attachmentFallbackCount}
                </span>
              )}
              {email.category && <CategoryBadge category={email.category} />}
              {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300" />}
            </div>
            <p
              className={`mt-2 truncate text-sm ${unread ? "font-semibold text-stone-100" : "text-stone-300"}`}
            >
              {senderName(email.from)}
            </p>
            <p className="mt-1 truncate text-[13px] text-stone-400">
              {email.subject || "Untitled"}
            </p>
            {email.summary ? (
              <p className="mt-2 line-clamp-2 text-xs leading-5 text-stone-400">
                <span className="mr-1 text-stone-500">Summary:</span>
                {email.summary}
              </p>
            ) : email.snippet ? (
              <p className="mt-2 line-clamp-2 text-xs leading-5 text-stone-600">{email.snippet}</p>
            ) : null}
            {email.candidateProfilePreview && (
              <CandidatePreview profile={email.candidateProfilePreview} />
            )}
          </div>
          <time className="shrink-0 text-[11px] tabular-nums text-stone-500 md:pt-1">
            {formatRelative(email.date)}
          </time>
        </div>
      </Link>
    </li>
  );
}

function CandidatePreview({ profile }: { profile: CandidateProfilePreview }) {
  const title = [profile.name || "Name unknown", profile.role].filter(Boolean).join(" · ");
  const missing =
    profile.missingFields.length > 0
      ? `Needs: ${profile.missingFields.map(candidateMissingLabel).join(", ")}`
      : null;
  return (
    <div className="mt-2 rounded-lg border border-emerald-500/15 bg-emerald-500/5 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[11px] font-medium text-emerald-200">{title}</p>
        <span className="shrink-0 text-[10px] tabular-nums text-emerald-300/80">
          {Math.round(profile.confidence * 100)}%
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-stone-400">{profile.summary}</p>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-stone-500">
        {profile.contact && <span className="truncate">Contact {profile.contact}</span>}
        {profile.intakeStatus && <span>{candidateIntakeLabel(profile.intakeStatus)}</span>}
        <span>{profile.evidenceCount} files</span>
        {missing && <span className="text-amber-300/80">{missing}</span>}
      </div>
    </div>
  );
}

function candidateIntakeLabel(status: string): string {
  const labels: Record<string, string> = {
    NEEDS_ANALYSIS: "Needs analysis",
    NEEDS_INFO: "Needs info",
    READY_TO_REVIEW: "Ready to review",
    REVIEWING: "Reviewing",
    CONTACTED: "Contacted",
    SHORTLISTED: "Shortlisted",
    REJECTED: "Rejected",
    ARCHIVED: "Archived",
  };
  return labels[status] || status;
}

function candidateMissingLabel(field: string): string {
  const labels: Record<string, string> = {
    name: "name",
    contact: "contact",
    role: "role",
    portfolio: "portfolio",
  };
  return labels[field] || field;
}
function ReplyNeededBadge() {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-400/30 bg-amber-400/10 text-amber-300 font-medium shrink-0">
      Needs reply
    </span>
  );
}

function CandidateBadge() {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-400/30 bg-emerald-400/10 text-emerald-300 font-medium shrink-0">
      Candidate
    </span>
  );
}

function PriorityBadge({ priority }: { priority: EmailRow["priority"] }) {
  const styles = {
    URGENT: "bg-red-500/15 text-red-300 border-red-500/30",
    NORMAL: "bg-stone-800 text-stone-400 border-stone-700",
    LOW: "bg-stone-900 text-stone-500 border-stone-800",
  } as const;
  const labels = { URGENT: "Urgent", NORMAL: "Normal", LOW: "Low" } as const;
  if (priority === "NORMAL") return null;
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border ${styles[priority]} font-medium shrink-0`}
    >
      {labels[priority]}
    </span>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const labelMap: Record<string, string> = {
    business: "Business",
    engineering: "Engineering",
    automated: "Automated",
    newsletter: "Newsletter",
    meeting: "Meeting",
    billing: "Billing",
    conversation: "Conversation",
    other: "Other",
  };
  const label = labelMap[category] || category;
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded border border-stone-700 bg-stone-900/60 text-stone-400 shrink-0">
      {label}
    </span>
  );
}

function senderName(raw: string): string {
  const match = raw.match(/^([^<]+?)\s*</);
  if (match?.[1]) return match[1].trim();
  return raw.replace(/[<>]/g, "").trim();
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "2-digit" }),
  });
}
