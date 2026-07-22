"use client";

import { useQueries, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import type { CommitmentItem } from "../../components/commitment-card";
import { FirewallBoard } from "../../components/firewall-board";
import { RejectReasonDialog } from "../../components/reject-reason-dialog";
import { useToast } from "../../components/toast";
import { apiFetch } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { ReplyNeededEmail } from "../../lib/inbox-summary";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";
import { formatRelative } from "../../lib/text";

interface PendingActionItem {
  id: string;
  conversationId: string;
  conversationTitle: string | null;
  status: "PENDING" | "REJECTED" | "EXECUTED" | "FAILED";
  toolName: string;
  toolArgs: string;
  preview?: string | null;
  targetLabel: string | null;
  reasoning: string | null;
  result: string | null;
  createdAt: string;
}

type StatusFilter = "pending" | "all";

// Which top-level surface /inbox is showing. Driven by the `?view=` search
// param so the choice is shareable and back-button friendly.
type SegmentView = "decisions" | "firewall";

function parseView(raw: string | null): SegmentView {
  return raw === "firewall" ? "firewall" : "decisions";
}

export default function InboxPage() {
  return (
    <AuthGuard>
      <CommandCenterView />
    </AuthGuard>
  );
}

function CommandCenterView() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("pending");
  const [syncing, setSyncing] = useState(false);
  const [actionLoading, setActionLoading] = useState<
    Record<string, "approve" | "reject" | "snooze" | null>
  >({});
  // Action id awaiting the reject-with-reason dialog; null when closed.
  const [rejectTargetId, setRejectTargetId] = useState<string | null>(null);
  const { toast } = useToast();

  // Top-level surface toggle ("Decisions" ⇄ "Firewall board"). Read from
  // `?view=` so it's shareable and works with the back button; changing it
  // rewrites the URL rather than holding local state.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const view = parseView(searchParams.get("view"));

  const setView = useCallback(
    (next: SegmentView) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "decisions") {
        params.delete("view");
      } else {
        params.set("view", next);
      }
      const query = params.toString();
      router.push(query ? `${pathname}?${query}` : pathname);
    },
    [router, pathname, searchParams],
  );

  // Parallel fetch via useQueries. Each branch has independent loading
  // and error state so a flaky endpoint never blocks the other.
  const results = useQueries({
    queries: [
      {
        queryKey: [...queryKeys.inbox.pending(), filter] as const,
        // Poll as the real-time safety net (missed WS frames strand the queue).
        // 15s, not 30s: the WS mail-sync push is the fast path, but when it's
        // flaky in the field this is the worst-case latency a user waits.
        refetchInterval: 15_000,
        refetchOnWindowFocus: true,
        queryFn: async () => {
          const qs = filter === "all" ? "?status=all" : "";
          const data = await apiFetch<{ actions: PendingActionItem[] }>(
            `/api/chat/pending-actions${qs}`,
          );
          return Array.isArray(data.actions) ? data.actions : [];
        },
      },
      {
        queryKey: queryKeys.inbox.commitments(),
        queryFn: async () => {
          const data = await apiFetch<{ commitments: CommitmentItem[] }>(
            "/api/commitments?status=OPEN&limit=8",
          );
          return Array.isArray(data.commitments) ? data.commitments : [];
        },
      },
    ],
  });
  const [actionsQuery, commitmentsQuery] = results;
  const actions = actionsQuery.data ?? [];
  const commitments = commitmentsQuery.data ?? [];
  const loading = actionsQuery.isLoading || commitmentsQuery.isLoading;

  const load = useCallback(
    async (_statusFilter: StatusFilter) => {
      // Refresh must actually PULL new mail from Gmail, not just re-read the DB
      // the server already has. Trigger a server sync first, then refetch the
      // decision queue so freshly-classified mail shows up on demand — this is
      // the manual fast path when the real-time WS push didn't fire.
      setSyncing(true);
      try {
        await apiFetch("/api/email/sync", {
          method: "POST",
          body: JSON.stringify({ maxResults: 30 }),
        });
      } catch (err) {
        // Sync is best-effort; still refetch below so the queue reflects the DB.
        captureClientError(err, { scope: "inbox.refresh.sync" });
      } finally {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.inbox.pending() }),
          queryClient.invalidateQueries({ queryKey: queryKeys.inbox.commitments() }),
        ]);
        setSyncing(false);
      }
    },
    [queryClient],
  );

  useEffect(() => {
    if (actionsQuery.error) {
      captureClientError(actionsQuery.error, { scope: "inbox.load.actions" });
    }
    if (commitmentsQuery.error) {
      captureClientError(commitmentsQuery.error, { scope: "inbox.load.commitments" });
    }
    if (actionsQuery.error || commitmentsQuery.error) {
      setError("Could not load the decision queue.");
    } else {
      setError(null);
    }
  }, [actionsQuery.error, commitmentsQuery.error]);

  useEffect(() => {
    // Filter change retriggers the keyed query automatically; no-op here
    // intentionally kept so the existing `load(filter)` button still
    // works for refresh.
    void filter;
  }, [filter, load]);

  useEffect(() => {
    const handler = () => load(filter);
    window.addEventListener("conversations-updated", handler);
    return () => window.removeEventListener("conversations-updated", handler);
  }, [filter, load]);

  const handleApprove = async (actionId: string) => {
    if (actionLoading[actionId]) return;
    setActionLoading((prev) => ({ ...prev, [actionId]: "approve" }));
    try {
      await apiFetch(`/api/chat/pending-actions/${actionId}/approve`, { method: "POST" });
      queryClient.setQueryData<PendingActionItem[]>(
        [...queryKeys.inbox.pending(), filter] as unknown as readonly unknown[],
        (prev) =>
          filter === "pending"
            ? (prev ?? []).filter((a) => a.id !== actionId)
            : (prev ?? []).map((a) => (a.id === actionId ? { ...a, status: "EXECUTED" } : a)),
      );
      toast("Action approved.", "success");
    } catch (err) {
      captureClientError(err, { scope: "inbox.approve", actionId });
      toast("Could not approve this action. Please try again.", "error");
    } finally {
      setActionLoading((prev) => ({ ...prev, [actionId]: null }));
    }
  };

  const handleReject = async (actionId: string, reason: string | null) => {
    if (actionLoading[actionId]) return;
    setActionLoading((prev) => ({ ...prev, [actionId]: "reject" }));
    try {
      await apiFetch(`/api/chat/pending-actions/${actionId}/reject`, {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {}),
      });
      queryClient.setQueryData<PendingActionItem[]>(
        [...queryKeys.inbox.pending(), filter] as unknown as readonly unknown[],
        (prev) =>
          filter === "pending"
            ? (prev ?? []).filter((a) => a.id !== actionId)
            : (prev ?? []).map((a) => (a.id === actionId ? { ...a, status: "REJECTED" } : a)),
      );
      toast("Suggestion rejected.", "success");
    } catch (err) {
      captureClientError(err, { scope: "inbox.reject", actionId });
      toast("Could not reject this action. Please try again.", "error");
    } finally {
      setActionLoading((prev) => ({ ...prev, [actionId]: null }));
    }
  };

  const handleSnooze = async (actionId: string, hours = 1) => {
    if (actionLoading[actionId]) return;
    setActionLoading((prev) => ({ ...prev, [actionId]: "snooze" }));
    try {
      const snoozeUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
      await apiFetch(`/api/chat/pending-actions/${actionId}/snooze`, {
        method: "POST",
        body: JSON.stringify({ snoozeUntil }),
      });
      // Drop the snoozed row from the current view in BOTH filters. The reject
      // handler's copy-pasted "set status REJECTED" branch mislabeled a snoozed
      // action as "Rejected" in the all-actions view until the next refetch.
      queryClient.setQueryData<PendingActionItem[]>(
        [...queryKeys.inbox.pending(), filter] as unknown as readonly unknown[],
        (prev) => (prev ?? []).filter((a) => a.id !== actionId),
      );
      toast(`Snoozed for ${hours}h — will resurface automatically.`, "success");
    } catch (err) {
      captureClientError(err, { scope: "inbox.snooze", actionId });
      toast("Could not snooze this action. Please try again.", "error");
    } finally {
      setActionLoading((prev) => ({ ...prev, [actionId]: null }));
    }
  };

  const pendingCount = actions.filter((a) => a.status === "PENDING").length;
  // Approve/skip/snooze mutate the queue with only a transient toast; this
  // polite live region announces the new waiting count to screen readers so
  // the list change isn't silent (WCAG 4.1.3). Re-derives from query data
  // after each optimistic update.
  const queueAnnouncement =
    pendingCount === 1 ? "1 decision waiting" : `${pendingCount} decisions waiting`;

  return (
    <>
      <p aria-live="polite" className="sr-only">
        {queueAnnouncement}
      </p>

      {view === "firewall" ? (
        <>
          {/* Top-level surface toggle stays above the board so users can
              always switch back to the decision queue. */}
          <div className="mx-auto w-full max-w-6xl px-4 pt-3 md:pt-6">
            <SegmentControl view={view} onSelect={setView} />
          </div>
          <FirewallBoard />
        </>
      ) : (
        <DecisionsBody
          actions={actions}
          commitments={commitments}
          pendingCount={pendingCount}
          filter={filter}
          setFilter={setFilter}
          loading={loading || syncing}
          error={error}
          view={view}
          onSelectView={setView}
          actionLoading={actionLoading}
          onRefresh={() => load(filter)}
          onApprove={handleApprove}
          onOpenReject={setRejectTargetId}
          onSnooze={(id) => handleSnooze(id, 1)}
        />
      )}

      <RejectReasonDialog
        open={rejectTargetId !== null}
        onCancel={() => setRejectTargetId(null)}
        onReject={(reason) => {
          const id = rejectTargetId;
          setRejectTargetId(null);
          if (id) void handleReject(id, reason);
        }}
      />
    </>
  );
}

