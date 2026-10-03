"use client";

// Wire shapes come from @klorn/contract — the same types the server builds
// (routes/email.ts and friends), so a response-shape change fails to compile
// here instead of silently desyncing. The old hand-mirrored ThreadRow had
// already drifted: it declared a `summary` the Gmail path never sent.
import type {
  EmailBulkActionResponse as BulkActionResponse,
  CandidateProfilePreview,
  EmailListItem as EmailRow,
  InboxesResponse,
  InboxOption,
  EmailListResponse as ListResponse,
  EmailThreadListResponse as ThreadListResponse,
  EmailThreadRow as ThreadRow,
  EmailUndoActionResponse as UndoActionResponse,
} from "@klorn/contract";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  type FormEvent,
  Fragment,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import AuthGuard from "../../components/auth-guard";
import { ComposeModal } from "../../components/compose-modal";
import { LaneChip } from "../../components/lane-chip";
import { ListSkeleton } from "../../components/skeleton";
import { useToast } from "../../components/toast";
import { TrustDot, type TrustScoreData } from "../../components/trust-badge";
import ErrorAlert from "../../components/ui/error-alert";
import { apiFetch } from "../../lib/api";
import { useT } from "../../lib/i18n";
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

type BulkAction = "mark-read" | "mark-unread" | "archive" | "set-priority";

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

