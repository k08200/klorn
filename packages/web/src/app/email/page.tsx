"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { useToast } from "../../components/toast";
import { apiFetch } from "../../lib/api";
import { captureClientError } from "../../lib/sentry";

type Filter =
  | "all"
  | "reply-needed"
  | "urgent"
  | "unread"
  | "candidates"
  | "attachments"
  | "finance"
  | "legal"
  | "sales"
  | "support"
  | "threads"
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

interface ThreadRow {
  threadId: string;
  subject: string;
  participants: string[];
  messageCount: number;
  hasUnread: boolean;
  latestPriority: "URGENT" | "NORMAL" | "LOW";
  summary: string | null;
  lastMessage: {
    id: string;
    from: string;
    snippet: string | null;
    receivedAt: string;
    isRead: boolean;
  };
}

interface ListResponse {
  emails: EmailRow[];
  source: "gmail" | "demo";
  total: number;
  unread: number;
}

interface ThreadListResponse {
  threads: ThreadRow[];
  source: "gmail" | "demo";
  total: number;
}

type BulkAction = "mark-read" | "mark-unread" | "archive" | "set-priority";

interface BulkActionResponse {
  success: boolean;
  updatedCount: number;
  failed?: Array<{ id: string; error: string }>;
}

type UndoableEmailAction = "archive" | "delete";

interface UndoNotice {
  action: UndoableEmailAction;
  gmailId: string;
  subject: string | null;
}

interface BulkUndoEmail {
  id: string;
  gmailId: string;
  subject: string;
}

interface BulkUndoNotice {
  action: "archive";
  emails: BulkUndoEmail[];
}

interface UndoActionResponse {
  success: boolean;
  gmailId: string;
  emailId: string;
}

function parseUndoNotice(searchParams: ReturnType<typeof useSearchParams>): UndoNotice | null {
  const action = searchParams?.get("undoAction");
  const gmailId = searchParams?.get("undoGmailId")?.trim();
  if ((action !== "archive" && action !== "delete") || !gmailId) return null;
  return {
    action,
    gmailId,
    subject: searchParams?.get("undoSubject") || null,
  };
}

const FILTERS: { key: Filter; label: string; query: string }[] = [
  { key: "all", label: "All signals", query: "" },
  { key: "reply-needed", label: "Needs reply", query: "filter=reply-needed" },
  { key: "urgent", label: "Urgent", query: "filter=urgent" },
  { key: "unread", label: "Unread", query: "filter=unread" },
  { key: "attachments", label: "Attachments", query: "filter=attachments" },
  { key: "candidates", label: "Candidates", query: "filter=candidates" },
  { key: "finance", label: "Finance", query: "category=billing" },
  { key: "legal", label: "Legal", query: "search=contract" },
  { key: "sales", label: "Sales", query: "category=business" },
  { key: "support", label: "Support", query: "search=support" },
  { key: "threads", label: "Threads", query: "" },
  { key: "automated", label: "Automated", query: "category=automated" },
];

const WORK_QUEUES: Array<{
  key: Filter;
  title: string;
  description: string;
  count: (emails: EmailRow[]) => number;
}> = [
  {
    key: "finance",
    title: "Finance docs",
    description: "Billing, invoices, failed payments, contract amounts",
    count: (emails) =>
      emails.filter((email) =>
        `${email.category ?? ""} ${email.subject} ${email.summary ?? ""} ${email.snippet ?? ""}`
          .toLowerCase()
          .match(/billing|invoice|payment|receipt/),
      ).length,
  },
  {
    key: "legal",
    title: "Legal review",
    description: "Contracts, compliance, signatures, risk",
    count: (emails) =>
      emails.filter((email) =>
        `${email.subject} ${email.summary ?? ""} ${email.snippet ?? ""}`.match(
          /contract|legal|signature|compliance/i,
        ),
      ).length,
  },
  {
    key: "sales",
    title: "Revenue and customers",
    description: "Customer replies, renewals, pricing, meeting follow-up",
    count: (emails) =>
      emails.filter((email) =>
        `${email.category ?? ""} ${email.subject} ${email.summary ?? ""}`.match(
          /business|customer|sales|renewal|pricing|proposal/i,
        ),
      ).length,
  },
  {
    key: "support",
    title: "Support issues",
    description: "Bugs, incidents, complaints, escalations",
    count: (emails) =>
      emails.filter((email) =>
        `${email.subject} ${email.summary ?? ""} ${email.snippet ?? ""}`.match(
          /bug|issue|error|support|blocked|complaint/i,
        ),
      ).length,
  },
];

