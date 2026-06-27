"use client";

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { ComposeModal } from "../../components/compose-modal";
import { useToast } from "../../components/toast";
import { TrustDot, type TrustScoreData } from "../../components/trust-badge";
import { apiFetch } from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";
import { formatRelative } from "../../lib/text";

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
  senderEmail?: string | null;
  trust?: TrustScoreData | null;
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
type EmailReminderKey = "later-today" | "tomorrow" | "next-week";

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

interface EmailReminderOption {
  key: EmailReminderKey;
  label: string;
}

const EMAIL_REMINDER_OPTIONS: EmailReminderOption[] = [
  { key: "later-today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "next-week", label: "Next week" },
];

function getReminderDate(option: EmailReminderKey): Date {
  const date = new Date();
  if (option === "later-today") {
    date.setHours(date.getHours() + 4);
    return date;
  }
  if (option === "tomorrow") {
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
    return date;
  }
  date.setDate(date.getDate() + 7);
  date.setHours(9, 0, 0, 0);
  return date;
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

// Domain triage tiles. Counts were intentionally removed: the old
// `count(emails)` only matched the rows already loaded into the infinite
// list, so "Current signals N" understated the true total and shrank/grew as
// the user scrolled. An accurate per-domain total needs a server endpoint;
// until then these are honest navigation tiles, not metrics.
const WORK_QUEUES: Array<{
  key: Filter;
  title: string;
  description: string;
}> = [
  {
    key: "finance",
    title: "Finance docs",
    description: "Billing, invoices, failed payments, contract amounts",
  },
  {
    key: "legal",
    title: "Legal review",
    description: "Contracts, compliance, signatures, risk",
  },
  {
    key: "sales",
    title: "Revenue and customers",
    description: "Customer replies, renewals, pricing, meeting follow-up",
  },
  {
    key: "support",
    title: "Support issues",
    description: "Bugs, incidents, complaints, escalations",
  },
];

// Domain filters surfaced as WORK_QUEUES cards below — kept out of the pill
// row so the two navigation models stop duplicating each other.
const DOMAIN_FILTER_KEYS: Filter[] = ["finance", "legal", "sales", "support"];

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
  const undoNotice = useMemo(() => parseUndoNotice(searchParams), [searchParams]);
  const queryClient = useQueryClient();
  // The page promises "mail that needs a reply" — default to the matching
  // filter so users don't land on a full-noise All view that contradicts the
  // headline. A user with no reply-needed mail still has every other tab
  // available one click away.
  const [filter, setFilter] = useState<Filter>("reply-needed");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [bulkUndoNotice, setBulkUndoNotice] = useState<BulkUndoNotice | null>(null);
  const [rowReminderBusy, setRowReminderBusy] = useState<string | null>(null);
  const [undoCountdown, setUndoCountdown] = useState(0);
  const [bulkUndoCountdown, setBulkUndoCountdown] = useState(0);

  // filter + search drive the cached query key. /api/email/threads and
  // /api/email return discriminated shapes so we route the query body on
  // filter === "threads". useInfiniteQuery accumulates pages so the user
  // can keep loading past the 20-row default cap.
  // Match the API pageSize bump. Heavy-email users were clicking through
  // /api/email pages of 20 ten times to see one morning's intake.
  const PAGE_SIZE = 50;
  const listQuery = useInfiniteQuery({
    queryKey: queryKeys.email.list({ filter, search: appliedSearch }),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const q = FILTERS.find((x) => x.key === filter)?.query || "";
      const params = new URLSearchParams(q);
      if (appliedSearch.trim()) params.set("search", appliedSearch.trim());
      const pageNum = typeof pageParam === "number" ? pageParam : 1;
      params.set("page", String(pageNum));
      try {
        if (filter === "threads") {
          const data = await apiFetch<ThreadListResponse>(
            `/api/email/threads?${params.toString()}`,
          );
          return {
            kind: "threads" as const,
            threads: data.threads,
            source: data.source,
            total: data.total,
            page: pageNum,
          };
        }
        const data = await apiFetch<ListResponse>(`/api/email?${params.toString()}`);
        return {
          kind: "list" as const,
          emails: data.emails,
          source: data.source,
          total: data.total,
          page: pageNum,
        };
      } catch (err) {
        captureClientError(err, { scope: "email.load", filter, page: pageNum });
        throw err;
      }
    },
    getNextPageParam: (lastPage) => {
      const seen = lastPage.page * PAGE_SIZE;
      return seen < lastPage.total ? lastPage.page + 1 : undefined;
    },
  });

  const pages = listQuery.data?.pages ?? [];
  const emails = pages.flatMap((p) => (p.kind === "list" ? p.emails : []));
  const threads = pages.flatMap((p) => (p.kind === "threads" ? p.threads : []));
  const source = pages[0]?.source ?? null;
  const totalAvailable = pages[pages.length - 1]?.total ?? 0;
  const loading = listQuery.isLoading;

  useEffect(() => {
    if (listQuery.error) {
      setError("Could not load mail.");
    }
  }, [listQuery.error]);

  // Bulk action mutations still call set* on local UI state; for the
  // server-derived list we invalidate the keyed query to refetch.
  const load = (_f: Filter, _keyword = "") => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.email.all });
  };

  // Reset selection whenever the filter / search changes (the keyed
  // query already refetches automatically).
  useEffect(() => {
    setSelectedIds(new Set());
  }, []);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAppliedSearch(search.trim());
  };

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    try {
      const result = await apiFetch<{ synced?: number; newCount?: number }>("/api/email/sync", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await load(filter, appliedSearch);
      const newCount = typeof result?.newCount === "number" ? result.newCount : 0;
      const synced = typeof result?.synced === "number" ? result.synced : 0;
      if (newCount > 0) {
        toast(`Synced ${synced} — ${newCount} new.`, "success");
      } else if (synced > 0) {
        toast(`Synced ${synced} — nothing new.`, "success");
      } else {
        toast("Sync complete. Nothing new.", "success");
      }
    } catch (err) {
      captureClientError(err, { scope: "email.sync" });
      const message = err instanceof Error ? err.message : "";
      if (message.toLowerCase().includes("not connected")) {
        setError("Gmail isn't connected. Reconnect in Settings → Connections.");
        toast("Gmail isn't connected.", "error");
      } else {
        setError("Gmail sync failed. Check Settings → Connections to reconnect.");
        toast("Gmail sync failed.", "error");
      }
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
      // Update each cached page optimistically for the current filter,
      // then invalidate so a background refetch pulls truth.
      queryClient.setQueryData<typeof listQuery.data>(
        queryKeys.email.list({ filter, search: appliedSearch }),
        (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            pages: prev.pages.map((page) =>
              page.kind === "list"
                ? {
                    ...page,
                    emails: updateEmailsAfterBulk(page.emails, ids, action, options.priority),
                  }
                : page,
            ),
          };
        },
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.email.all });
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

  const UNDO_DISMISS_SECONDS = 8;

  useEffect(() => {
    if (!undoNotice) return;
    setUndoCountdown(UNDO_DISMISS_SECONDS);
    const id = setInterval(() => {
      setUndoCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          router.replace("/email");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [undoNotice, router]);

  useEffect(() => {
    if (!bulkUndoNotice) return;
    setBulkUndoCountdown(UNDO_DISMISS_SECONDS);
    const id = setInterval(() => {
      setBulkUndoCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          setBulkUndoNotice(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [bulkUndoNotice]);

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

  const createRowReminder = async (email: EmailRow, option: EmailReminderOption) => {
    const busyKey = `${email.id}:${option.key}`;
    if (rowReminderBusy) return;
    setRowReminderBusy(busyKey);
    setError(null);
    try {
      const remindAt = getReminderDate(option.key);
      await apiFetch("/api/reminders", {
        method: "POST",
        body: JSON.stringify({
          title: `${email.needsReply ? "Reply to" : "Review"}: ${email.subject || "No subject"}`,
          remindAt: remindAt.toISOString(),
          description: [`From: ${email.from}`, `Open: /email/${email.id}`].join("\n"),
        }),
      });
      toast(`Reminder set for ${option.label.toLowerCase()}.`, "success");
    } catch (err) {
      captureClientError(err, {
        scope: "email.list.reminder",
        emailId: email.id,
        option: option.key,
      });
      setError("Could not create a reminder for that email.");
    } finally {
      setRowReminderBusy(null);
    }
  };

  const unreadCount = emails.filter((email) => !email.isRead).length;
  const urgentCount = emails.filter((email) => email.priority === "URGENT").length;
  const replyCount = emails.filter((email) => email.needsReply).length;
  const candidateCount = emails.filter((email) => (email.attachmentCandidateCount ?? 0) > 0).length;
  const attachmentCount = emails.filter((email) => (email.attachmentCount ?? 0) > 0).length;

  return (
    <>
      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} />

      {/* MOBILE — purpose-built native mail (desktop layout untouched below) */}
      <div className="px-4 pb-28 pt-3 md:hidden">
        <header className="mb-4 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[28px] font-bold leading-none tracking-tight text-stone-50">
              Mail
            </h1>
            <p className="mt-1.5 text-sm text-stone-400">
              {source === "demo"
                ? "Demo data — connect Gmail"
                : replyCount > 0
                  ? `${replyCount} need a reply`
                  : unreadCount > 0
                    ? `${unreadCount} unread`
                    : "All caught up"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setComposeOpen(true)}
            disabled={source === "demo"}
            aria-label="Compose"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-amber-400 text-stone-950 transition active:bg-amber-300 disabled:opacity-40"
          >
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
        </header>

        <form onSubmit={submitSearch} className="mb-3 flex gap-2">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search mail"
            className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-stone-900/60 px-4 text-sm text-stone-200 outline-none transition placeholder:text-stone-600 focus:border-accent/45"
          />
          {appliedSearch && (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setAppliedSearch("");
              }}
              className="shrink-0 rounded-xl border border-white/10 px-3 text-xs text-stone-400 transition active:bg-white/5"
            >
              Clear
            </button>
          )}
        </form>

        <FilterTabs current={filter} onChange={setFilter} />

        {loading && (
          <div className="mt-3 space-y-2">
            <div className="h-16 animate-pulse rounded-2xl bg-stone-900/50" />
            <div className="h-16 animate-pulse rounded-2xl bg-stone-900/40" />
            <div className="h-16 animate-pulse rounded-2xl bg-stone-900/30" />
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {!loading && !error && filter !== "threads" && emails.length === 0 && (
          <div className="mt-6 rounded-2xl bg-stone-900/40 px-6 py-12 text-center">
            <p className="text-base font-medium text-stone-200">
              {filter === "reply-needed" ? "Nothing needs a reply" : "No mail here"}
            </p>
            <p className="mx-auto mt-1.5 max-w-xs text-[13px] leading-relaxed text-stone-500">
              {source === "demo"
                ? "Connect Gmail in Settings so Klorn can sort your real mail."
                : "When Klorn finds mail that needs you, it rises to the top."}
            </p>
            <button
              type="button"
              onClick={syncNow}
              disabled={syncing}
              className="mt-5 inline-flex min-h-11 items-center rounded-xl border border-stone-700 px-5 text-sm text-stone-300 transition active:bg-stone-800 disabled:opacity-50"
            >
              {syncing ? "Syncing..." : "Sync now"}
            </button>
          </div>
        )}

        {!loading && filter !== "threads" && emails.length > 0 && (
          <ul className="mt-3 space-y-2">
            {emails.map((e) => (
              <MobileEmailRow key={e.id} email={e} queue={filter} />
            ))}
          </ul>
        )}

        {!loading && !error && emails.length > 0 && listQuery.hasNextPage && (
          <button
            type="button"
            onClick={() => listQuery.fetchNextPage()}
            disabled={listQuery.isFetchingNextPage}
            className="mt-4 flex min-h-11 w-full items-center justify-center rounded-xl border border-stone-800 text-sm text-stone-400 transition active:bg-stone-800/60 disabled:opacity-50"
          >
            {listQuery.isFetchingNextPage ? "Loading..." : "Load more"}
          </button>
        )}
      </div>

      {/* DESKTOP — unchanged */}
      <div className="mx-auto hidden w-full max-w-5xl px-4 pb-28 pt-6 md:block md:py-10">
        {/* Mobile = content-first: a compact title + small action row, with the
            description, the 4-stat dashboard, and Reanalyze hidden until md so the
            mail list isn't pushed off-screen. Desktop (md:+) keeps the full hero. */}
        <header className="mb-4 rounded-lg border border-white/10 bg-stone-900/40 p-4 shadow-xl shadow-black/10 md:mb-5 md:p-6">
          <div className="flex flex-col gap-3 md:gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80 md:mb-2">
                Klorn · Mail
              </p>
              <h1 className="text-lg font-semibold tracking-tight text-stone-50 md:text-2xl">
                Mail that needs a reply
              </h1>
              <p className="mt-2 hidden max-w-xl text-sm leading-6 text-stone-400 md:block">
                Sorted by urgency and reply-needed signal.
                {source === "demo" && <span className="ml-2 text-accent">Demo data</span>}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setComposeOpen(true)}
                disabled={source === "demo"}
                title={source === "demo" ? "Connect Gmail to send email" : "Compose a new email"}
                className="min-h-11 w-fit rounded-md bg-accent px-3 text-xs font-semibold text-stone-950 transition hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                ✎ Compose
              </button>
              <button
                type="button"
                onClick={syncNow}
                disabled={syncing}
                className="min-h-11 w-fit rounded-md border border-white/10 bg-stone-950/60 px-3 text-xs font-medium text-stone-300 transition hover:border-white/20 hover:bg-white/5 hover:text-stone-100 disabled:opacity-50"
              >
                {syncing ? "Syncing..." : "Sync now"}
              </button>
              <button
                type="button"
                onClick={reanalyzeAttachments}
                disabled={reanalyzing}
                className="hidden min-h-11 w-fit rounded-md border border-[#a8a29e]/25 bg-[#a8a29e]/10 px-3 text-xs font-medium text-stone-200 transition hover:bg-[#a8a29e]/15 disabled:opacity-50 md:inline-flex md:items-center"
              >
                {reanalyzing ? "Analyzing..." : "Reanalyze attachments"}
              </button>
            </div>
          </div>
          <div className="mt-5 hidden grid-cols-4 overflow-hidden rounded-md border border-white/10 bg-stone-950/60 md:grid">
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
            countdown={undoCountdown}
            onDismiss={dismissUndoNotice}
            onUndo={undoLastAction}
          />
        )}

        {bulkUndoNotice && (
          <BulkUndoActionBanner
            notice={bulkUndoNotice}
            busy={undoBusy}
            countdown={bulkUndoCountdown}
            onDismiss={dismissBulkUndoNotice}
            onUndo={undoBulkArchive}
          />
        )}

        <form onSubmit={submitSearch} className="mb-3 flex gap-2">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search mail, attachments, fields"
            className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-stone-950/60 px-3 text-sm text-stone-200 outline-none transition placeholder:text-stone-600 focus:border-accent/45"
          />
          <button
            type="submit"
            className="h-10 rounded-lg bg-accent px-4 text-sm font-medium text-stone-950 transition hover:bg-accent-muted"
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
              className="h-10 rounded-lg border border-white/10 bg-stone-900/40 px-3 text-xs text-stone-400 transition hover:bg-white/5"
            >
              Clear
            </button>
          )}
        </form>

        <FilterTabs current={filter} onChange={setFilter} />

        {/* Work queues: on phones these stack into 4 tall cards that bury the mail
          list, so render them as a compact horizontal-scroll chip row on mobile
          (title only) and keep the full 4-up grid with descriptions on md+. */}
        <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:grid md:grid-cols-4 md:overflow-visible md:px-0 md:pb-0 [&::-webkit-scrollbar]:hidden">
          {WORK_QUEUES.map((queue) => (
            <button
              key={queue.key}
              type="button"
              onClick={() => setFilter(queue.key)}
              className={`shrink-0 rounded-lg border px-3 py-2 text-left transition md:shrink md:p-3 ${
                filter === queue.key
                  ? "border-accent/45 bg-accent/10"
                  : "border-white/10 bg-stone-900/40 hover:border-white/20 hover:bg-white/5"
              }`}
            >
              <span className="flex items-center gap-1.5 whitespace-nowrap text-sm font-medium text-stone-100 md:justify-between md:gap-2">
                {queue.title}
                <span className="text-accent-light" aria-hidden="true">
                  →
                </span>
              </span>
              <span className="mt-1 hidden text-[11px] leading-4 text-stone-500 md:block">
                {queue.description}
              </span>
            </button>
          ))}
        </div>

        {candidateCount > 0 && (
          <Link
            href="/email/candidates"
            className="mt-3 flex items-center justify-between rounded-lg border border-orange-500/20 bg-orange-500/5 px-4 py-3 text-sm text-accent-muted transition hover:bg-orange-500/10"
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
          <div className="mt-4 rounded-lg border border-white/10 bg-stone-900/40 p-6 text-center">
            <p className="text-sm text-stone-300">
              {filter === "all"
                ? "No mail signals yet."
                : filter === "reply-needed"
                  ? "Nothing needs a reply right now."
                  : "No signals match this filter."}
            </p>
            <p className="mt-1 text-xs text-stone-600">
              {filter === "reply-needed"
                ? "Switch tabs to see urgent, unread, or all mail — Klorn promotes a thread here when it detects something you should answer."
                : "After sync, mail that needs action rises to the top."}
            </p>
            {filter === "reply-needed" && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setFilter("all")}
                  className="inline-flex min-h-11 items-center rounded-md border border-white/10 px-4 text-xs font-medium text-stone-300 transition hover:border-white/20 hover:text-stone-100"
                >
                  Show all signals
                </button>
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
            {filter === "all" && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Link
                  href="/settings"
                  className="inline-flex min-h-11 items-center rounded-md bg-accent-light px-4 text-xs font-medium text-stone-950 transition hover:bg-accent-muted"
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
                reminderBusyKey={rowReminderBusy}
                selected={selectedIds.has(e.id)}
                onCreateReminder={createRowReminder}
                onToggleSelected={toggleSelected}
              />
            ))}
          </ul>
        )}

        {!loading && filter === "threads" && threads.length === 0 && !error && (
          <div className="mt-4 rounded-lg border border-white/10 bg-stone-900/40 p-6 text-center">
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

        {!loading && !error && (emails.length > 0 || threads.length > 0) && (
          <LoadMoreBar
            loadedCount={emails.length + threads.length}
            totalAvailable={totalAvailable}
            isFetching={listQuery.isFetchingNextPage}
            hasNext={!!listQuery.hasNextPage}
            onLoadMore={() => listQuery.fetchNextPage()}
          />
        )}
      </div>
    </>
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
  countdown,
  onDismiss,
  onUndo,
}: {
  notice: UndoNotice;
  busy: boolean;
  countdown: number;
  onDismiss: () => void;
  onUndo: () => void;
}) {
  const actionLabel = notice.action === "archive" ? "archived" : "moved to trash";
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-accent-light/30 bg-amber-950/30 px-4 py-3 text-sm text-stone-200 shadow-lg shadow-black/10 sm:flex-row sm:items-center sm:justify-between">
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
          className="min-h-10 rounded-md bg-accent-light px-3 text-xs font-semibold text-stone-950 transition hover:bg-accent-muted disabled:opacity-50"
        >
          {busy ? "Restoring..." : "Undo"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="min-h-10 rounded-md border border-white/10 px-3 text-xs text-stone-300 transition hover:bg-white/5 disabled:opacity-50"
        >
          Dismiss {countdown > 0 && `(${countdown}s)`}
        </button>
      </div>
    </div>
  );
}