// `labelKey` (when present) resolves through t() in FilterTabs; `label` is the
// untranslated fallback for the domain filters that never render in the pill row.
const FILTERS: { key: Filter; label: string; labelKey?: string; query: string }[] = [
  { key: "all", label: "All signals", labelKey: "mail.filterAll", query: "" },
  {
    key: "reply-needed",
    label: "Needs reply",
    labelKey: "mail.filterReplyNeeded",
    query: "filter=reply-needed",
  },
  { key: "urgent", label: "Urgent", labelKey: "mail.filterUrgent", query: "filter=urgent" },
  { key: "unread", label: "Unread", labelKey: "mail.filterUnread", query: "filter=unread" },
  {
    key: "attachments",
    label: "Attachments",
    labelKey: "mail.filterAttachments",
    query: "filter=attachments",
  },
  {
    key: "candidates",
    label: "Candidates",
    labelKey: "mail.filterCandidates",
    query: "filter=candidates",
  },
  { key: "finance", label: "Finance", query: "category=billing" },
  { key: "legal", label: "Legal", query: "search=contract" },
  { key: "sales", label: "Sales", query: "category=business" },
  { key: "support", label: "Support", query: "search=support" },
  { key: "threads", label: "Threads", labelKey: "mail.filterThreads", query: "" },
  {
    key: "automated",
    label: "Automated",
    labelKey: "mail.filterAutomated",
    query: "category=automated",
  },
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
  const { t } = useT();
  const { toast } = useToast();
  const undoNotice = useMemo(() => parseUndoNotice(searchParams), [searchParams]);
  const queryClient = useQueryClient();
  // The page promises "mail that needs a reply" — default to the matching
  // filter so users don't land on a full-noise All view that contradicts the
  // headline. A user with no reply-needed mail still has every other tab
  // available one click away.
  const [filter, setFilter] = useState<Filter>("reply-needed");
  // Which mailbox the list is scoped to: "all" (default), "primary", or a linked
  // inbox id. Only surfaced once the user actually has more than one inbox.
  const [inbox, setInbox] = useState<string>("all");
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
  const [rowQuickBusy, setRowQuickBusy] = useState<string | null>(null);
  const [undoCountdown, setUndoCountdown] = useState(0);
  const [bulkUndoCountdown, setBulkUndoCountdown] = useState(0);

  // filter + search drive the cached query key. /api/email/threads and
  // /api/email return discriminated shapes so we route the query body on
  // filter === "threads". useInfiniteQuery accumulates pages so the user
  // can keep loading past the 20-row default cap.
  // Match the API pageSize bump. Heavy-email users were clicking through
  // /api/email pages of 20 ten times to see one morning's intake.
  const PAGE_SIZE = 50;
  // The user's mailboxes for the inbox selector + per-message badges. Cheap,
  // rarely changes, and read-only — never blocks the list.
  const inboxesQuery = useQuery({
    queryKey: queryKeys.email.inboxes(),
    queryFn: () => apiFetch<InboxesResponse>("/api/email/inboxes"),
    staleTime: 5 * 60 * 1000,
  });
  const inboxes = inboxesQuery.data?.inboxes ?? [];
  const linkedInboxes = inboxes.filter((i) => i.kind === "linked");
  // Map linkedInboxAccountId → address so a row can show which inbox it hit.
  const inboxLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of inboxes) {
      if (i.id && i.email) map.set(i.id, i.email);
    }
    return map;
  }, [inboxes]);
  const primaryLabel = inboxes.find((i) => i.kind === "primary")?.email ?? null;
  // Only show inbox badges/selector once there is more than one mailbox — a
  // single-inbox user gets no extra chrome.
  const showInboxBadges = linkedInboxes.length > 0;
  const resolveInboxLabel = (row: EmailRow): string | null => {
    if (!showInboxBadges) return null;
    if (row.linkedInboxAccountId)
      return inboxLabelById.get(row.linkedInboxAccountId) ?? "Linked inbox";
    return primaryLabel;
  };

  const listQuery = useInfiniteQuery({
    queryKey: queryKeys.email.list({ filter, search: appliedSearch, inbox }),
    // Safety net for real-time: new mail is announced over the WebSocket, but
    // a missed frame (socket blip, backgrounded tab) used to strand the list
    // until manual Sync. Poll while the tab is visible.
    refetchInterval: 30_000,
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const q = FILTERS.find((x) => x.key === filter)?.query || "";
      const params = new URLSearchParams(q);
      if (appliedSearch.trim()) params.set("search", appliedSearch.trim());
      if (inbox !== "all") params.set("inbox", inbox);
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

  // Reset selection whenever the filter / applied search / inbox changes (the
  // keyed query already refetches automatically). The deps MUST list every
  // dimension that drives the visible row set — filter, appliedSearch, AND inbox
  // — otherwise a stale selection could survive the change and a bulk action
  // would archive/delete rows no longer visible in the list (data-loss adjacent).
  useEffect(() => {
    setSelectedIds(new Set());
  }, [filter, appliedSearch, inbox]);

  // Real-time auto-sync: when new mail lands, gmail-push emits
  // conversations-updated (NotificationBell bridges the WS message to this
  // window event), so refetch the list automatically — no manual "Sync".
  useEffect(() => {
    const handler = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.email.all });
    };
    window.addEventListener("conversations-updated", handler);
    return () => window.removeEventListener("conversations-updated", handler);
  }, [queryClient]);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAppliedSearch(search.trim());
  };

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    try {
      const result = await apiFetch<{ synced?: number; newCount?: number; error?: string }>(
        "/api/email/sync",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      // The route answers HTTP 200 with { error } on a dead token — without
      // this branch a broken Gmail connection showed the green "Sync
      // complete" toast, which is how a founder ran for days believing the
      // account was connected (2026-08-10 diagnosis).
      if (result?.error) {
        const notConnected = result.error.toLowerCase().includes("not connected");
        setError(
          notConnected
            ? "Gmail isn't connected. Reconnect in Settings → Connections."
            : "Gmail sync failed. Check Settings → Connections to reconnect.",
        );
        toast(notConnected ? "Gmail isn't connected." : "Gmail sync failed.", "error");
        return;
      }
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
      // Update each cached page optimistically for the current view, then
      // invalidate so a background refetch pulls truth. The key MUST match the
      // live list query exactly (filter + search + inbox) or setQueryData writes
      // to a bucket nothing renders and the optimistic update is silently lost.
      queryClient.setQueryData<typeof listQuery.data>(
        queryKeys.email.list({ filter, search: appliedSearch, inbox }),
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

  // Single-row cache patch for the hover quick actions. Same query key and
  // page-map shape as applyBulkAction above (reused, not re-derived) so the
  // optimistic behaviour stays identical between the bulk bar and row buttons.
  const patchListPages = (ids: string[], action: BulkAction) => {
    queryClient.setQueryData<typeof listQuery.data>(
      queryKeys.email.list({ filter, search: appliedSearch, inbox }),
      (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          pages: prev.pages.map((page) =>
            page.kind === "list"
              ? { ...page, emails: updateEmailsAfterBulk(page.emails, ids, action) }
              : page,
          ),
        };
      },
    );
    void queryClient.invalidateQueries({ queryKey: queryKeys.email.all });
  };

  const quickArchive = async (email: EmailRow) => {
    if (rowQuickBusy) return;
    setRowQuickBusy(email.id);
    setError(null);
    try {
      const data = await apiFetch<BulkActionResponse>("/api/email/bulk", {
        method: "POST",
        body: JSON.stringify({ ids: [email.id], action: "archive" }),
      });
      if (data.failed && data.failed.length > 0) {
        toast("Could not archive that email.", "error");
        return;
      }
      patchListPages([email.id], "archive");
      setBulkUndoNotice({
        action: "archive",
        emails: [{ id: email.id, gmailId: email.gmailId, subject: email.subject || "No subject" }],
      });
    } catch (err) {
      captureClientError(err, { scope: "email.row.quickArchive", emailId: email.id });
      toast("Could not archive that email.", "error");
    } finally {
      setRowQuickBusy(null);
    }
  };

  const quickToggleRead = async (email: EmailRow) => {
    if (rowQuickBusy) return;
    const action: BulkAction = email.isRead ? "mark-unread" : "mark-read";
    setRowQuickBusy(email.id);
    setError(null);
    try {
      const data = await apiFetch<BulkActionResponse>("/api/email/bulk", {
        method: "POST",
        body: JSON.stringify({ ids: [email.id], action }),
      });
      if (data.failed && data.failed.length > 0) {
        toast("Could not update read state.", "error");
        return;
      }
      patchListPages([email.id], action);
    } catch (err) {
      captureClientError(err, { scope: "email.row.quickToggleRead", emailId: email.id, action });
      toast("Could not update read state.", "error");
    } finally {
      setRowQuickBusy(null);
    }
  };

  const unreadCount = emails.filter((email) => !email.isRead).length;
  const replyCount = emails.filter((email) => email.needsReply).length;
  const candidateCount = emails.filter((email) => (email.attachmentCandidateCount ?? 0) > 0).length;

  return (
    <>
      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} />

      {/* MOBILE — purpose-built native mail (desktop layout untouched below) */}
      <div className="px-4 pb-28 pt-3 md:hidden">
        <header className="mb-4 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-ink">
              {t("nav.mail")}
            </h1>
            <p className="mt-1.5 text-sm text-ink-mid">
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
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-solid text-accent-solid-ink transition active:bg-accent-solid-hover disabled:opacity-40"
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
            placeholder={t("mail.searchMail")}
            aria-label={t("mail.searchMail")}
            className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface-panel px-4 text-sm text-ink outline-none transition placeholder:text-ink-dim focus:border-accent/45"
          />
          {appliedSearch && (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setAppliedSearch("");
              }}
              className="shrink-0 rounded-xl border border-line px-3 text-xs text-ink-mid transition active:bg-surface-hover"
            >
              Clear
            </button>
          )}
        </form>

        <InboxSelector inboxes={inboxes} current={inbox} onChange={setInbox} />
        <FilterTabs current={filter} onChange={setFilter} />

        {loading && (
          <div className="mt-3 space-y-2">
            <div className="h-16 animate-pulse rounded-2xl bg-surface-inset" />
            <div className="h-16 animate-pulse rounded-2xl bg-surface-hover" />
            <div className="h-16 animate-pulse rounded-2xl bg-surface-raised" />
          </div>
        )}

        {error && <ErrorAlert className="mt-3">{error}</ErrorAlert>}

        {!loading && !error && filter !== "threads" && emails.length === 0 && (
          <div className="mt-6 rounded-2xl bg-surface-raised px-6 py-12 text-center">
            <p className="text-base font-medium text-ink">
              {filter === "reply-needed" ? t("mail.emptyReplyTitle") : t("mail.emptyTitle")}
            </p>
            <p className="mx-auto mt-1.5 max-w-xs text-[13px] leading-relaxed text-ink-dim">
              {source === "demo" ? t("mail.emptyDemoBody") : t("mail.emptyBody")}
            </p>
            <button
              type="button"
              onClick={syncNow}
              disabled={syncing}
              className="mt-5 inline-flex min-h-11 items-center rounded-xl border border-line px-5 text-sm text-ink-mid transition active:bg-surface-hover disabled:opacity-50"
            >
              {syncing ? t("common.syncing") : t("common.syncNow")}
            </button>
          </div>
        )}

        {!loading && filter !== "threads" && emails.length > 0 && (
          <ul className="mt-3 space-y-2">
            {emails.map((e) => (
              <MobileEmailRow
                key={e.id}
                email={e}
                queue={filter}
                inboxLabel={resolveInboxLabel(e)}
              />
            ))}
          </ul>
        )}

        {!loading && !error && emails.length > 0 && listQuery.hasNextPage && (
          <button
            type="button"
            onClick={() => listQuery.fetchNextPage()}
            disabled={listQuery.isFetchingNextPage}
            className="mt-4 flex min-h-11 w-full items-center justify-center rounded-xl border border-line text-sm text-ink-mid transition active:bg-surface-hover disabled:opacity-50"
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
        {/* Content-first header: plain text on the canvas, no boxed hero. Compose
            is the only filled control; Sync collapses to an icon and Reanalyze to
            a quiet button, so the mail list stays the visual hero. */}
        <header className="mb-6 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-ink">
                {t("nav.mail")}
              </h1>
              {source === "gmail" && (
                <span
                  title="Real-time sync is on — new mail lands in seconds"
                  className="inline-flex items-center gap-1.5 rounded-full border border-state-ok-line bg-state-ok-bg px-2 py-0.5 text-[11px] font-medium text-state-ok-ink"
                >
                  <span aria-hidden="true" className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:animate-none" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  </span>
                  Live
                </span>
              )}
            </div>
            <p className="mt-2 text-sm text-ink-mid">
              {source === "demo" ? (
                <span className="text-accent-deep">Demo data — connect Gmail in Settings</span>
              ) : replyCount > 0 ? (
                <>
                  <span className="font-medium text-ink-soft">{replyCount}</span>
                  {replyCount === 1 ? " needs a reply" : " need a reply"}
                </>
              ) : unreadCount > 0 ? (
                `${unreadCount} unread`
              ) : (
                "You're all caught up"
              )}
              {totalAvailable > 0 && (
                <span className="text-ink-dim">
                  {" "}
                  <span className="mx-0.5 text-slate-300">·</span> {totalAvailable} in view
                </span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setComposeOpen(true)}
              disabled={source === "demo"}
              title={source === "demo" ? "Connect Gmail to send email" : "Compose a new email"}
              className="glow-primary ease-strong inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent-solid px-3.5 text-sm font-medium text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg
                aria-hidden="true"
                width="15"
                height="15"
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
              {t("mail.compose")}
            </button>
            <button
              type="button"
              onClick={syncNow}
              disabled={syncing}
              aria-label={syncing ? t("common.syncing") : t("common.syncNow")}
              title={t("common.syncNow")}
              className="ease-strong inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface-panel/70 text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] disabled:opacity-50"
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
            <button
              type="button"
              onClick={reanalyzeAttachments}
              disabled={reanalyzing}
              title="Re-run attachment analysis"
              className="ease-strong hidden h-9 items-center rounded-lg border border-line bg-surface-panel/70 px-3 text-xs font-medium text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] disabled:opacity-50 lg:inline-flex"
            >
              {reanalyzing ? "Analyzing…" : "Reanalyze"}
            </button>
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

        {/* One navigation model: core filters as a segmented row with inline
            search on the right. Flat on the canvas so the list stays the hero. */}
        <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <FilterTabs current={filter} onChange={setFilter} activeCount={totalAvailable} />
          <form onSubmit={submitSearch} className="relative lg:w-72 lg:shrink-0">
            <svg
              aria-hidden="true"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-dim"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("mail.searchPlaceholder")}
              aria-label={t("mail.searchPlaceholder")}
              className="h-9 w-full rounded-lg border border-line bg-surface-panel/80 pl-9 pr-12 text-sm text-ink shadow-[0_1px_1px_rgba(15,23,42,0.03)] outline-none transition duration-150 ease-out placeholder:text-ink-dim focus:border-accent/50 focus:bg-surface-panel focus:ring-2 focus:ring-accent/15"
            />
            {!appliedSearch && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-md border border-line bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink-dim"
              >
                ⌘K
              </span>
            )}
            {appliedSearch && (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setAppliedSearch("");
                }}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-dim transition hover:bg-surface-hover hover:text-ink-muted"
              >
                <svg
                  aria-hidden="true"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </form>
        </div>

        <InboxSelector inboxes={inboxes} current={inbox} onChange={setInbox} />

        {/* Domain views — quiet chips instead of four competing cards, so they
            aid triage without burying the list. */}
        <div className="mb-4 mt-1 flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-[11px] font-medium uppercase tracking-wider text-ink-dim">
            Views
          </span>
          {WORK_QUEUES.map((queue) => {
            const active = filter === queue.key;
            return (
              <button
                key={queue.key}
                type="button"
                onClick={() => setFilter(queue.key)}
                title={queue.description}
                className={`ease-strong inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition duration-150 active:scale-[0.97] ${
                  active
                    ? "bg-accent/10 text-accent-deeper ring-1 ring-inset ring-accent/30"
                    : "text-ink-mid hover:bg-surface-panel/80 hover:text-ink hover:shadow-sm"
                }`}
              >
                {active && (
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
                )}
                {queue.title}
              </button>
            );
          })}
        </div>

        {candidateCount > 0 && (
          <Link
            href="/email/candidates"
            className="group mb-4 flex items-center justify-between gap-3 overflow-hidden rounded-xl border border-state-info-line bg-state-info-bg px-4 py-2.5 text-sm text-state-info-ink shadow-[0_1px_2px_rgba(2,60,110,0.05)] transition duration-150 ease-out hover:from-accent-dim/70"
          >
            <span className="inline-flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent/15 text-accent-deep"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              </span>
              <span>
                <span className="font-medium">
                  {candidateCount} candidate {candidateCount === 1 ? "signal" : "signals"}
                </span>{" "}
                waiting in the intake queue.
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-accent-deep">
              Review
              <svg
                aria-hidden="true"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition-transform duration-150 group-hover:translate-x-0.5"
              >
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </span>
          </Link>
        )}

        {loading && (
          <div className="mt-3">
            <ListSkeleton />
          </div>
        )}

        {error && <ErrorAlert className="mt-3">{error}</ErrorAlert>}

        {!loading && !error && filter !== "threads" && emails.length === 0 && (
          <div className="mt-4 rounded-lg border border-line bg-surface-raised p-6 text-center">
            <p className="text-sm text-ink-mid">
              {filter === "all"
                ? t("mail.emptyAll")
                : filter === "reply-needed"
                  ? t("mail.emptyReplyNow")
                  : t("mail.emptyFilter")}
            </p>
            <p className="mt-1 text-xs text-ink-mid">
              {filter === "reply-needed" ? t("mail.emptyReplyHint") : t("mail.emptySyncHint")}
            </p>
            {filter === "reply-needed" && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setFilter("all")}
                  className="inline-flex min-h-11 items-center rounded-md border border-line px-4 text-xs font-medium text-ink-mid transition hover:border-line-strong hover:text-ink"
                >
                  {t("mail.showAllSignals")}
                </button>
                <button
                  type="button"
                  onClick={syncNow}
                  disabled={syncing}
                  className="inline-flex min-h-11 items-center rounded-md border border-line px-4 text-xs font-medium text-ink-mid transition hover:border-line-strong hover:text-ink disabled:opacity-50"
                >
                  {syncing ? t("common.syncing") : t("common.syncNow")}
                </button>
              </div>
            )}
            {filter === "all" && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Link
                  href="/settings"
                  className="inline-flex min-h-11 items-center rounded-md bg-accent-solid px-4 text-xs font-medium text-accent-solid-ink transition hover:bg-accent-solid-hover"
                >
                  {t("mail.connectGoogle")}
                </Link>
                <button
                  type="button"
                  onClick={syncNow}
                  disabled={syncing}
                  className="inline-flex min-h-11 items-center rounded-md border border-line px-4 text-xs font-medium text-ink-mid transition hover:border-line-strong hover:text-ink disabled:opacity-50"
                >
                  {syncing ? t("common.syncing") : t("common.syncNow")}
                </button>
              </div>
            )}
          </div>
        )}

        {!loading && filter !== "threads" && emails.length > 0 && (
          <section className="panel-elevated overflow-hidden rounded-2xl border border-line/70 bg-surface-panel">
            <BulkActionBar
              allVisibleSelected={allVisibleSelected}
              busy={bulkBusy}
              selectedCount={selectedCount}
              totalVisible={emails.length}
              totalAvailable={totalAvailable}
              onApply={applyBulkAction}
              onClear={() => setSelectedIds(new Set())}
              onToggleAll={toggleAllVisible}
            />
            <ul className="divide-y divide-line-soft">
              {groupEmailsByDate(emails).map((group) => (
                <Fragment key={`${group.label}-${group.emails[0]?.id}`}>
                  <li className="bg-surface-raised/60 px-4 py-1.5 text-[10.5px] font-bold uppercase tracking-wider text-ink-dim">
                    {group.label} <span className="text-slate-300">· {group.emails.length}</span>
                  </li>
                  {group.emails.map((e) => (
                    <EmailRowItem
                      key={e.id}
                      email={e}
                      queue={filter}
                      reminderBusyKey={rowReminderBusy}
                      quickBusyId={rowQuickBusy}
                      selected={selectedIds.has(e.id)}
                      inboxLabel={resolveInboxLabel(e)}
                      onCreateReminder={createRowReminder}
                      onQuickArchive={quickArchive}
                      onQuickToggleRead={quickToggleRead}
                      onToggleSelected={toggleSelected}
                    />
                  ))}
                </Fragment>
              ))}
            </ul>
          </section>
        )}

        {!loading && filter === "threads" && threads.length === 0 && !error && (
          <div className="mt-4 rounded-lg border border-line bg-surface-raised p-6 text-center">
            <p className="text-sm text-ink-mid">No threads match this filter.</p>
          </div>
        )}

        {!loading && filter === "threads" && threads.length > 0 && (
          <section className="panel-elevated overflow-hidden rounded-2xl border border-line/70 bg-surface-panel">
            <ul className="divide-y divide-line-soft">
              {threads.map((thread) => (
                <ThreadRowItem key={thread.threadId} thread={thread} />
              ))}
            </ul>
          </section>
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

const DAY_MS = 86_400_000;

// Buckets a message date into a Superhuman-style list section. Pure render-time
// calculation — no state, no re-sorting (the server already ordered the list).
function dateGroupLabel(dateIso: string): string {
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  if (date.getTime() >= todayStart.getTime()) return "Today";
  if (date.getTime() >= todayStart.getTime() - DAY_MS) return "Yesterday";
  if (date.getTime() >= todayStart.getTime() - 6 * DAY_MS) return "This week";
  return "Earlier";
}

// Splits the loaded rows into consecutive label runs, preserving server order.
// A label only opens a new group when it differs from the previous row's label,
// so an interleaved order never collapses distant rows into one bucket.
function groupEmailsByDate(emails: EmailRow[]): { label: string; emails: EmailRow[] }[] {
  const groups: { label: string; emails: EmailRow[] }[] = [];
  for (const email of emails) {
    const label = dateGroupLabel(email.date);
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      groups[groups.length - 1] = { label, emails: [...last.emails, email] };
    } else {
      groups.push({ label, emails: [email] });
    }
  }
  return groups;
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
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-accent-light/30 bg-state-info-bg px-4 py-3 text-sm text-ink shadow-lg shadow-black/10 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium">Email {actionLabel}.</p>
        {notice.subject && <p className="mt-0.5 truncate text-xs text-ink-mid">{notice.subject}</p>}
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={onUndo}
          disabled={busy}
          className="min-h-10 rounded-md bg-accent-solid px-3 text-xs font-semibold text-accent-solid-ink transition hover:bg-accent-solid-hover disabled:opacity-50"
        >
          {busy ? "Restoring..." : "Undo"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="min-h-10 rounded-md border border-line px-3 text-xs text-ink-mid transition hover:bg-surface-hover disabled:opacity-50"
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
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-accent-light/30 bg-state-info-bg px-4 py-3 text-sm text-ink shadow-lg shadow-black/10 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium">
          {count} {count === 1 ? "email" : "emails"} archived.
        </p>
        {preview && <p className="mt-0.5 truncate text-xs text-ink-mid">{preview}</p>}
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={onUndo}
          disabled={busy}
          className="min-h-10 rounded-md bg-accent-solid px-3 text-xs font-semibold text-accent-solid-ink transition hover:bg-accent-solid-hover disabled:opacity-50"
        >
          {busy ? "Restoring..." : "Undo all"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="min-h-10 rounded-md border border-line px-3 text-xs text-ink-mid transition hover:bg-surface-hover disabled:opacity-50"
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
  totalAvailable,
  onApply,
  onClear,
  onToggleAll,
}: {
  allVisibleSelected: boolean;
  busy: boolean;
  selectedCount: number;
  totalVisible: number;
  totalAvailable: number;
  onApply: (action: BulkAction, options?: { priority?: EmailRow["priority"] }) => void;
  onClear: () => void;
  onToggleAll: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-line-soft px-4 py-2.5 md:flex-row md:items-center md:justify-between">
      <button
        type="button"
        onClick={onToggleAll}
        aria-pressed={allVisibleSelected}
        className="group inline-flex items-center gap-2 text-xs font-medium text-ink-mid transition hover:text-ink"
      >
        <span
          aria-hidden="true"
          className={`flex h-4 w-4 items-center justify-center rounded border transition ${
            allVisibleSelected
              ? "border-accent-solid bg-accent-solid text-accent-solid-ink"
              : "border-line-strong bg-surface-panel group-hover:border-slate-400"
          }`}
        >
          {allVisibleSelected && (
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )}
        </span>
        {selectedCount > 0 ? `${selectedCount} selected` : "Select page"}
      </button>
      {selectedCount > 0 ? (
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
            className="h-7 rounded-md px-2 text-xs text-ink-dim transition hover:bg-surface-hover disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      ) : (
        <span className="text-[11px] text-ink-dim">
          {totalVisible}
          {totalAvailable > totalVisible ? ` of ${totalAvailable}` : " on this page"}
        </span>
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
          ? "border-red-500/25 bg-red-500/10 text-state-danger-ink hover:bg-red-500/15"
          : "border-line bg-surface-raised text-ink-mid hover:bg-surface-hover"
      }`}
    >
      {children}
    </button>
  );
}

// Per-inbox scope selector — only rendered when the user actually has more than
// one mailbox. Values: "all", "primary" (the primary Google inbox), or a linked
// inbox id. Addresses come straight from the API, never hardcoded.
function InboxSelector({
  inboxes,
  current,
  onChange,
}: {
  inboxes: InboxOption[];
  current: string;
  onChange: (value: string) => void;
}) {
  if (inboxes.length < 2) return null;
  // Non-Google mailboxes (in the selector since Phase 1) get a small provider
  // tag — the address alone doesn't identify the service on custom domains.
  const providerTag: Record<string, string> = {
    NAVER: "Naver",
    ICLOUD: "iCloud",
    OUTLOOK: "Outlook",
    IMAP: "IMAP",
  };
  const options = [
    { value: "all", label: "All inboxes", needsReconnect: false, tag: null as string | null },
    ...inboxes.map((i) => ({
      value: i.id ?? "primary",
      label: i.email ?? (i.kind === "primary" ? "Primary" : "Linked inbox"),
      needsReconnect: i.needsReconnect,
      tag: providerTag[i.provider] ?? null,
    })),
  ];
  return (
    <div
      role="group"
      aria-label="Filter by inbox"
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 pt-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {options.map((o) => {
        const active = o.value === current;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`inline-flex min-h-[32px] shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              active
                ? "bg-accent-solid text-accent-solid-ink"
                : "border border-line bg-surface-raised text-ink-mid hover:bg-surface-hover hover:text-ink"
            }`}
          >
            <span className="max-w-[168px] truncate">{o.label}</span>
            {o.tag && (
              <span
                className={`shrink-0 rounded px-1 text-[10px] font-medium leading-4 ${
                  // AA on both states: sky-700 on near-white ≈ 6:1; slate-600
                  // on slate-200 ≈ 6.1:1 (white-on-white/20-over-accent was 2.2:1).
                  active ? "bg-surface-panel text-accent-deeper" : "bg-surface-inset text-ink-muted"
                }`}
              >
                {o.tag}
              </span>
            )}
            {o.needsReconnect && (
              <span
                role="img"
                aria-label="Reconnect needed"
                title="Reconnect needed"
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// On mobile only the essential mail filters show; the rest (attachments,
// candidates, threads, automated) stay desktop-only to keep the chip row short.
const MOBILE_FILTERS = new Set<Filter>(["all", "reply-needed", "urgent", "unread"]);

function FilterTabs({
  current,
  onChange,
  activeCount,
}: {
  current: Filter;
  onChange: (f: Filter) => void;
  /** Server-truth total for the ACTIVE filter (query total) — never a
   *  loaded-rows count, which understates and shifts as pages load. */
  activeCount?: number;
}) {
  const { t } = useT();
  return (
    <div
      role="group"
      aria-label="Filter mail"
      className="flex gap-0.5 overflow-x-auto rounded-xl border border-line/70 bg-surface-panel/60 p-1 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {FILTERS.filter((f) => !DOMAIN_FILTER_KEYS.includes(f.key)).map((f) => {
        const active = f.key === current;
        return (
          <button
            key={f.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(f.key)}
            className={`${MOBILE_FILTERS.has(f.key) ? "inline-flex" : "hidden md:inline-flex"} ease-strong h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs transition duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              active
                ? "seg-active bg-surface-panel font-semibold text-ink"
                : "font-medium text-ink-mid hover:bg-surface-panel/70 hover:text-ink"
            }`}
          >
            {f.labelKey ? t(f.labelKey) : f.label}
            {active && typeof activeCount === "number" && activeCount > 0 && (
              <span className="rounded bg-accent-dim px-1 text-[10px] font-bold text-accent-deeper">
                {activeCount}
              </span>
            )}
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
      className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-line/70 bg-surface-panel/60 px-4 py-2.5 text-[11px] text-ink-dim backdrop-blur"
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
          className="ease-strong rounded-md border border-line bg-surface-panel px-2.5 py-1 text-[11px] font-medium text-ink-mid shadow-sm transition duration-150 hover:text-accent-deep active:scale-[0.97] disabled:opacity-50"
        >
          {isFetching ? "Loading…" : "Load more"}
        </button>
      ) : (
        <span className="text-ink-mid">All loaded.</span>
      )}
    </div>
  );
}

function EmailRowItem({
  email,
  reminderBusyKey,
  quickBusyId,
  queue,
  selected,
  inboxLabel,
  onCreateReminder,
  onQuickArchive,
  onQuickToggleRead,
  onToggleSelected,
}: {
  email: EmailRow;
  reminderBusyKey: string | null;
  quickBusyId: string | null;
  queue: Filter;
  selected: boolean;
  inboxLabel?: string | null;
  onCreateReminder: (email: EmailRow, option: EmailReminderOption) => void;
  onQuickArchive: (email: EmailRow) => void;
  onQuickToggleRead: (email: EmailRow) => void;
  onToggleSelected: (id: string) => void;
}) {
  const unread = !email.isRead;
  const urgent = email.priority === "URGENT";
  const name = senderName(email.from);
  const detailParams = new URLSearchParams({ markRead: "false", queue });
  return (
    <li className="row-wash group relative">
      {/* Tier accent bar: urgent outranks unread; read+normal rows stay bare. */}
      {(urgent || unread) && (
        <span
          aria-hidden="true"
          className={`absolute left-0 top-0 h-full w-[3px] ${
            urgent ? "bg-gradient-to-b from-rose-400 to-rose-500" : "bg-accent-light"
          }`}
        />
      )}
      <div className="flex items-start gap-3 px-4 py-3.5 pl-5">
        <button
          type="button"
          aria-pressed={selected}
          aria-label={`Select ${email.subject || "No subject"}`}
          onClick={() => onToggleSelected(email.id)}
          className={`mt-2.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
            selected
              ? "border-accent-solid bg-accent-solid text-accent-solid-ink"
              : "border-line-strong bg-surface-panel hover:border-slate-400"
          }`}
        >
          {selected && (
            <svg
              aria-hidden="true"
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )}
        </button>
        <Link
          href={`/email/${email.id}?${detailParams.toString()}`}
          className="flex min-w-0 flex-1 items-start gap-3.5"
        >
          <span
            aria-hidden="true"
            className={`avatar-ring mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[13px] font-semibold text-white ${avatarGradient(name)}`}
          >
            {senderInitials(name)}
          </span>
          <span className="block min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <TrustDot trust={email.trust} />
              <span
                className={`truncate text-sm ${
                  unread ? "font-semibold text-ink" : "text-ink-muted"
                }`}
              >
                {name}
              </span>
              {email.tier && <LaneChip tier={email.tier} />}
              {inboxLabel && (
                <span className="inline-flex max-w-[30%] shrink-0 items-center gap-1 truncate rounded-full bg-surface-hover px-2 py-0.5 text-[10px] font-medium text-ink-mid">
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70"
                  />
                  <span className="truncate">{inboxLabel}</span>
                </span>
              )}
              <EmailBadges email={email} unread={false} />
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {unread && (
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
                )}
                <time className="text-[11px] tabular-nums text-ink-dim">
                  {formatRelative(email.date)}
                </time>
              </span>
            </span>
            <span
              className={`mt-1 block truncate text-[13.5px] ${
                unread ? "font-medium text-ink-strong" : "text-ink-muted"
              }`}
            >
              {email.subject || "No subject"}
            </span>
            {email.summary ? (
              <span
                className={`mt-1 line-clamp-1 block text-xs leading-5 ${unread ? "text-ink-mid" : "text-ink-dim"}`}
              >
                {email.summary}
              </span>
            ) : email.snippet ? (
              <span
                className={`mt-1 line-clamp-1 block text-xs leading-5 ${unread ? "text-ink-mid" : "text-ink-dim"}`}
              >
                {email.snippet}
              </span>
            ) : null}
            {email.candidateProfilePreview && (
              <CandidatePreview profile={email.candidateProfilePreview} />
            )}
          </span>
        </Link>
      </div>
      {/* Hover quick actions: sit just below the timestamp, outside the row
          Link (no nested interactive elements). focus-within keeps them
          reachable by keyboard; the timestamp itself never moves. */}
      <div
        className={`absolute right-4 top-8 z-10 flex items-center gap-1 transition duration-150 ${
          quickBusyId === email.id
            ? "opacity-100"
            : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"
        }`}
      >
        <button
          type="button"
          aria-label={
            email.isRead
              ? `Mark ${email.subject || "No subject"} as unread`
              : `Mark ${email.subject || "No subject"} as read`
          }
          onClick={() => onQuickToggleRead(email)}
          disabled={quickBusyId !== null}
          className="ease-strong flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface-panel text-ink-dim shadow-sm transition duration-150 hover:text-accent-deep active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {email.isRead ? (
            <svg
              aria-hidden="true"
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          ) : (
            <svg
              aria-hidden="true"
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z" />
              <path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10" />
            </svg>
          )}
        </button>
        <button
          type="button"
          aria-label={`Archive ${email.subject || "No subject"}`}
          onClick={() => onQuickArchive(email)}
          disabled={quickBusyId !== null}
          className="ease-strong flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface-panel text-ink-dim shadow-sm transition duration-150 hover:text-accent-deep active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45"
        >
          <svg
            aria-hidden="true"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="2" y="3" width="20" height="5" rx="1" />
            <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
            <path d="M10 12h4" />
          </svg>
        </button>
      </div>
      <EmailRowReminderActions
        email={email}
        busyKey={reminderBusyKey}
        onCreateReminder={onCreateReminder}
      />
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
  // Quiet inline strip, indented to the content column (checkbox 16 + gap 12 +
  // avatar 36 + gap 14 = 78px). Text-only buttons keep the row calm while the
  // one-click reminder affordance stays permanently visible (no hover-hiding —
  // touch and keyboard users get the same surface).
  return (
    <div className="-mt-1.5 flex flex-wrap items-center gap-0.5 pb-2.5 pl-[78px] pr-4 text-[11px] text-ink-dim">
      <span className="mr-1.5">Remind</span>
      {EMAIL_REMINDER_OPTIONS.map((option) => {
        const key = `${email.id}:${option.key}`;
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => onCreateReminder(email, option)}
            disabled={busyKey !== null}
            className="ease-strong rounded-md px-2 py-1 text-[11px] font-medium text-ink-dim transition duration-150 hover:bg-state-info-bg hover:text-accent-deeper active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busyKey === key ? "Setting…" : option.label}
          </button>
        );
      })}
    </div>
  );
}

// Cap visible chips so a heavily-tagged email (priority + reply + candidate +
// 3 attachment counts + category) doesn't overflow/clip on a phone. Extras
// collapse into a "+N" chip; the row also wraps as a safety net.
const MAX_VISIBLE_BADGES = 4;

function EmailBadges({ email, unread }: { email: EmailRow; unread: boolean }) {
  const badges: ReactNode[] = [];
  const priorityBadge = <PriorityBadge key="priority" priority={email.priority} />;
  // PriorityBadge returns null for NORMAL — only count it when it renders.
  if (email.priority !== "NORMAL") badges.push(priorityBadge);
  if (email.needsReply) badges.push(<ReplyNeededBadge key="reply" />);
  if ((email.attachmentCandidateCount ?? 0) > 0) badges.push(<CandidateBadge key="candidate" />);
  if ((email.attachmentCount ?? 0) > 0) {
    badges.push(
      <span
        key="files"
        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-surface-hover px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-ink-mid"
      >
        <svg
          aria-hidden="true"
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
        {email.attachmentCount}
      </span>,
    );
  }
  // attachmentPendingCount / attachmentFallbackCount are attachment-pipeline
  // diagnostics (still on the wire; the API is unchanged), not user-facing;
  // they used to render here as "Pending N" / "Fallback N" row badges.
  if (email.category) badges.push(<CategoryBadge key="category" category={email.category} />);

  const visible = badges.slice(0, MAX_VISIBLE_BADGES);
  const overflow = badges.length - visible.length;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {visible}
      {overflow > 0 && (
        <span className="shrink-0 rounded border border-line bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-ink-mid">
          +{overflow}
        </span>
      )}
      {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
    </div>
  );
}

function ThreadRowItem({ thread }: { thread: ThreadRow }) {
  const firstParticipant = thread.participants[0] ? senderName(thread.participants[0]) : "@";
  return (
    <li className="row-wash group relative">
      {thread.hasUnread && (
        <span aria-hidden="true" className="absolute left-0 top-0 h-full w-[3px] bg-accent-light" />
      )}
      <Link
        href={`/email/${thread.lastMessage.id}?markRead=false`}
        className="flex items-start gap-3.5 px-4 py-3.5 pl-5"
      >
        <span
          aria-hidden="true"
          className={`avatar-ring mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[13px] font-semibold text-white ${avatarGradient(firstParticipant)}`}
        >
          {senderInitials(firstParticipant)}
        </span>
        <span className="block min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span
              className={`truncate text-sm ${thread.hasUnread ? "font-semibold text-ink" : "text-ink-muted"}`}
            >
              {thread.participants.map(senderName).join(", ")}
            </span>
            <PriorityBadge priority={thread.latestPriority} />
            <span className="shrink-0 rounded-md bg-surface-hover px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-ink-mid">
              {thread.messageCount} msgs
            </span>
            <time className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-dim">
              {formatRelative(thread.lastMessage.receivedAt)}
            </time>
          </span>
          <span
            className={`mt-1 block truncate text-[13.5px] ${thread.hasUnread ? "font-medium text-ink-strong" : "text-ink-muted"}`}
          >
            {thread.subject || "No subject"}
          </span>
          {thread.summary ? (
            <span className="mt-1 line-clamp-1 block text-xs leading-5 text-ink-dim">
              {thread.summary}
            </span>
          ) : thread.lastMessage.snippet ? (
            <span className="mt-1 line-clamp-1 block text-xs leading-5 text-ink-dim">
              {thread.lastMessage.snippet}
            </span>
          ) : null}
        </span>
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
    <div className="mt-2 rounded-lg border border-accent/15 bg-accent/5 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[11px] font-medium text-accent-deep">{title}</p>
        <span className="shrink-0 text-[10px] tabular-nums text-accent-deep">
          {Math.round(profile.confidence * 100)}%
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-ink-mid">{profile.summary}</p>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-ink-dim">
        {profile.contact && <span className="truncate">Contact {profile.contact}</span>}
        {profile.intakeStatus && <span>{candidateIntakeLabel(profile.intakeStatus)}</span>}
        <span>Files {profile.evidenceCount}</span>
        {missing && <span className="text-accent-deep">{missing}</span>}
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
    <span className="shrink-0 rounded-md bg-accent/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-accent-deeper ring-1 ring-inset ring-accent/20">
      Needs reply
    </span>
  );
}

function CandidateBadge() {
  return (
    <span className="shrink-0 rounded-md bg-accent/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-accent-deep ring-1 ring-inset ring-accent/20">
      Candidate
    </span>
  );
}

function PriorityBadge({ priority }: { priority: EmailRow["priority"] }) {
  const styles = {
    URGENT: "bg-rose-500/10 text-rose-600 ring-rose-500/20",
    NORMAL: "bg-surface-hover text-ink-mid ring-line",
    LOW: "bg-surface-hover text-ink-mid ring-transparent",
  } as const;
  const labels = { URGENT: "Urgent", NORMAL: "Normal", LOW: "Low" } as const;
  if (priority === "NORMAL") return null;
  return (
    <span
      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ring-1 ring-inset ${styles[priority]}`}
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
    <span className="shrink-0 rounded-md bg-surface-hover px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-ink-mid">
      {label}
    </span>
  );
}