export default function EmailPage() {
  return (
    <AuthGuard>
      <EmailView />
    </AuthGuard>
  );
}

function EmailView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const undoNotice = parseUndoNotice(searchParams);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [emails, setEmails] = useState<EmailRow[]>([]);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [source, setSource] = useState<"gmail" | "demo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [bulkUndoNotice, setBulkUndoNotice] = useState<BulkUndoNotice | null>(null);

  const load = useCallback(async (f: Filter, keyword = "") => {
    setLoading(true);
    setError(null);
    setSelectedIds(new Set());
    try {
      const q = FILTERS.find((x) => x.key === f)?.query || "";
      const params = new URLSearchParams(q);
      if (keyword.trim()) params.set("search", keyword.trim());
      if (f === "threads") {
        const data = await apiFetch<ThreadListResponse>(
          `/api/email/threads${params.toString() ? `?${params.toString()}` : ""}`,
        );
        setThreads(data.threads);
        setEmails([]);
        setSource(data.source);
      } else {
        const data = await apiFetch<ListResponse>(
          `/api/email${params.toString() ? `?${params.toString()}` : ""}`,
        );
        setEmails(data.emails);
        setThreads([]);
        setSource(data.source);
      }
    } catch (err) {
      captureClientError(err, { scope: "email.load", filter: f });
      setError("Could not load mail.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filter, appliedSearch);
  }, [appliedSearch, filter, load]);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAppliedSearch(search.trim());
  };

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    try {
      await apiFetch("/api/email/sync", { method: "POST", body: JSON.stringify({}) });
      await load(filter, appliedSearch);
    } catch (err) {
      captureClientError(err, { scope: "email.sync" });
      setError("Gmail sync failed.");
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
      await load(filter, appliedSearch);
    } catch (err) {
      captureClientError(err, { scope: "email.attachments.analyzeAll" });
      setError("Could not rerun attachment analysis.");
    } finally {
      setReanalyzing(false);
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const visibleIds = emails.map((email) => email.id);
  const selectedCount = selectedIds.size;
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((emailId) => selectedIds.has(emailId));

  const toggleAllVisible = () => {
    setSelectedIds((prev) => {
      if (allVisibleSelected) return new Set();
      const next = new Set(prev);
      for (const id of visibleIds) next.add(id);
      return next;
    });
  };

  const applyBulkAction = async (
    action: BulkAction,
    options: { priority?: EmailRow["priority"] } = {},
  ) => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const selectedEmails = emails.filter((email) => selectedIds.has(email.id));
    setBulkBusy(true);
    setError(null);
    try {
      const data = await apiFetch<BulkActionResponse>("/api/email/bulk", {
        method: "POST",
        body: JSON.stringify({ ids, action, priority: options.priority }),
      });
      setEmails((prev) => updateEmailsAfterBulk(prev, ids, action, options.priority));
      setSelectedIds(new Set());
      if (action === "archive") {
        const failedIds = new Set(data.failed?.map((item) => item.id) ?? []);
        const undoEmails = selectedEmails
          .filter((email) => !failedIds.has(email.id))
          .map((email) => ({
            id: email.id,
            gmailId: email.gmailId,
            subject: email.subject || "No subject",
          }));
        setBulkUndoNotice(undoEmails.length > 0 ? { action: "archive", emails: undoEmails } : null);
      } else {
        setBulkUndoNotice(null);
      }
      if (data.failed && data.failed.length > 0) {
        setError(`${data.failed.length} messages could not be processed. Please try again.`);
      }
    } catch (err) {
      captureClientError(err, { scope: "email.bulk", action });
      setError("Could not process the selected mail.");
    } finally {
      setBulkBusy(false);
    }
  };

  const dismissUndoNotice = () => {
    router.replace("/email");
  };

  const dismissBulkUndoNotice = () => {
    setBulkUndoNotice(null);
  };

  const undoLastAction = async () => {
    if (!undoNotice || undoBusy) return;
    setUndoBusy(true);
    setError(null);
    try {
      const data = await apiFetch<UndoActionResponse>(
        `/api/email/${encodeURIComponent(undoNotice.gmailId)}/${undoNotice.action}/undo`,
        {
          method: "POST",
          body: JSON.stringify({ gmailId: undoNotice.gmailId }),
        },
      );
      toast("Restored to inbox.", "success");
      router.replace(`/email/${data.emailId}?markRead=false`);
    } catch (err) {
      captureClientError(err, { scope: "email.list.undo", action: undoNotice.action });
      setError("Could not restore that email. Check Gmail connection and try again.");
    } finally {
      setUndoBusy(false);
    }
  };

  const undoBulkArchive = async () => {
    if (!bulkUndoNotice || undoBusy) return;
    setUndoBusy(true);
    setError(null);
    try {
      const results = await Promise.allSettled(
        bulkUndoNotice.emails.map((email) =>
          apiFetch<UndoActionResponse>(
            `/api/email/${encodeURIComponent(email.gmailId)}/archive/undo`,
            {
              method: "POST",
              body: JSON.stringify({ gmailId: email.gmailId }),
            },
          ),
        ),
      );
      const failedCount = results.filter((result) => result.status === "rejected").length;
      if (failedCount > 0) {
        setError(`${failedCount} messages could not be restored. Check Gmail and try again.`);
      } else {
        toast("Restored to inbox.", "success");
        setBulkUndoNotice(null);
      }
      await load(filter, appliedSearch);
    } catch (err) {
      captureClientError(err, { scope: "email.bulk.undo" });
      setError("Could not restore the archived mail. Check Gmail connection and try again.");
    } finally {
      setUndoBusy(false);
    }
  };

  const unreadCount = emails.filter((email) => !email.isRead).length;
  const urgentCount = emails.filter((email) => email.priority === "URGENT").length;
  const replyCount = emails.filter((email) => email.needsReply).length;
  const candidateCount = emails.filter((email) => (email.attachmentCandidateCount ?? 0) > 0).length;
  const attachmentCount = emails.filter((email) => (email.attachmentCount ?? 0) > 0).length;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 md:py-10">
      <header className="mb-5 rounded-lg border border-white/10 bg-[#11161A] p-5 shadow-xl shadow-black/10 md:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#FF8A70]">
              Mail
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-stone-50">
              See mail that needs an answer first
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-stone-500">
              Organized by urgency and reply need.
              {source === "demo" && <span className="ml-2 text-[#FF6B4A]">Demo data</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing}
            className="min-h-11 w-fit rounded-md border border-white/10 bg-[#090B10] px-3 text-xs font-medium text-stone-300 transition hover:border-white/20 hover:bg-white/5 hover:text-stone-100 disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Sync now"}
          </button>
          <button
            type="button"
            onClick={reanalyzeAttachments}
            disabled={reanalyzing}
            className="min-h-11 w-fit rounded-md border border-[#7DD3FC]/25 bg-[#7DD3FC]/10 px-3 text-xs font-medium text-sky-100 transition hover:bg-[#7DD3FC]/15 disabled:opacity-50"
          >
            {reanalyzing ? "Analyzing..." : "Reanalyze attachments"}
          </button>
        </div>
        <div className="mt-5 grid grid-cols-4 overflow-hidden rounded-md border border-white/10 bg-[#090B10]">
          <SignalStat label="Unread" value={unreadCount} />
          <SignalStat label="Urgent" value={urgentCount} />
          <SignalStat label="Replies" value={replyCount} />
          <SignalStat label="Files" value={attachmentCount} />
        </div>
      </header>

      {undoNotice && (
        <UndoActionBanner
          notice={undoNotice}
          busy={undoBusy}
          onDismiss={dismissUndoNotice}
          onUndo={undoLastAction}
        />
      )}

      {bulkUndoNotice && (
        <BulkUndoActionBanner
          notice={bulkUndoNotice}
          busy={undoBusy}
          onDismiss={dismissBulkUndoNotice}
          onUndo={undoBulkArchive}
        />
      )}

      <form onSubmit={submitSearch} className="mb-3 flex gap-2">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search sender, body, attachment text, extracted fields"
          className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-[#090B10] px-3 text-sm text-stone-200 outline-none transition placeholder:text-stone-600 focus:border-[#FF6B4A]/45"
        />
        <button
          type="submit"
          className="h-10 rounded-lg bg-[#FF6B4A] px-4 text-sm font-medium text-stone-950 transition hover:bg-[#FFB09C]"
        >
          Search
        </button>
        {appliedSearch && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setAppliedSearch("");
            }}
            className="h-10 rounded-lg border border-white/10 bg-[#11161A] px-3 text-xs text-stone-400 transition hover:bg-white/5"
          >
            Clear
          </button>
        )}
      </form>

      <FilterTabs current={filter} onChange={setFilter} />

      <div className="mt-3 grid gap-2 md:grid-cols-4">
        {WORK_QUEUES.map((queue) => (
          <button
            key={queue.key}
            type="button"
            onClick={() => setFilter(queue.key)}
            className={`rounded-lg border p-3 text-left transition ${
              filter === queue.key
                ? "border-[#FF6B4A]/45 bg-[#FF6B4A]/10"
                : "border-white/10 bg-[#11161A] hover:border-white/20 hover:bg-white/5"
            }`}
          >
            <span className="block text-sm font-medium text-stone-100">{queue.title}</span>
            <span className="mt-1 block text-[11px] leading-4 text-stone-500">
              {queue.description}
            </span>
            <span className="mt-2 block text-xs text-[#FF8A70]">
              Current signals {queue.count(emails)}
            </span>
          </button>
        ))}
      </div>

      {candidateCount > 0 && (
        <Link
          href="/email/candidates"
          className="mt-3 flex items-center justify-between rounded-lg border border-orange-500/20 bg-orange-500/5 px-4 py-3 text-sm text-[#FFB09C] transition hover:bg-orange-500/10"
        >
          <span>Review {candidateCount} candidate signals in the intake queue.</span>
          <span className="text-xs">Open</span>
        </Link>
      )}

      {loading && <p className="px-1 py-3 text-sm text-stone-500">Loading...</p>}

      {error && (
        <div className="mt-3 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {!loading && !error && filter !== "threads" && emails.length === 0 && (
        <div className="mt-4 rounded-lg border border-white/10 bg-[#11161A] p-6 text-center">
          <p className="text-sm text-stone-300">
            {filter === "all" ? "No mail signals yet." : "No signals match this filter."}
          </p>
          <p className="mt-1 text-xs text-stone-600">
            After sync, mail that needs action rises to the top.
          </p>
          {filter === "all" && (
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Link
                href="/settings"
                className="inline-flex min-h-11 items-center rounded-md bg-[#FF8A70] px-4 text-xs font-medium text-stone-950 transition hover:bg-[#FFB09C]"
              >
                Connect Google
              </Link>
              <button
                type="button"
                onClick={syncNow}
                disabled={syncing}
                className="inline-flex min-h-11 items-center rounded-md border border-white/10 px-4 text-xs font-medium text-stone-300 transition hover:border-white/20 hover:text-stone-100 disabled:opacity-50"
              >
                {syncing ? "Syncing..." : "Sync now"}
              </button>
            </div>
          )}
        </div>
      )}

      {!loading && filter !== "threads" && emails.length > 0 && (
        <ul className="mt-3 space-y-2.5">
          <li>
            <BulkActionBar
              allVisibleSelected={allVisibleSelected}
              busy={bulkBusy}
              selectedCount={selectedCount}
              totalVisible={emails.length}
              onApply={applyBulkAction}
              onClear={() => setSelectedIds(new Set())}
              onToggleAll={toggleAllVisible}
            />
          </li>
          {emails.map((e) => (
            <EmailRowItem
              key={e.id}
              email={e}
              queue={filter}
              selected={selectedIds.has(e.id)}
              onToggleSelected={toggleSelected}
            />
          ))}
        </ul>
      )}

      {!loading && filter === "threads" && threads.length === 0 && !error && (
        <div className="mt-4 rounded-lg border border-white/10 bg-[#11161A] p-6 text-center">
          <p className="text-sm text-stone-300">No threads match this filter.</p>
        </div>
      )}

      {!loading && filter === "threads" && threads.length > 0 && (
        <ul className="mt-3 space-y-2.5">
          {threads.map((thread) => (
            <ThreadRowItem key={thread.threadId} thread={thread} />
          ))}
        </ul>
      )}
    </div>
  );
}