// ─── Segment control ──────────────────────────────────────────────────────
//
// Same role="group" + aria-pressed toggle-button pattern as the FilterTab
// below, styled to match. Drives the top-level surface via `?view=`.

function SegmentControl({
  view,
  onSelect,
}: {
  view: SegmentView;
  onSelect: (next: SegmentView) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Inbox view"
      className="mb-4 inline-flex items-center gap-1 rounded-xl border border-slate-200/70 bg-white/60 p-1 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur"
    >
      <FilterTab
        active={view === "decisions"}
        label="Decisions"
        onClick={() => onSelect("decisions")}
      />
      <FilterTab
        active={view === "firewall"}
        label="Firewall board"
        onClick={() => onSelect("firewall")}
      />
    </div>
  );
}

// ─── Decisions body ─────────────────────────────────────────────────────────
//
// The approval-queue surface (mobile + desktop layouts). Extracted verbatim
// from CommandCenterView's original render so the firewall view can sit
// alongside it under the same segment toggle. Data + handlers are lifted in
// as props; the fetch/optimistic-update logic stays in CommandCenterView.

function DecisionsBody({
  actions,
  commitments,
  pendingCount,
  filter,
  setFilter,
  loading,
  error,
  view,
  onSelectView,
  actionLoading,
  onRefresh,
  onApprove,
  onOpenReject,
  onSnooze,
}: {
  actions: PendingActionItem[];
  commitments: CommitmentItem[];
  pendingCount: number;
  filter: StatusFilter;
  setFilter: (f: StatusFilter) => void;
  loading: boolean;
  error: string | null;
  view: SegmentView;
  onSelectView: (next: SegmentView) => void;
  actionLoading: Record<string, "approve" | "reject" | "snooze" | null>;
  onRefresh: () => void;
  onApprove: (id: string) => void;
  onOpenReject: (id: string) => void;
  onSnooze: (id: string) => void;
}) {
  const { t } = useT();
  return (
    <>
      {/* MOBILE — purpose-built native screen (desktop layout untouched below) */}
      <div className="px-4 pb-8 pt-3 md:hidden">
        <SegmentControl view={view} onSelect={onSelectView} />
        <OnboardingHint />
        <MobileDecisionQueue
          actions={actions}
          commitments={commitments}
          pendingCount={pendingCount}
          filter={filter}
          setFilter={setFilter}
          loading={loading}
          onRefresh={onRefresh}
          actionLoading={actionLoading}
          onApprove={onApprove}
          onReject={onOpenReject}
          onSnooze={onSnooze}
        />
      </div>

      {/* DESKTOP — flagship header first, then the surface toolbar, then the grid. */}
      <div className="mx-auto hidden w-full max-w-6xl px-4 py-6 md:block md:py-8">
        {/* Flat flagship header on the canvas — no boxed hero. */}
        <header className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-slate-900">
              {t("nav.decisionQueue")}
            </h1>
            <p className="mt-2 text-sm text-slate-500">
              {pendingCount > 0 ? (
                <>
                  <span className="font-medium text-slate-700">{pendingCount}</span>
                  {pendingCount === 1 ? " decision waiting" : " decisions waiting"}
                </>
              ) : commitments.length > 0 ? (
                `${commitments.length} commitment${commitments.length !== 1 ? "s" : ""} tracked`
              ) : (
                t("inbox.allClear")
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              aria-label="Refresh"
              title="Refresh"
              className="ease-strong inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white/70 text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97] disabled:opacity-50"
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
                className={loading ? "animate-spin" : ""}
              >
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
            </button>
            <Link
              href="/inbox/receipt"
              className="ease-strong inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white/70 px-3 text-xs font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
            >
              Today's receipt
            </Link>
          </div>
        </header>

        {/* Surface toolbar — segment sits directly under the header, not adrift. */}
        <SegmentControl view={view} onSelect={onSelectView} />

        <OnboardingHint />

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* 2-column grid — decisions fill the wide column, reply rail on the right. */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* ── LEFT: decision queue panel ── */}
          <section aria-label="Approval queue" className="min-w-0">
            {loading && actions.length === 0 && (
              <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="h-20 animate-pulse rounded-lg bg-slate-100" />
                <div className="h-20 animate-pulse rounded-lg bg-slate-100" />
              </div>
            )}

            {!loading && actions.length === 0 && (
              <HonestEmptyState commitmentCount={commitments.length} />
            )}

            {actions.length > 0 && (
              <div className="panel-elevated overflow-hidden rounded-2xl border border-slate-200/70 bg-white">
                <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-slate-900">Decisions</h2>
                    {pendingCount > 0 && (
                      <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-amber-600 ring-1 ring-inset ring-amber-500/20">
                        {pendingCount} pending
                      </span>
                    )}
                  </div>
                  <div
                    role="group"
                    aria-label="Filter decisions"
                    className="flex items-center gap-1 rounded-xl border border-slate-200/70 bg-white/60 p-1 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur"
                  >
                    <FilterTab
                      active={filter === "pending"}
                      label={`Pending${pendingCount ? ` (${pendingCount})` : ""}`}
                      onClick={() => setFilter("pending")}
                    />
                    <FilterTab
                      active={filter === "all"}
                      label="All"
                      onClick={() => setFilter("all")}
                    />
                  </div>
                </div>
                <ul className="divide-y divide-slate-100">
                  {actions.map((action) => (
                    <li key={action.id}>
                      <ActionCard
                        action={action}
                        loading={actionLoading[action.id] ?? null}
                        onApprove={() => onApprove(action.id)}
                        onReject={() => onOpenReject(action.id)}
                        onSnooze={() => onSnooze(action.id)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <div className="space-y-4">
            <ReplyNeededPanel />
            <QuickLinksPanel />
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Honest empty state ────────────────────────────────────────────────────

function HonestEmptyState({ commitmentCount }: { commitmentCount: number }) {
  const { t } = useT();
  return (
    <div className="panel-elevated rounded-2xl border border-slate-200/70 bg-white px-8 py-12 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 ring-1 ring-inset ring-emerald-500/20">
        <svg
          aria-hidden="true"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-emerald-500"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <p className="text-base font-semibold text-slate-900">{t("inbox.allClear")}</p>
      <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-slate-400">
        {commitmentCount > 0
          ? `Klorn is watching your mail and calendar. ${commitmentCount} tracked commitment${commitmentCount === 1 ? "" : "s"} in the background.`
          : t("inbox.emptyBody")}
      </p>
      <div className="mt-6 flex justify-center gap-2">
        <Link
          href="/inbox/firewall"
          className="ease-strong inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-200 bg-white/70 px-4 text-xs font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
        >
          Firewall board
        </Link>
        <Link
          href="/email"
          className="ease-strong inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-200 bg-white/70 px-4 text-xs font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
        >
          {t("inbox.openMail")}
        </Link>
      </div>
    </div>
  );
}

// ─── Onboarding hint ──────────────────────────────────────────────────────
//
// Founder dogfood found that new users land on /inbox without knowing what
// the product is or where to click first. This banner shows the 4 core
// destinations once and stays dismissed in localStorage thereafter.

const ONBOARDING_STORAGE_KEY = "klorn.inbox.onboarding.v1.dismissed";

function OnboardingHint() {
  const { t } = useT();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  // On phones the full 4-step tour eats the whole first fold, burying the
  // decision queue. Collapse it to a single title line by default on mobile
  // (expandable on tap); desktop always shows the full list.
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(ONBOARDING_STORAGE_KEY) === "1");
    } catch {
      setDismissed(true);
    }
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
    } catch {
      // localStorage unavailable; banner stays dismissed for this session only
    }
  };

  if (dismissed !== false) return null;

  return (
    <>
      {/* DESKTOP — one-line compact strip; the tour never outweighs the queue. */}
      <div className="mb-4 hidden items-center gap-3 rounded-lg border border-sky-200/60 bg-sky-50/60 px-3 py-2 md:flex">
        <p className="min-w-0 flex-1 truncate text-xs text-slate-500">
          <span className="font-semibold text-sky-700">{t("inbox.tourTitle")}</span>
          <span className="mx-1.5 text-slate-300">·</span>
          Approve decisions here, tune the{" "}
          <Link href="/inbox/firewall" className="font-medium text-sky-600 hover:text-sky-700">
            Firewall board
          </Link>
          , connect Google in{" "}
          <Link href="/settings" className="font-medium text-sky-600 hover:text-sky-700">
            Settings
          </Link>
          , then check{" "}
          <Link href="/inbox/receipt" className="font-medium text-sky-600 hover:text-sky-700">
            Today's receipt
          </Link>
          .
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss tour"
          className="ease-strong flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 transition duration-150 hover:bg-sky-100 hover:text-slate-700 active:scale-[0.97]"
        >
          <svg
            aria-hidden="true"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* MOBILE — collapsed title line, expandable on tap (unchanged behavior). */}
      <div className="mb-3 text-sm md:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <p className="text-[11px] font-medium text-slate-400">{t("inbox.tourTitle")}</p>
            <ul
              className={`${expanded ? "block" : "hidden"} space-y-1 text-[13px] leading-5 text-slate-500`}
            >
              <li>
                1. <span className="text-slate-900">This page</span> — agent decisions waiting on
                your approval.
              </li>
              <li>
                2.{" "}
                <Link href="/inbox/firewall" className="text-sky-600 hover:text-sky-700">
                  Firewall board
                </Link>{" "}
                — see every signal sorted into SILENT / QUEUE / PUSH. Move what we got wrong.
              </li>
              <li>
                3.{" "}
                <Link href="/settings" className="text-sky-600 hover:text-sky-700">
                  Settings → Connections
                </Link>{" "}
                — connect Google so Klorn can read mail and calendar.
              </li>
              <li>
                4.{" "}
                <Link href="/inbox/receipt" className="text-sky-600 hover:text-sky-700">
                  Today's receipt
                </Link>{" "}
                — what Klorn silenced, surfaced, and auto-handled today.
              </li>
            </ul>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="rounded-md border border-slate-200 px-2.5 py-1 text-[11px] text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
            >
              {expanded ? "Hide" : "Show"}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="rounded-md border border-slate-200 px-2.5 py-1 text-[11px] text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Reply Needed panel ────────────────────────────────────────────────────

function ReplyNeededPanel() {
  const [emails, setEmails] = useState<ReplyNeededEmail[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ emails: ReplyNeededEmail[] }>("/api/inbox/reply-needed")
      .then((data) => setEmails(Array.isArray(data.emails) ? data.emails : []))
      .catch(() => setEmails([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <div className="h-6 w-24 animate-pulse rounded bg-slate-100" />
        <div className="mt-3 space-y-2">
          <div className="h-12 animate-pulse rounded-lg bg-slate-100" />
          <div className="h-12 animate-pulse rounded-lg bg-slate-100" />
        </div>
      </div>
    );
  }

  if (emails.length === 0) return null;

  return (
    <section
      className="panel-elevated overflow-hidden rounded-2xl border border-slate-200/70 bg-white"
      aria-label="Reply needed"
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Reply Needed</h2>
          <span className="rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-sky-700 ring-1 ring-inset ring-sky-500/20">
            {emails.length}
          </span>
        </div>
      </div>
      <ul className="divide-y divide-slate-100">
        {emails.map((email) => {
          const fromName = formatFrom(email.from);
          return (
            <li key={email.id} className="row-wash">
              <Link href="/email" className="flex items-start gap-3 px-4 py-3">
                <span
                  aria-hidden="true"
                  className={`avatar-ring mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[11px] font-semibold text-white ${avatarGradient(fromName)}`}
                >
                  {senderInitials(fromName)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-start justify-between gap-2">
                    <span className="flex-1 truncate text-xs font-medium text-slate-900">
                      {email.subject || "(no subject)"}
                    </span>
                    <span className="shrink-0 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tabular-nums tracking-wide text-amber-600 ring-1 ring-inset ring-amber-500/20">
                      {Math.round(email.needsReplyConfidence * 100)}%
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-slate-400">
                    {fromName}
                  </span>
                  {email.needsReplyReason && (
                    <span className="mt-1 line-clamp-1 block text-[11px] text-slate-500">
                      {humanizeReplyReason(email.needsReplyReason)}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="flex justify-end border-t border-slate-100 px-4 py-2.5">
        <Link
          href="/email"
          className="text-xs font-medium text-sky-600 transition duration-150 hover:text-sky-700"
        >
          Open mail →
        </Link>
      </div>
    </section>
  );
}

function formatFrom(from: string): string {
  const match = from.match(/^([^<]+)\s*</);
  if (match) return match[1].trim();
  return from;
}

// Monogram avatar helpers — local copy of the email page pattern (recognition
// over decoration; deterministic gradient per sender).
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

function senderInitials(name: string): string {
  const words = name
    .replace(/["'()[\]]/g, "")
    .split(/[\s·|,]+/)
    .filter(Boolean);
  if (words.length === 0) return "@";
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

// The backend's needsReplyReason is a snake_case enum (e.g. "action_items_present").
// Never show the raw code to the user — map known ones and humanize the rest.
function humanizeReplyReason(reason: string): string {
  const map: Record<string, string> = {
    action_items_present: "Has action items",
    question_asked: "Asks a question",
    direct_request: "Direct request",
    deadline_mentioned: "Mentions a deadline",
    awaiting_response: "Awaiting your response",
    meeting_request: "Meeting request",
    follow_up_needed: "Needs follow-up",
  };
  return map[reason] ?? reason.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// ─── Quick links panel ─────────────────────────────────────────────────────

function QuickLinksPanel() {
  // Trimmed to the two destinations Stadium-mode users actually reach for
  // from /inbox: today's receipt and the morning briefing. Agent timeline
  // and the chat root live one click away through the sidebar nav already.
  const links = [
    { href: "/inbox/firewall", label: "Firewall board" },
    { href: "/inbox/receipt", label: "Today's receipt" },
    { href: "/briefing", label: "Full briefing" },
  ] as const;

  return (
    <nav className="flex flex-wrap gap-1.5">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="ease-strong inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white/70 px-2.5 py-1.5 text-[11px] font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
        >
          {link.label}
          <span className="text-slate-500">→</span>
        </Link>
      ))}
    </nav>
  );
}

// ─── Filter tab ────────────────────────────────────────────────────────────

function FilterTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`ease-strong rounded-lg px-3 py-1.5 text-xs transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        active
          ? "seg-active bg-white font-semibold text-slate-900"
          : "text-slate-500 hover:bg-white/70 hover:text-slate-900"
      }`}
    >
      {label}
    </button>
  );
}

// ─── Action card ───────────────────────────────────────────────────────────
//
// Stadium hero: one decision center stage. The card answers three questions
// in one glance — "what is it", "why it matters", "what do I do" — without
// the three-column dashboard noise of the previous design. Email bodies and
// other heavy context drop into a single disclosure so the default view
// stays a calm headline + one paragraph + three buttons.

function ActionCard({
  action,
  loading,
  onApprove,
  onReject,
  onSnooze,
}: {
  action: PendingActionItem;
  loading: "approve" | "reject" | "snooze" | null;
  onApprove: () => void;
  onReject: () => void;
  onSnooze: () => void;
}) {
  const toolName = action.toolName || "prepared_action";
  const toolArgs = action.toolArgs || "{}";
  const emailPreview = toolName === "send_email" ? buildEmailPreview(toolArgs) : null;
  const toolPreview = buildPreview(toolName, toolArgs, action.targetLabel);
  const reasoning = splitReasoning(action.reasoning);
  const isPending = action.status === "PENDING";
  const risk = riskForTool(toolName);

  // Hero subject: the most user-meaningful single line we have. Email
  // subject beats conversation title beats the per-tool preview beats a
  // humanised tool name. We never fall back to the literal "prepared_action".
  const heroSubject =
    emailPreview?.subject ||
    action.conversationTitle ||
    toolPreview ||
    (toolName === "prepared_action" ? "Decision pending" : toolName.replace(/_/g, " "));

  // Single-paragraph context. Prefer the AI's "judgment" framing because
  // that's the why-it-matters. Situation is a weaker fallback.
  const context = reasoning.judgment || reasoning.situation || action.reasoning;

  // Show the thread hint only if it isn't already in the hero (which would
  // duplicate text when conversationTitle was promoted to the subject).
  const showThreadHint = action.conversationTitle && action.conversationTitle !== heroSubject;

  return (
    <article className="row-wash relative">
      {/* Status accent bar: high risk = rose; any other pending decision = sky. */}
      {(risk === "high" || isPending) && (
        <span
          aria-hidden="true"
          className={`absolute left-0 top-0 h-full w-[3px] ${
            risk === "high" ? "bg-gradient-to-b from-rose-400 to-rose-500" : "bg-sky-400"
          }`}
        />
      )}
      {/* Top meta — just badges + relative time. No "Decision card" eyebrow,
          since the entire card already is one. */}
      <div className="flex items-center justify-between gap-2 px-5 pt-4">
        <div className="flex items-center gap-2">
          <RiskBadge risk={risk} />
          {!isPending && <StatusBadge status={action.status} />}
        </div>
        <span className="text-[11px] tabular-nums text-slate-400">
          {formatRelative(action.createdAt)}
        </span>
      </div>

      {/* Hero subject */}
      <div className="px-5 pb-1 pt-3">
        <h3 className="break-words text-2xl font-semibold leading-tight tracking-tight text-slate-900">
          {heroSubject}
        </h3>
        {showThreadHint && (
          <p className="mt-1.5 truncate text-[11px] text-slate-500">
            Thread: {action.conversationTitle}
          </p>
        )}
      </div>

      {/* Context paragraph */}
      {context && (
        <p className="px-5 pb-4 pt-2 text-sm leading-relaxed text-slate-500 line-clamp-3">
          {context}
        </p>
      )}

      {/* Outbound email body — shown INLINE, not collapsed. Approving a
          send_email dispatches real mail, so the user must see the full body
          before "Act now" rather than opting in to expand a disclosure. */}
      {emailPreview && (
        <div className="mx-5 mb-4 rounded-lg border border-slate-200 bg-slate-50">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-slate-200 px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-sky-600">
              Email to send
            </span>
            <span className="text-xs text-slate-400">To: {emailPreview.to}</span>
          </div>
          <div className="space-y-2 px-3 py-3">
            <p className="break-words text-xs text-slate-500">Subject: {emailPreview.subject}</p>
            {emailPreview.body && (
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-500">
                {emailPreview.body}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Action band */}
      {isPending && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3">
          <button
            type="button"
            onClick={onApprove}
            disabled={!!loading}
            className="glow-primary ease-strong inline-flex min-h-11 min-w-[120px] items-center justify-center gap-1.5 rounded-lg bg-gradient-to-b from-sky-400 to-sky-500 px-5 text-sm font-semibold text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading === "approve" ? (
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            ) : (
              "Act now"
            )}
          </button>
          <button
            type="button"
            onClick={onReject}
            disabled={!!loading}
            className="ease-strong inline-flex min-h-11 min-w-[80px] items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white/70 px-4 text-sm font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading === "reject" ? (
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-400/30 border-t-slate-600" />
            ) : (
              "Skip"
            )}
          </button>
          <button
            type="button"
            onClick={onSnooze}
            disabled={!!loading}
            title="Remind me in 1 hour"
            className="ease-strong inline-flex min-h-11 items-center justify-center gap-1 rounded-lg px-3 text-xs text-slate-400 transition duration-150 hover:bg-sky-50 hover:text-sky-700 active:scale-[0.97] disabled:opacity-50"
          >
            {loading === "snooze" ? (
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-400/30 border-t-slate-500" />
            ) : (
              "Snooze 1h"
            )}
          </button>
        </div>
      )}

      {!isPending && action.result && (
        <div className="border-t border-slate-100 bg-slate-50/60 px-5 py-3">
          <p className="truncate text-[11px] text-slate-400">{action.result}</p>
        </div>
      )}
    </article>
  );
}

function RiskBadge({ risk }: { risk: "low" | "medium" | "high" }) {
  const map = {
    low: {
      label: "Low risk",
      className: "bg-emerald-500/10 text-emerald-600 ring-1 ring-inset ring-emerald-500/20",
    },
    medium: {
      label: "Needs approval",
      className: "bg-amber-500/10 text-amber-600 ring-1 ring-inset ring-amber-500/20",
    },
    high: {
      label: "High risk",
      className: "bg-rose-500/10 text-rose-600 ring-1 ring-inset ring-rose-500/20",
    },
  }[risk];

  return (
    <span
      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ${map.className}`}
    >
      {map.label}
    </span>
  );
}

function riskForTool(toolName: string): "low" | "medium" | "high" {
  if (toolName.startsWith("delete_") || toolName === "archive_email") return "high";
  if (
    toolName === "send_email" ||
    toolName === "create_event" ||
    toolName === "create_contact" ||
    toolName === "update_contact"
  ) {
    return "medium";
  }
  return "low";
}

function splitReasoning(reasoning: string | null): {
  situation: string | null;
  judgment: string | null;
  proposal: string | null;
} {
  if (!reasoning) return { situation: null, judgment: null, proposal: null };

  const read = (label: "Situation" | "Judgment" | "Proposal"): string | null => {
    const labels = ["Situation", "Judgment", "Proposal"].filter((item) => item !== label).join("|");
    const match = reasoning.match(
      new RegExp(
        `(?:📋|💡|✅)?\\s*${label}\\s*[:：]\\s*([\\s\\S]*?)(?=(?:📋|💡|✅)?\\s*(?:${labels})\\s*[:：]|$)`,
      ),
    );
    return match?.[1]?.trim() || null;
  };

  const situation = read("Situation");
  const judgment = read("Judgment");
  const proposal = read("Proposal");
  if (situation || judgment || proposal) return { situation, judgment, proposal };

  return { situation: null, judgment: reasoning.trim(), proposal: null };
}

function StatusBadge({ status }: { status: PendingActionItem["status"] }) {
  const map: Record<PendingActionItem["status"], { label: string; className: string }> = {
    PENDING: {
      label: "Pending",
      className: "bg-amber-500/10 text-amber-600 ring-1 ring-inset ring-amber-500/20",
    },
    EXECUTED: {
      label: "Done",
      className: "bg-emerald-500/10 text-emerald-600 ring-1 ring-inset ring-emerald-500/20",
    },
    REJECTED: {
      label: "Rejected",
      className: "bg-slate-100 text-slate-500",
    },
    FAILED: {
      label: "Failed",
      className: "bg-rose-500/10 text-rose-600 ring-1 ring-inset ring-rose-500/20",
    },
  };
  const entry = map[status];
  return (
    <span
      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ${entry.className}`}
    >
      {entry.label}
    </span>
  );
}

function buildPreview(
  toolName: string,
  rawArgs: string,
  targetLabel: string | null,
): string | null {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return null;
  }
  const pick = (key: string): string | undefined => {
    const v = args[key];
    return typeof v === "string" ? v : undefined;
  };
  if (toolName === "send_email") {
    return `To: ${pick("to") || "?"} · ${pick("subject") || "No subject"}`;
  }
  if (toolName === "create_event") {
    const start = pick("startTime");
    const when = start
      ? new Date(start).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    const loc = pick("location");
    return `${pick("title") || "Event"}${when ? ` · ${when}` : ""}${loc ? ` · ${loc}` : ""}`;
  }
  if (toolName === "create_task" || toolName === "create_note") {
    return pick("title") || "Untitled";
  }
  if (toolName === "create_contact") {
    const email = pick("email");
    return `${pick("name") || "?"}${email ? ` (${email})` : ""}`;
  }
  if (toolName === "delete_task" || toolName === "delete_note" || toolName === "delete_contact") {
    const idKey =
      toolName === "delete_task"
        ? "task_id"
        : toolName === "delete_note"
          ? "note_id"
          : "contact_id";
    return `Delete: ${targetLabel || pick(idKey) || "?"}`;
  }
  if (toolName === "update_task" || toolName === "update_note" || toolName === "update_contact") {
    const idKey =
      toolName === "update_task"
        ? "task_id"
        : toolName === "update_note"
          ? "note_id"
          : "contact_id";
    return `Update: ${targetLabel || pick(idKey) || "?"}`;
  }
  return null;
}

function buildEmailPreview(
  rawArgs: string,
): { to: string; subject: string; body: string | null } | null {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return null;
  }
  const pick = (key: string): string | null => {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  return {
    to: pick("to") || pick("recipient") || "?",
    subject: pick("subject") || "No subject",
    body: pick("body") || pick("message"),
  };
}

// ─── Mobile native screen ──────────────────────────────────────────────────
//
// A purpose-built phone layout, not the desktop dashboard with chrome hidden.
// Rendered only below md; the desktop two-column layout above is untouched.
// iOS-style large title, segmented control, soft full-width cards.

function MobileDecisionQueue({
  actions,
  commitments,
  pendingCount,
  filter,
  setFilter,
  loading,
  onRefresh,
  actionLoading,
  onApprove,
  onReject,
  onSnooze,
}: {
  actions: PendingActionItem[];
  commitments: CommitmentItem[];
  pendingCount: number;
  filter: StatusFilter;
  setFilter: (f: StatusFilter) => void;
  loading: boolean;
  onRefresh: () => void;
  actionLoading: Record<string, "approve" | "reject" | "snooze" | null>;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onSnooze: (id: string) => void;
}) {
  const { t } = useT();
  const title =
    pendingCount > 0
      ? t("inbox.decisions")
      : commitments.length > 0
        ? t("inbox.tracking")
        : t("inbox.allClear");
  const subtitle =
    pendingCount > 0
      ? `${pendingCount} waiting for you`
      : commitments.length > 0
        ? `${commitments.length} commitment${commitments.length !== 1 ? "s" : ""} in the background`
        : t("inbox.nothingNeedsYou");

  return (
    <div>
      <header className="mb-5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-none tracking-tight text-slate-900">
            {title}
          </h1>
          <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition active:bg-slate-200 disabled:opacity-50"
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
            className={loading ? "animate-spin" : ""}
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
      </header>

      {actions.length > 0 && (
        <div
          role="group"
          aria-label="Filter decisions"
          className="mb-4 flex gap-1 rounded-xl bg-slate-100 p-1"
        >
          <MobileSeg
            active={filter === "pending"}
            label={`Pending${pendingCount ? ` · ${pendingCount}` : ""}`}
            onClick={() => setFilter("pending")}
          />
          <MobileSeg active={filter === "all"} label="All" onClick={() => setFilter("all")} />
        </div>
      )}

      {loading && actions.length === 0 && (
        <div className="space-y-3">
          <div className="h-28 animate-pulse rounded-2xl bg-slate-100" />
          <div className="h-28 animate-pulse rounded-2xl bg-slate-100" />
        </div>
      )}

      {!loading && actions.length === 0 && <MobileEmpty commitmentCount={commitments.length} />}

      {actions.length > 0 && (
        <ul className="space-y-3">
          {actions.map((action) => (
            <li key={action.id}>
              <MobileActionCard
                action={action}
                loading={actionLoading[action.id] ?? null}
                onApprove={() => onApprove(action.id)}
                onReject={() => onReject(action.id)}
                onSnooze={() => onSnooze(action.id)}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-7">
        <ReplyNeededPanel />
      </div>
    </div>
  );
}

function MobileSeg({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex-1 rounded-lg py-2 text-[13px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 active:text-slate-900"
      }`}
    >
      {label}
    </button>
  );
}

function MobileEmpty({ commitmentCount }: { commitmentCount: number }) {
  const { t } = useT();
  return (
    <div className="rounded-2xl bg-slate-50 px-6 py-12 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
        <svg
          aria-hidden="true"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-emerald-500"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <p className="text-base font-medium text-slate-900">{t("inbox.nothingToDecide")}</p>
      <p className="mx-auto mt-1.5 max-w-xs text-[13px] leading-relaxed text-slate-400">
        {commitmentCount > 0
          ? `Klorn is watching your mail and calendar. ${commitmentCount} tracked in the background.`
          : t("inbox.emptyBodyMobile")}
      </p>
    </div>
  );
}

function MobileActionCard({
  action,
  loading,
  onApprove,
  onReject,
  onSnooze,
}: {
  action: PendingActionItem;
  loading: "approve" | "reject" | "snooze" | null;
  onApprove: () => void;
  onReject: () => void;
  onSnooze: () => void;
}) {
  // Same derivation as the desktop ActionCard, kept local so the desktop card
  // is never affected by mobile-only changes.
  const toolName = action.toolName || "prepared_action";
  const toolArgs = action.toolArgs || "{}";
  const emailPreview = toolName === "send_email" ? buildEmailPreview(toolArgs) : null;
  const toolPreview = buildPreview(toolName, toolArgs, action.targetLabel);
  const reasoning = splitReasoning(action.reasoning);
  const isPending = action.status === "PENDING";
  const risk = riskForTool(toolName);
  const heroSubject =
    emailPreview?.subject ||
    action.conversationTitle ||
    toolPreview ||
    (toolName === "prepared_action" ? "Decision pending" : toolName.replace(/_/g, " "));
  const context = reasoning.judgment || reasoning.situation || action.reasoning;

  return (
    <article className="overflow-hidden rounded-2xl bg-slate-50">
      <div className="flex items-center justify-between gap-2 px-4 pt-3.5">
        <RiskBadge risk={risk} />
        <span className="text-[11px] text-slate-400">{formatRelative(action.createdAt)}</span>
      </div>
      <div className="px-4 pt-2.5">
        <h3 className="break-words text-[17px] font-semibold leading-snug tracking-tight text-slate-900">
          {heroSubject}
        </h3>
        {context && (
          <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-slate-500">
            {context}
          </p>
        )}
        {/* Outbound body inline so a send_email can't be approved unseen. */}
        {emailPreview && (
          <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-sky-600">
              Email to send
            </p>
            <p className="mt-1 break-words text-[11px] text-slate-400">To: {emailPreview.to}</p>
            <p className="mt-1 break-words text-xs text-slate-500">
              Subject: {emailPreview.subject}
            </p>
            {emailPreview.body && (
              <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-slate-500">
                {emailPreview.body}
              </p>
            )}
          </div>
        )}
      </div>
      {isPending ? (
        <div className="mt-3.5 space-y-2 px-4 pb-4">
          <button
            type="button"
            onClick={onApprove}
            disabled={!!loading}
            className="glow-primary ease-strong flex min-h-12 w-full items-center justify-center rounded-xl bg-gradient-to-b from-sky-400 to-sky-500 text-[15px] font-semibold text-white transition duration-150 active:scale-[0.97] disabled:opacity-50"
          >
            {loading === "approve" ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            ) : (
              "Act now"
            )}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onReject}
              disabled={!!loading}
              className="flex min-h-11 flex-1 items-center justify-center rounded-xl border border-slate-200 text-sm font-medium text-slate-500 transition active:bg-slate-100 disabled:opacity-50"
            >
              {loading === "reject" ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-400/30 border-t-slate-600" />
              ) : (
                "Skip"
              )}
            </button>
            <button
              type="button"
              onClick={onSnooze}
              disabled={!!loading}
              className="flex min-h-11 flex-1 items-center justify-center rounded-xl border border-slate-200 text-sm text-slate-500 transition active:bg-slate-100 disabled:opacity-50"
            >
              {loading === "snooze" ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-400/30 border-t-slate-500" />
              ) : (
                "Snooze 1h"
              )}
            </button>
          </div>
        </div>
      ) : (
        action.result && (
          <div className="mt-2 px-4 pb-4">
            <p className="truncate text-[11px] text-slate-400">{action.result}</p>
          </div>
        )
      )}
    </article>
  );
}