function BulkUndoActionBanner({
  notice,
  busy,
  countdown,
  onDismiss,
  onUndo,
}: {
  notice: BulkUndoNotice;
  busy: boolean;
  countdown: number;
  onDismiss: () => void;
  onUndo: () => void;
}) {
  const count = notice.emails.length;
  const preview = notice.emails
    .slice(0, 2)
    .map((email) => email.subject)
    .join(", ");
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-accent-light/30 bg-amber-950/30 px-4 py-3 text-sm text-stone-200 shadow-lg shadow-black/10 sm:flex-row sm:items-center sm:justify-between">
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
          className="min-h-10 rounded-md bg-accent-light px-3 text-xs font-semibold text-stone-950 transition hover:bg-accent-muted disabled:opacity-50"
        >
          {busy ? "Restoring..." : "Undo all"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="min-h-10 rounded-md border border-white/10 px-3 text-xs text-stone-300 transition hover:bg-white/5 disabled:opacity-50"
        >
          Dismiss {countdown > 0 && `(${countdown}s)`}
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
    <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-stone-950/70 px-3 py-2 md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleAll}
          className="h-8 rounded-md border border-white/10 bg-stone-900/40 px-2.5 text-xs font-medium text-stone-300 transition hover:bg-white/5"
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
          : "border-white/10 bg-stone-900/40 text-stone-300 hover:bg-white/5"
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
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {FILTERS.filter((f) => !DOMAIN_FILTER_KEYS.includes(f.key)).map((f) => {
        const active = f.key === current;
        return (
          <button
            key={f.key}
            type="button"
            onClick={() => onChange(f.key)}
            className={`min-h-[32px] shrink-0 rounded-full px-3 py-1.5 text-xs transition ${
              active
                ? "bg-accent text-stone-950"
                : "border border-white/10 bg-stone-900/40 text-stone-400 hover:bg-white/6 hover:text-stone-200"
            }`}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

function LoadMoreBar({
  loadedCount,
  totalAvailable,
  isFetching,
  hasNext,
  onLoadMore,
}: {
  loadedCount: number;
  totalAvailable: number;
  isFetching: boolean;
  hasNext: boolean;
  onLoadMore: () => void;
}) {
  // Auto-fetch when the bar scrolls into view. Sentinel sits at the same
  // node as the bar itself; rootMargin pre-loads ~400px before the user
  // hits the bottom so the perceived scroll is continuous. The manual
  // 'Load more' button stays as a fallback for keyboard / a11y users and
  // for the rare case where IntersectionObserver is throttled by the
  // browser (e.g. background tab).
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasNext || isFetching) return;
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onLoadMore();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNext, isFetching, onLoadMore]);

  return (
    <div
      ref={sentinelRef}
      className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-stone-800 bg-stone-950/50 px-4 py-3 text-xs text-stone-500"
    >
      <span>
        Showing {loadedCount}
        {totalAvailable > loadedCount ? ` of ${totalAvailable}` : ""}
      </span>
      {hasNext ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={isFetching}
          className="rounded-md border border-stone-700 px-3 py-1.5 text-xs text-stone-300 transition hover:border-amber-300/40 hover:text-amber-200 disabled:opacity-50"
        >
          {isFetching ? "Loading…" : "Load more"}
        </button>
      ) : (
        <span className="text-stone-600">All loaded.</span>
      )}
    </div>
  );
}

function EmailRowItem({
  email,
  reminderBusyKey,
  queue,
  selected,
  onCreateReminder,
  onToggleSelected,
}: {
  email: EmailRow;
  reminderBusyKey: string | null;
  queue: Filter;
  selected: boolean;
  onCreateReminder: (email: EmailRow, option: EmailReminderOption) => void;
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
            ? "border-accent bg-accent shadow-[inset_0_0_0_4px_#0C1116]"
            : "border-white/15 bg-stone-900/40 hover:border-white/30"
        }`}
      />
      <div className="overflow-hidden rounded-lg border border-white/10 bg-stone-900/40 transition hover:border-white/20">
        <Link
          href={`/email/${email.id}?${detailParams.toString()}`}
          className="block transition hover:bg-white/5 active:bg-white/10"
        >
          <div className="grid gap-3 p-4 md:grid-cols-[1fr_auto] md:items-start">
            <div className="min-w-0 flex-1">
              <EmailBadges email={email} unread={unread} />
              <div
                className={`mt-2 flex items-center gap-1.5 text-sm ${unread ? "font-semibold text-stone-100" : "text-stone-300"}`}
              >
                <TrustDot trust={email.trust} />
                <span className="truncate">{senderName(email.from)}</span>
              </div>
              <p className="mt-1 truncate text-[13px] text-stone-400">
                {email.subject || "No subject"}
              </p>
              {email.summary ? (
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-stone-400">
                  <span className="mr-1 text-stone-500">Summary:</span>
                  {email.summary}
                </p>
              ) : email.snippet ? (
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-stone-600">
                  {email.snippet}
                </p>
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
        <EmailRowReminderActions
          email={email}
          busyKey={reminderBusyKey}
          onCreateReminder={onCreateReminder}
        />
      </div>
    </li>
  );
}

function EmailRowReminderActions({
  busyKey,
  email,
  onCreateReminder,
}: {
  busyKey: string | null;
  email: EmailRow;
  onCreateReminder: (email: EmailRow, option: EmailReminderOption) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-white/10 px-4 py-2 text-[11px] text-stone-500">
      <span className="mr-1">Remind</span>
      {EMAIL_REMINDER_OPTIONS.map((option) => {
        const key = `${email.id}:${option.key}`;
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => onCreateReminder(email, option)}
            disabled={busyKey !== null}
            className="min-h-8 rounded-md border border-white/10 bg-black/15 px-2.5 text-[11px] text-stone-400 transition hover:border-[#a8a29e]/35 hover:text-stone-100 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busyKey === key ? "Setting..." : option.label}
          </button>
        );
      })}
    </div>
  );
}

function EmailBadges({ email, unread }: { email: EmailRow; unread: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <PriorityBadge priority={email.priority} />
      {email.needsReply && <ReplyNeededBadge />}
      {(email.attachmentCandidateCount ?? 0) > 0 && <CandidateBadge />}
      {(email.attachmentCount ?? 0) > 0 && (
        <span className="shrink-0 rounded border border-[#a8a29e]/30 bg-[#a8a29e]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#a8a29e]">
          Files {email.attachmentCount}
        </span>
      )}
      {(email.attachmentPendingCount ?? 0) > 0 && (
        <span className="shrink-0 rounded border border-stone-600 bg-stone-900/70 px-1.5 py-0.5 text-[10px] font-medium text-stone-400">
          Pending {email.attachmentPendingCount}
        </span>
      )}
      {(email.attachmentFallbackCount ?? 0) > 0 && (
        <span className="shrink-0 rounded border border-accent/25 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
          Fallback {email.attachmentFallbackCount}
        </span>
      )}
      {email.category && <CategoryBadge category={email.category} />}
      {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
    </div>
  );
}

function ThreadRowItem({ thread }: { thread: ThreadRow }) {
  return (
    <li>
      <Link
        href={`/email/${thread.lastMessage.id}?markRead=false`}
        className="block rounded-lg border border-white/10 bg-stone-900/40 transition hover:border-white/20 hover:bg-white/5 active:bg-white/10"
      >
        <div className="grid gap-3 p-4 md:grid-cols-[1fr_auto] md:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <PriorityBadge priority={thread.latestPriority} />
              {thread.hasUnread && (
                <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
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
        <p className="truncate text-[11px] font-medium text-accent-muted">{title}</p>
        <span className="shrink-0 text-[10px] tabular-nums text-accent-light/80">
          {Math.round(profile.confidence * 100)}%
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-stone-400">{profile.summary}</p>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-stone-500">
        {profile.contact && <span className="truncate">Contact {profile.contact}</span>}
        {profile.intakeStatus && <span>{candidateIntakeLabel(profile.intakeStatus)}</span>}
        <span>Files {profile.evidenceCount}</span>
        {missing && <span className="text-accent/80">{missing}</span>}
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
    <span className="text-[10px] px-1.5 py-0.5 rounded border border-accent/30 bg-accent/10 text-accent font-medium shrink-0">
      Needs reply
    </span>
  );
}

function CandidateBadge() {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded border border-accent/30 bg-accent/10 text-accent-light font-medium shrink-0">
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

// ─── Mobile native mail row ─────────────────────────────────────────────────
//
// A clean phone list row (not the desktop card with checkbox + reminder band).
// Bulk-select, threads, and per-row reminders stay desktop-only.

function MobileEmailRow({ email, queue }: { email: EmailRow; queue: Filter }) {
  const unread = !email.isRead;
  const params = new URLSearchParams({ markRead: "false", queue });
  const preview = email.summary || email.snippet;
  return (
    <li>
      <Link
        href={`/email/${email.id}?${params.toString()}`}
        className="flex gap-3 rounded-2xl bg-stone-900/50 px-4 py-3 transition active:bg-stone-800/60"
      >
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${unread ? "bg-amber-400" : "bg-transparent"}`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span
              className={`truncate text-[15px] ${unread ? "font-semibold text-stone-50" : "font-medium text-stone-300"}`}
            >
              {senderName(email.from)}
            </span>
            <time className="shrink-0 text-[11px] tabular-nums text-stone-500">
              {formatRelative(email.date)}
            </time>
          </span>
          <span
            className={`mt-0.5 block truncate text-[13px] ${unread ? "text-stone-200" : "text-stone-400"}`}
          >
            {email.subject || "No subject"}
          </span>
          {preview && (
            <span className="mt-1 line-clamp-2 block text-[12px] leading-5 text-stone-500">
              {preview}
            </span>
          )}
          {email.priority === "URGENT" && (
            <span className="mt-1.5 inline-flex items-center rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-300">
              Urgent
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}