function updateEmailsAfterBulk(
  emails: EmailRow[],
  ids: string[],
  action: BulkAction,
  priority?: EmailRow["priority"],
): EmailRow[] {
  const selected = new Set(ids);
  if (action === "archive") return emails.filter((email) => !selected.has(email.id));
  if (action === "mark-read" || action === "mark-unread") {
    const isRead = action === "mark-read";
    return emails.map((email) => (selected.has(email.id) ? { ...email, isRead } : email));
  }
  if (action === "set-priority" && priority) {
    return emails.map((email) => (selected.has(email.id) ? { ...email, priority } : email));
  }
  return emails;
}

function UndoActionBanner({
  notice,
  busy,
  onDismiss,
  onUndo,
}: {
  notice: UndoNotice;
  busy: boolean;
  onDismiss: () => void;
  onUndo: () => void;
}) {
  const actionLabel = notice.action === "archive" ? "archived" : "moved to trash";
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-[#FF8A70]/30 bg-[#2A1510] px-4 py-3 text-sm text-stone-200 shadow-lg shadow-black/10 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium">Email {actionLabel}.</p>
        {notice.subject && (
          <p className="mt-0.5 truncate text-xs text-stone-400">{notice.subject}</p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={onUndo}
          disabled={busy}
          className="min-h-10 rounded-md bg-[#FF8A70] px-3 text-xs font-semibold text-stone-950 transition hover:bg-[#FFB09C] disabled:opacity-50"
        >
          {busy ? "Restoring..." : "Undo"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="min-h-10 rounded-md border border-white/10 px-3 text-xs text-stone-300 transition hover:bg-white/5 disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function BulkUndoActionBanner({
  notice,
  busy,
  onDismiss,
  onUndo,
}: {
  notice: BulkUndoNotice;
  busy: boolean;
  onDismiss: () => void;
  onUndo: () => void;
}) {
  const count = notice.emails.length;
  const preview = notice.emails
    .slice(0, 2)
    .map((email) => email.subject)
    .join(", ");
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-[#FF8A70]/30 bg-[#2A1510] px-4 py-3 text-sm text-stone-200 shadow-lg shadow-black/10 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium">
          {count} {count === 1 ? "email" : "emails"} archived.
        </p>
        {preview && <p className="mt-0.5 truncate text-xs text-stone-400">{preview}</p>}
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={onUndo}
          disabled={busy}
          className="min-h-10 rounded-md bg-[#FF8A70] px-3 text-xs font-semibold text-stone-950 transition hover:bg-[#FFB09C] disabled:opacity-50"
        >
          {busy ? "Restoring..." : "Undo all"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="min-h-10 rounded-md border border-white/10 px-3 text-xs text-stone-300 transition hover:bg-white/5 disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function BulkActionBar({
  allVisibleSelected,
  busy,
  selectedCount,
  totalVisible,
  onApply,
  onClear,
  onToggleAll,
}: {
  allVisibleSelected: boolean;
  busy: boolean;
  selectedCount: number;
  totalVisible: number;
  onApply: (action: BulkAction, options?: { priority?: EmailRow["priority"] }) => void;
  onClear: () => void;
  onToggleAll: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-[#0C1116] px-3 py-2 md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleAll}
          className="h-8 rounded-md border border-white/10 bg-[#11161A] px-2.5 text-xs font-medium text-stone-300 transition hover:bg-white/5"
        >
          {allVisibleSelected ? "Clear page" : "Select page"}
        </button>
        <span className="text-xs text-stone-500">
          {selectedCount > 0 ? `${selectedCount} selected` : `${totalVisible} on this page`}
        </span>
      </div>
      {selectedCount > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <BulkButton disabled={busy} onClick={() => onApply("mark-read")}>
            Mark read
          </BulkButton>
          <BulkButton disabled={busy} onClick={() => onApply("mark-unread")}>
            Mark unread
          </BulkButton>
          <BulkButton
            disabled={busy}
            onClick={() => onApply("set-priority", { priority: "URGENT" })}
          >
            Urgent
          </BulkButton>
          <BulkButton disabled={busy} onClick={() => onApply("set-priority", { priority: "LOW" })}>
            Low
          </BulkButton>
          <BulkButton disabled={busy} danger onClick={() => onApply("archive")}>
            Archive
          </BulkButton>
          <button
            type="button"
            onClick={onClear}
            disabled={busy}
            className="h-8 rounded-md px-2.5 text-xs text-stone-500 transition hover:bg-white/5 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function BulkButton({
  children,
  danger = false,
  disabled,
  onClick,
}: {
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-8 rounded-md border px-2.5 text-xs font-medium transition disabled:opacity-50 ${
        danger
          ? "border-red-500/25 bg-red-500/10 text-red-200 hover:bg-red-500/15"
          : "border-white/10 bg-[#11161A] text-stone-300 hover:bg-white/5"
      }`}
    >
      {children}
    </button>
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
                ? "bg-[#FF6B4A] text-[#190B07]"
                : "border border-white/10 bg-[#11161A] text-stone-400 hover:bg-white/6 hover:text-stone-200"
            }`}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

function EmailRowItem({
  email,
  queue,
  selected,
  onToggleSelected,
}: {
  email: EmailRow;
  queue: Filter;
  selected: boolean;
  onToggleSelected: (id: string) => void;
}) {
  const unread = !email.isRead;
  const detailParams = new URLSearchParams({ markRead: "false", queue });
  return (
    <li className="grid grid-cols-[auto_1fr] gap-2">
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`Select ${email.subject || "No subject"}`}
        onClick={() => onToggleSelected(email.id)}
        className={`mt-4 h-5 w-5 rounded border transition ${
          selected
            ? "border-[#FF6B4A] bg-[#FF6B4A] shadow-[inset_0_0_0_4px_#0C1116]"
            : "border-white/15 bg-[#11161A] hover:border-white/30"
        }`}
      />
      <Link
        href={`/email/${email.id}?${detailParams.toString()}`}
        className="block rounded-lg border border-white/10 bg-[#11161A] transition hover:border-white/20 hover:bg-white/5 active:bg-white/10"
      >
        <div className="grid gap-3 p-4 md:grid-cols-[1fr_auto] md:items-start">
          <div className="min-w-0 flex-1">
            <EmailBadges email={email} unread={unread} />
            <p
              className={`mt-2 truncate text-sm ${unread ? "font-semibold text-stone-100" : "text-stone-300"}`}
            >
              {senderName(email.from)}
            </p>
            <p className="mt-1 truncate text-[13px] text-stone-400">
              {email.subject || "No subject"}
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

function EmailBadges({ email, unread }: { email: EmailRow; unread: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <PriorityBadge priority={email.priority} />
      {email.needsReply && <ReplyNeededBadge />}
      {(email.attachmentCandidateCount ?? 0) > 0 && <CandidateBadge />}
      {(email.attachmentCount ?? 0) > 0 && (
        <span className="shrink-0 rounded border border-[#7DD3FC]/30 bg-[#7DD3FC]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#7DD3FC]">
          Files {email.attachmentCount}
        </span>
      )}
      {(email.attachmentPendingCount ?? 0) > 0 && (
        <span className="shrink-0 rounded border border-stone-600 bg-stone-900/70 px-1.5 py-0.5 text-[10px] font-medium text-stone-400">
          Pending {email.attachmentPendingCount}
        </span>
      )}
      {(email.attachmentFallbackCount ?? 0) > 0 && (
        <span className="shrink-0 rounded border border-[#FF6B4A]/25 bg-[#FF6B4A]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#FF6B4A]">
          Fallback {email.attachmentFallbackCount}
        </span>
      )}
      {email.category && <CategoryBadge category={email.category} />}
      {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#FF6B4A]" />}
    </div>
  );
}

function ThreadRowItem({ thread }: { thread: ThreadRow }) {
  return (
    <li>
      <Link
        href={`/email/${thread.lastMessage.id}?markRead=false`}
        className="block rounded-lg border border-white/10 bg-[#11161A] transition hover:border-white/20 hover:bg-white/5 active:bg-white/10"
      >
        <div className="grid gap-3 p-4 md:grid-cols-[1fr_auto] md:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <PriorityBadge priority={thread.latestPriority} />
              {thread.hasUnread && (
                <span className="rounded border border-[#FF6B4A]/30 bg-[#FF6B4A]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#FF6B4A]">
                  Unread
                </span>
              )}
              <span className="rounded border border-stone-700 bg-stone-900/60 px-1.5 py-0.5 text-[10px] text-stone-400">
                {thread.messageCount} messages
              </span>
            </div>
            <p className="mt-2 truncate text-sm font-semibold text-stone-100">
              {thread.subject || "No subject"}
            </p>
            <p className="mt-1 truncate text-[12px] text-stone-500">
              {thread.participants.map(senderName).join(", ")}
            </p>
            {thread.summary ? (
              <p className="mt-2 line-clamp-2 text-xs leading-5 text-stone-400">{thread.summary}</p>
            ) : thread.lastMessage.snippet ? (
              <p className="mt-2 line-clamp-2 text-xs leading-5 text-stone-600">
                {thread.lastMessage.snippet}
              </p>
            ) : null}
          </div>
          <time className="shrink-0 text-[11px] tabular-nums text-stone-500 md:pt-1">
            {formatRelative(thread.lastMessage.receivedAt)}
          </time>
        </div>
      </Link>
    </li>
  );
}

function CandidatePreview({ profile }: { profile: CandidateProfilePreview }) {
  const title = [profile.name || "Name missing", profile.role].filter(Boolean).join(" · ");
  const missing =
    profile.missingFields.length > 0
      ? `Needs: ${profile.missingFields.map(candidateMissingLabel).join(", ")}`
      : null;
  return (
    <div className="mt-2 rounded-lg border border-orange-500/15 bg-orange-500/5 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[11px] font-medium text-[#FFB09C]">{title}</p>
        <span className="shrink-0 text-[10px] tabular-nums text-[#FF8A70]/80">
          {Math.round(profile.confidence * 100)}%
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-stone-400">{profile.summary}</p>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-stone-500">
        {profile.contact && <span className="truncate">Contact {profile.contact}</span>}
        {profile.intakeStatus && <span>{candidateIntakeLabel(profile.intakeStatus)}</span>}
        <span>Files {profile.evidenceCount}</span>
        {missing && <span className="text-[#FF6B4A]/80">{missing}</span>}
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
    name: "Name",
    contact: "Contact",
    role: "Role",
    portfolio: "Portfolio",
  };
  return labels[field] || field;
}
function ReplyNeededBadge() {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#FF6B4A]/30 bg-[#FF6B4A]/10 text-[#FF6B4A] font-medium shrink-0">
      Needs reply
    </span>
  );
}

function CandidateBadge() {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#FF6B4A]/30 bg-[#FF6B4A]/10 text-[#FF8A70] font-medium shrink-0">
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
  if (diffMin < 1) return "just now";
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
