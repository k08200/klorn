"use client";

import { useQueries, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import type { CommitmentItem } from "../../components/commitment-card";
import { useToast } from "../../components/toast";
import WorkGraphSummaryCard from "../../components/work-graph-summary";
import { apiFetch } from "../../lib/api";
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
  const [actionLoading, setActionLoading] = useState<
    Record<string, "approve" | "reject" | "snooze" | null>
  >({});
  const { toast } = useToast();

  // Parallel fetch via useQueries. Each branch has independent loading
  // and error state so a flaky endpoint never blocks the other.
  const results = useQueries({
    queries: [
      {
        queryKey: [...queryKeys.inbox.pending(), filter] as const,
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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.inbox.pending() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inbox.commitments() }),
      ]);
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

  const handleReject = async (actionId: string) => {
    if (actionLoading[actionId]) return;
    setActionLoading((prev) => ({ ...prev, [actionId]: "reject" }));
    try {
      await apiFetch(`/api/chat/pending-actions/${actionId}/reject`, {
        method: "POST",
        body: JSON.stringify({}),
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
      queryClient.setQueryData<PendingActionItem[]>(
        [...queryKeys.inbox.pending(), filter] as unknown as readonly unknown[],
        (prev) =>
          filter === "pending"
            ? (prev ?? []).filter((a) => a.id !== actionId)
            : (prev ?? []).map((a) => (a.id === actionId ? { ...a, status: "REJECTED" } : a)),
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
  const introLine = buildIntroLine(pendingCount);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:py-8">
      {/* Minimal page header */}
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300">
            Klorn · Command Center
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-stone-50">
            {pendingCount > 0
              ? `${pendingCount} decision${pendingCount !== 1 ? "s" : ""} waiting`
              : commitments.length > 0
                ? `${commitments.length} commitment${commitments.length !== 1 ? "s" : ""} tracked`
                : "All clear"}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => load(filter)}
            disabled={loading}
            className="h-8 rounded-md border border-stone-700 bg-stone-950/70 px-3 text-xs text-stone-300 transition hover:bg-stone-800 disabled:opacity-50"
          >
            {loading ? "..." : "Refresh"}
          </button>
          <Link
            href="/inbox/receipt"
            className="hidden text-xs text-teal-400 hover:text-teal-300 transition sm:block"
          >
            Today's receipt →
          </Link>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* 2-column Stadium grid — narrow right rail keeps focus on the hero. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
        {/* ── LEFT: Stadium hero ── */}
        <div className="min-w-0 space-y-6">
          {/* E-voice intro — only when decisions exist */}
          {introLine && (
            <p className="text-[15px] leading-relaxed text-stone-300">
              <span className="text-stone-500">용린님,</span> {introLine}
            </p>
          )}

          {/* Approval Queue — the only main-page content */}
          <section aria-label="Approval queue">
            {actions.length > 0 && (
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {pendingCount > 0 && (
                    <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                      {pendingCount} pending
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 rounded-lg border border-stone-800 bg-stone-950/80 p-1">
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
            )}

            {loading && actions.length === 0 && (
              <div className="space-y-2 rounded-xl border border-stone-800 bg-stone-900/30 p-4">
                <div className="h-20 animate-pulse rounded-lg bg-stone-800/60" />
                <div className="h-20 animate-pulse rounded-lg bg-stone-800/40" />
              </div>
            )}

            {!loading && actions.length === 0 && (
              <HonestEmptyState commitmentCount={commitments.length} />
            )}

            {actions.length > 0 && (
              <ul className="space-y-3">
                {actions.map((action) => (
                  <li key={action.id}>
                    <ActionCard
                      action={action}
                      loading={actionLoading[action.id] ?? null}
                      onApprove={() => handleApprove(action.id)}
                      onReject={() => handleReject(action.id)}
                      onSnooze={() => handleSnooze(action.id, 1)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Commitment Ledger now lives on its own page (added in next PR).
              Until then, just a slim link when commitments exist. */}
          {commitments.length > 0 && (
            <Link
              href="/ledger"
              className="flex items-center justify-between rounded-lg border border-stone-800 bg-stone-900/30 px-4 py-3 text-sm text-stone-300 transition hover:border-stone-700 hover:bg-stone-900/50"
            >
              <span>
                <span className="text-stone-500">오늘 추적 중인 약속</span>{" "}
                <span className="text-stone-100">{commitments.length}건</span>
              </span>
              <span className="text-stone-500">Ledger 열기 →</span>
            </Link>
          )}
        </div>

        {/* ── RIGHT: Slim Work Graph rail ── */}
        <div className="space-y-4">
          <WorkGraphSummaryCard />
          <ReplyNeededPanel />
          <QuickLinksPanel />
        </div>
      </div>
    </div>
  );
}

// ─── E-voice intro line ────────────────────────────────────────────────────

function buildIntroLine(pendingCount: number): string | null {
  if (pendingCount === 0) return null;
  if (pendingCount === 1) return "결정하실 안건이 한 건 도착했습니다.";
  return `결정하실 안건이 ${pendingCount}건 있습니다.`;
}

// ─── Honest empty state ────────────────────────────────────────────────────

function HonestEmptyState({ commitmentCount }: { commitmentCount: number }) {
  return (
    <div className="rounded-xl border border-stone-800 bg-stone-900/30 p-8 text-center">
      <p className="text-base text-stone-200">오늘은 결정할 게 없습니다.</p>
      <p className="mx-auto mt-2 max-w-sm text-xs text-stone-500">
        {commitmentCount > 0
          ? `Klorn이 메일과 캘린더를 모니터링 중입니다. 추적 중인 약속 ${commitmentCount}건은 Ledger에서 볼 수 있어요.`
          : "Klorn이 메일과 캘린더를 모니터링 중입니다. 결정이 필요한 안건이 생기면 여기서 알려드려요."}
      </p>
      <div className="mt-5 flex justify-center gap-2">
        <Link
          href="/settings"
          className="inline-flex min-h-9 items-center justify-center rounded-md border border-stone-700 px-4 text-xs text-stone-300 transition hover:bg-stone-800"
        >
          Settings
        </Link>
        <Link
          href="/email"
          className="inline-flex min-h-9 items-center justify-center rounded-md border border-stone-700 px-4 text-xs text-stone-300 transition hover:bg-stone-800"
        >
          메일 열기
        </Link>
      </div>
    </div>
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
      <div className="rounded-xl border border-stone-800 bg-stone-900/30 p-4">
        <div className="h-6 w-24 animate-pulse rounded bg-stone-800/60" />
        <div className="mt-3 space-y-2">
          <div className="h-12 animate-pulse rounded-lg bg-stone-800/50" />
          <div className="h-12 animate-pulse rounded-lg bg-stone-800/40" />
        </div>
      </div>
    );
  }

  if (emails.length === 0) return null;

  return (
    <section
      className="rounded-xl border border-stone-800 bg-stone-900/30 p-4"
      aria-label="Reply needed"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-stone-100">Reply Needed</h2>
        <span className="text-[11px] text-stone-500">{emails.length}</span>
      </div>
      <ul className="space-y-2">
        {emails.map((email) => (
          <li key={email.id}>
            <Link
              href="/email"
              className="block rounded-lg border border-stone-800/60 bg-black/15 p-3 transition hover:bg-stone-800/40"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="flex-1 truncate text-xs font-medium text-stone-200">
                  {email.subject || "(no subject)"}
                </p>
                <span className="shrink-0 rounded border border-amber-300/20 bg-amber-300/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                  {Math.round(email.needsReplyConfidence * 100)}%
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-stone-500">{formatFrom(email.from)}</p>
              {email.needsReplyReason && (
                <p className="mt-1 line-clamp-1 text-[11px] text-stone-400">
                  {email.needsReplyReason}
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex justify-end">
        <Link href="/email" className="text-xs text-stone-500 transition hover:text-stone-300">
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

// ─── Quick links panel ─────────────────────────────────────────────────────

function QuickLinksPanel() {
  const links = [
    { href: "/inbox/receipt", label: "Today's receipt" },
    { href: "/briefing", label: "Full briefing" },
    { href: "/agent", label: "Agent timeline" },
    { href: "/chat", label: "Start a thread" },
  ] as const;

  return (
    <div className="rounded-xl border border-stone-800 bg-stone-900/30 p-4">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
        Quick links
      </p>
      <nav className="space-y-0.5">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="flex items-center justify-between rounded-md px-2 py-2 text-xs text-stone-400 transition hover:bg-stone-800 hover:text-stone-200"
          >
            <span>{link.label}</span>
            <span className="text-stone-600">→</span>
          </Link>
        ))}
      </nav>
    </div>
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
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-xs transition ${
        active ? "bg-stone-800 text-white" : "text-stone-400 hover:text-stone-200"
      }`}
    >
      {label}
    </button>
  );
}

// ─── Action card ───────────────────────────────────────────────────────────

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
  const preview = buildPreview(toolName, toolArgs, action.targetLabel);
  const emailPreview = toolName === "send_email" ? buildEmailPreview(toolArgs) : null;
  const reasoning = splitReasoning(action.reasoning);
  const isPending = action.status === "PENDING";
  const risk = riskForTool(toolName);

  return (
    <article className="relative overflow-hidden rounded-lg border border-stone-800 bg-stone-950/70">
      <div className="absolute bottom-0 left-0 top-0 w-1 bg-gradient-to-b from-amber-300 via-teal-300 to-stone-100" />
      <div className="border-b border-stone-800 bg-stone-900/50 px-4 py-3 pl-5 md:px-5 md:pl-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-300">
              Decision card
            </span>
            <StatusBadge status={action.status} />
          </div>
          <span className="text-[11px] text-stone-600">{formatRelative(action.createdAt)}</span>
        </div>
      </div>

      <div className="p-4 pl-5 md:p-5 md:pl-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-amber-200 bg-amber-300/10 border border-amber-300/20 rounded px-1.5 py-0.5">
              {toolName === "prepared_action" ? "Prepared action" : toolName.replace(/_/g, " ")}
            </span>
            <RiskBadge risk={risk} />
            {action.conversationTitle && (
              <span className="min-w-0 truncate text-[11px] text-stone-600">
                Thread: {action.conversationTitle}
              </span>
            )}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <DecisionSection
              label="Signal"
              title="What Klorn found"
              body={
                reasoning.situation ||
                action.conversationTitle ||
                "Klorn reviewed the connected thread and work signals."
              }
            />
            <DecisionSection
              label="Judgment"
              title="Why it matters"
              body={reasoning.judgment || action.reasoning || "Review is needed before execution."}
            />
            <DecisionSection
              label="Action"
              title="Prepared move"
              body={
                reasoning.proposal ||
                preview ||
                action.preview ||
                (toolName === "prepared_action" ? "Prepared action" : toolName.replace(/_/g, " "))
              }
            />
          </div>

          {emailPreview && (
            <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-amber-300">
                  Approval required before sending
                </span>
                <span className="text-[11px] text-stone-500">send_email</span>
              </div>
              <p className="mt-2 text-xs text-stone-300 break-words">To: {emailPreview.to}</p>
              <p className="mt-1 text-xs text-stone-400 break-words">
                Subject: {emailPreview.subject}
              </p>
              {emailPreview.body && (
                <p className="mt-2 text-xs leading-relaxed text-stone-300 line-clamp-4 whitespace-pre-wrap">
                  {emailPreview.body}
                </p>
              )}
            </div>
          )}

          {isPending && (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-stone-800 pt-4">
              <button
                type="button"
                onClick={onApprove}
                disabled={!!loading}
                className="inline-flex min-w-[88px] items-center justify-center gap-1.5 rounded-md bg-amber-400 px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading === "approve" ? (
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-stone-950/30 border-t-stone-950" />
                ) : (
                  "Approve"
                )}
              </button>
              <button
                type="button"
                onClick={onReject}
                disabled={!!loading}
                className="inline-flex min-w-[88px] items-center justify-center gap-1.5 rounded-md border border-stone-600 px-4 py-2 text-sm font-medium text-stone-300 transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading === "reject" ? (
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-stone-300/30 border-t-stone-200" />
                ) : (
                  "Reject"
                )}
              </button>
              <button
                type="button"
                onClick={onSnooze}
                disabled={!!loading}
                title="Remind me in 1 hour"
                className="inline-flex items-center justify-center gap-1 px-3 py-2 text-xs text-stone-500 hover:text-stone-300 transition disabled:opacity-50"
              >
                {loading === "snooze" ? (
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-stone-500/30 border-t-stone-400" />
                ) : (
                  "Snooze 1h"
                )}
              </button>
              <Link
                href={`/chat/${action.conversationId}`}
                className="text-xs text-amber-300 hover:text-amber-200 ml-auto transition"
              >
                Open thread →
              </Link>
            </div>
          )}

          {!isPending && (
            <div className="flex items-center justify-between mt-4 border-t border-stone-800 pt-3">
              {action.result && (
                <p className="text-[11px] text-stone-500 truncate flex-1">{action.result}</p>
              )}
              <Link
                href={`/chat/${action.conversationId}`}
                className="text-xs text-stone-400 hover:text-stone-200 transition shrink-0 ml-2"
              >
                Open thread →
              </Link>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function DecisionSection({ label, title, body }: { label: string; title: string; body: string }) {
  return (
    <section className="rounded-lg border border-stone-800 bg-black/20 p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300">{label}</p>
      <h3 className="mt-2 text-xs font-semibold text-stone-200">{title}</h3>
      <p className="mt-2 text-xs leading-5 text-stone-400">{body}</p>
    </section>
  );
}

function RiskBadge({ risk }: { risk: "low" | "medium" | "high" }) {
  const map = {
    low: {
      label: "Low risk",
      className: "text-emerald-300 bg-emerald-400/10 border-emerald-400/20",
    },
    medium: {
      label: "Needs approval",
      className: "text-amber-300 bg-amber-400/10 border-amber-400/20",
    },
    high: {
      label: "High risk",
      className: "text-red-300 bg-red-500/10 border-red-500/20",
    },
  }[risk];

  return (
    <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 ${map.className}`}>
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
    PENDING: { label: "Pending", className: "text-amber-300 bg-amber-400/10 border-amber-400/20" },
    EXECUTED: {
      label: "Done",
      className: "text-emerald-300 bg-emerald-400/10 border-emerald-400/20",
    },
    REJECTED: {
      label: "Rejected",
      className: "text-stone-400 bg-stone-500/10 border-stone-500/20",
    },
    FAILED: { label: "Failed", className: "text-red-300 bg-red-500/10 border-red-500/20" },
  };
  const entry = map[status];
  return (
    <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 ${entry.className}`}>
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
