"use client";

import { useQueries, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import type { CommitmentItem } from "../../components/commitment-card";
import { useToast } from "../../components/toast";
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
      <OnboardingHint />
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
          {introLine && <p className="text-[15px] leading-relaxed text-stone-300">{introLine}</p>}

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
        </div>

        <div className="space-y-4">
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
  if (pendingCount === 1) return "One decision is waiting for you.";
  return `${pendingCount} decisions are waiting for you.`;
}

// ─── Honest empty state ────────────────────────────────────────────────────

function HonestEmptyState({ commitmentCount }: { commitmentCount: number }) {
  return (
    <div className="rounded-xl border border-stone-800 bg-stone-900/30 p-8 text-center">
      <p className="text-base text-stone-200">Nothing to decide today.</p>
      <p className="mx-auto mt-2 max-w-sm text-xs text-stone-500">
        {commitmentCount > 0
          ? `Klorn is watching your mail and calendar. ${commitmentCount} tracked commitment${commitmentCount === 1 ? "" : "s"} in the background.`
          : "Klorn is watching your mail and calendar. When something needs a decision, it lands here."}
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
          Open mail
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
  const [dismissed, setDismissed] = useState<boolean | null>(null);

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
    <div className="mb-5 rounded-xl border border-amber-300/30 bg-amber-300/5 p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-300">
            New here? 30-second tour
          </p>
          <ul className="space-y-1 text-[13px] leading-5 text-stone-300">
            <li>
              1. <span className="text-stone-100">This page</span> — agent decisions waiting on your
              approval.
            </li>
            <li>
              2.{" "}
              <Link href="/inbox/firewall" className="text-amber-200 hover:text-amber-100">
                POC firewall view
              </Link>{" "}
              — see every signal sorted into SILENT / QUEUE / PUSH. Move what we got wrong.
            </li>
            <li>
              3.{" "}
              <Link href="/settings" className="text-amber-200 hover:text-amber-100">
                Settings → Connections
              </Link>{" "}
              — connect Google so Klorn can read mail and calendar.
            </li>
            <li>
              4.{" "}
              <Link href="/inbox/receipt" className="text-amber-200 hover:text-amber-100">
                Today's receipt
              </Link>{" "}
              — what Klorn silenced, surfaced, and auto-handled today.
            </li>
          </ul>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-md border border-stone-700 px-2.5 py-1 text-[11px] text-stone-400 transition hover:border-stone-500 hover:text-stone-200"
        >
          Dismiss
        </button>
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
  // Trimmed to the two destinations Stadium-mode users actually reach for
  // from /inbox: today's receipt and the morning briefing. Agent timeline
  // and the chat root live one click away through the sidebar nav already.
  const links = [
    { href: "/inbox/firewall", label: "POC firewall view" },
    { href: "/inbox/receipt", label: "Today's receipt" },
    { href: "/briefing", label: "Full briefing" },
  ] as const;

  return (
    <nav className="flex flex-wrap gap-1.5">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="inline-flex items-center gap-1 rounded-md border border-stone-800 bg-stone-900/30 px-2.5 py-1.5 text-[11px] text-stone-400 transition hover:border-stone-700 hover:bg-stone-900/60 hover:text-stone-200"
        >
          {link.label}
          <span className="text-stone-600">→</span>
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
    <article className="overflow-hidden rounded-xl border border-amber-300/25 bg-stone-950/70">
      {/* Top meta — just badges + relative time. No "Decision card" eyebrow,
          since the entire card already is one. */}
      <div className="flex items-center justify-between gap-2 px-5 pt-4">
        <div className="flex items-center gap-2">
          <RiskBadge risk={risk} />
          {!isPending && <StatusBadge status={action.status} />}
        </div>
        <span className="font-mono text-[11px] text-stone-600">
          {formatRelative(action.createdAt)}
        </span>
      </div>

      {/* Hero subject */}
      <div className="px-5 pb-1 pt-3">
        <h3 className="break-words text-2xl font-semibold leading-tight tracking-tight text-stone-50">
          {heroSubject}
        </h3>
        {showThreadHint && (
          <p className="mt-1.5 truncate text-[11px] text-stone-600">
            Thread: {action.conversationTitle}
          </p>
        )}
      </div>

      {/* Context paragraph */}
      {context && (
        <p className="px-5 pb-4 pt-2 text-sm leading-relaxed text-stone-300 line-clamp-3">
          {context}
        </p>
      )}

      {/* Email body disclosure — hidden by default to keep the card calm */}
      {emailPreview && (
        <details className="mx-5 mb-4 rounded-lg border border-stone-800 bg-black/20">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs text-stone-400 transition hover:text-stone-200">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300">
              Email body
            </span>
            <span className="ml-2 text-stone-500">To: {emailPreview.to}</span>
          </summary>
          <div className="space-y-2 border-t border-stone-800 px-3 py-3">
            <p className="break-words text-xs text-stone-300">Subject: {emailPreview.subject}</p>
            {emailPreview.body && (
              <p className="line-clamp-8 whitespace-pre-wrap text-xs leading-relaxed text-stone-300">
                {emailPreview.body}
              </p>
            )}
          </div>
        </details>
      )}

      {/* Action band */}
      {isPending && (
        <div className="flex flex-wrap items-center gap-2 border-t border-stone-800 bg-stone-900/40 px-5 py-3">
          <button
            type="button"
            onClick={onApprove}
            disabled={!!loading}
            className="inline-flex min-h-11 min-w-[120px] items-center justify-center gap-1.5 rounded-lg bg-amber-400 px-5 text-sm font-semibold text-stone-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading === "approve" ? (
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-stone-950/30 border-t-stone-950" />
            ) : (
              "Act now"
            )}
          </button>
          <button
            type="button"
            onClick={onReject}
            disabled={!!loading}
            className="inline-flex min-h-11 min-w-[80px] items-center justify-center gap-1.5 rounded-lg border border-stone-700 px-4 text-sm font-medium text-stone-300 transition hover:border-stone-500 hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading === "reject" ? (
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-stone-300/30 border-t-stone-200" />
            ) : (
              "Skip"
            )}
          </button>
          <button
            type="button"
            onClick={onSnooze}
            disabled={!!loading}
            title="Remind me in 1 hour"
            className="inline-flex min-h-11 items-center justify-center gap-1 px-3 text-xs text-stone-500 transition hover:text-stone-300 disabled:opacity-50"
          >
            {loading === "snooze" ? (
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-stone-500/30 border-t-stone-400" />
            ) : (
              "Snooze 1h"
            )}
          </button>
        </div>
      )}

      {!isPending && action.result && (
        <div className="border-t border-stone-800 bg-stone-900/40 px-5 py-3">
          <p className="truncate text-[11px] text-stone-500">{action.result}</p>
        </div>
      )}
    </article>
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