function senderName(raw: string): string {
  const match = raw.match(/^([^<]+?)\s*</);
  if (match?.[1]) return match[1].trim();
  return raw.replace(/[<>]/g, "").trim();
}

// Monogram avatar: up to two initials from the display name. Works for
// latin ("Jamie Rivera" → JR), single-word senders ("Stripe" → S), and CJK
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
  "from-accent-light to-blue-500",
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

// ─── Mobile native mail row ─────────────────────────────────────────────────
//
// A clean phone list row (not the desktop card with checkbox + reminder band).
// Bulk-select, threads, and per-row reminders stay desktop-only.

function MobileEmailRow({
  email,
  queue,
  inboxLabel,
}: {
  email: EmailRow;
  queue: Filter;
  inboxLabel?: string | null;
}) {
  const unread = !email.isRead;
  const params = new URLSearchParams({ markRead: "false", queue });
  const preview = email.summary || email.snippet;
  return (
    <li>
      <Link
        href={`/email/${email.id}?${params.toString()}`}
        className="flex gap-3 rounded-2xl bg-surface-panel px-4 py-3 transition active:bg-surface-hover"
      >
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${unread ? "bg-accent" : "bg-transparent"}`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={`truncate text-[15px] ${unread ? "font-semibold text-ink" : "font-medium text-ink-mid"}`}
              >
                {senderName(email.from)}
              </span>
              {email.tier && <LaneChip tier={email.tier} />}
            </span>
            <time className="shrink-0 text-[11px] tabular-nums text-ink-dim">
              {formatRelative(email.date)}
            </time>
          </span>
          <span
            className={`mt-0.5 block truncate text-[13px] ${unread ? "text-ink" : "text-ink-mid"}`}
          >
            {email.subject || "No subject"}
          </span>
          {preview && (
            <span className="mt-1 line-clamp-2 block text-[12px] leading-5 text-ink-dim">
              {preview}
            </span>
          )}
          {(email.priority === "URGENT" || inboxLabel) && (
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {email.priority === "URGENT" && (
                <span className="inline-flex items-center rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-state-danger-ink">
                  Urgent
                </span>
              )}
              {inboxLabel && (
                <span className="inline-flex max-w-[60%] items-center gap-1 truncate rounded-full bg-surface-hover px-2 py-0.5 text-[10px] font-medium text-ink-mid">
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70"
                  />
                  <span className="truncate">{inboxLabel}</span>
                </span>
              )}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}
