"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import BetaLearningCard from "../../components/beta-learning-card";
import { EveSignalField } from "../../components/brand-visuals";
import BriefingCard from "../../components/briefing-card";
import CommandCenterSummary from "../../components/command-center-summary";
import OperatingLoopCard from "../../components/operating-loop-card";
import PlaybookRecommendations from "../../components/playbook-recommendations";
import WorkGraphSummaryCard from "../../components/work-graph-summary";
import { apiFetch } from "../../lib/api";
import { captureClientError } from "../../lib/sentry";

interface PendingActionItem {
  id: string;
  conversationId: string;
  conversationTitle: string | null;
  status: "PENDING" | "REJECTED" | "EXECUTED" | "FAILED";
  toolName: string;
  toolArgs: string;
  preview?: string | null;
  /** Server-resolved human label (task title, contact name, …) — null when n/a */
  targetLabel: string | null;
  reasoning: string | null;
  result: string | null;
  createdAt: string;
}

interface CommitmentItem {
  id: string;
  title: string;
  description: string | null;
  status: "OPEN" | "DONE" | "DISMISSED" | "SNOOZED";
  kind: "DELIVERABLE" | "FOLLOW_UP" | "DECISION" | "MEETING" | "REVIEW";
  owner: "USER" | "COUNTERPARTY" | "TEAM" | "UNKNOWN";
  dueAt: string | null;
  dueText: string | null;
  sourceType: string;
  confidence: number;
  createdAt: string;
}

type StatusFilter = "pending" | "all";

export default function InboxPage() {
  return (
    <AuthGuard>
      <InboxView />
    </AuthGuard>
  );
}

function InboxView() {
  const [actions, setActions] = useState<PendingActionItem[]>([]);
  const [commitments, setCommitments] = useState<CommitmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("pending");
  const [actionLoading, setActionLoading] = useState<Record<string, "approve" | "reject" | null>>(
    {},
  );
  const [commitmentLoading, setCommitmentLoading] = useState<
    Record<string, "done" | "dismiss" | null>
  >({});

  const load = useCallback(async (statusFilter: StatusFilter) => {
    setLoading(true);
    setError(null);
    try {
      const qs = statusFilter === "all" ? "?status=all" : "";
      const [actionData, commitmentData] = await Promise.all([
        apiFetch<{ actions: PendingActionItem[] }>(`/api/chat/pending-actions${qs}`),
        apiFetch<{ commitments: CommitmentItem[] }>("/api/commitments?status=OPEN&limit=8"),
      ]);
      setActions(Array.isArray(actionData.actions) ? actionData.actions : []);
      setCommitments(Array.isArray(commitmentData.commitments) ? commitmentData.commitments : []);
    } catch (err) {
      captureClientError(err, { scope: "inbox.load" });
      setError("결정함을 불러오지 못했어요.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filter);
  }, [filter, load]);

  // Refresh when a new pending action arrives (websocket fires "conversations-updated")
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
      setActions((prev) => prev.map((a) => (a.id === actionId ? { ...a, status: "EXECUTED" } : a)));
    } catch (err) {
      captureClientError(err, { scope: "inbox.approve", actionId });
      alert("이 작업을 승인하지 못했어요. 다시 시도해 주세요.");
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
      setActions((prev) => prev.map((a) => (a.id === actionId ? { ...a, status: "REJECTED" } : a)));
    } catch (err) {
      captureClientError(err, { scope: "inbox.reject", actionId });
      alert("이 작업을 거절하지 못했어요. 다시 시도해 주세요.");
    } finally {
      setActionLoading((prev) => ({ ...prev, [actionId]: null }));
    }
  };

  const handleCommitmentStatus = async (commitmentId: string, status: "DONE" | "DISMISSED") => {
    if (commitmentLoading[commitmentId]) return;
    const loadingState = status === "DONE" ? "done" : "dismiss";
    setCommitmentLoading((prev) => ({ ...prev, [commitmentId]: loadingState }));
    try {
      await apiFetch(`/api/commitments/${commitmentId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setCommitments((prev) => prev.filter((c) => c.id !== commitmentId));
      window.dispatchEvent(new Event("conversations-updated"));
    } catch (err) {
      captureClientError(err, { scope: "inbox.commitment_status", commitmentId, status });
      alert("약속 상태를 업데이트하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
    } finally {
      setCommitmentLoading((prev) => ({ ...prev, [commitmentId]: null }));
    }
  };

  const pendingCount = actions.filter((a) => a.status === "PENDING").length;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:py-10">
      <header className="mb-6 overflow-hidden rounded-lg border border-amber-300/15 bg-stone-950/65 shadow-2xl shadow-black/20">
        <div className="h-1 bg-gradient-to-r from-amber-300 via-stone-500 to-teal-300" />
        <div className="p-5 md:p-6">
          <div className="grid gap-5 lg:grid-cols-[1fr_300px] lg:items-stretch">
            <div className="max-w-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300">
                결정함
              </p>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-50 md:text-3xl">
                흩어진 업무 신호를 바로 승인할 수 있는 결정으로 바꿉니다.
              </h1>
              <p className="mt-3 text-sm leading-6 text-stone-400">
                실행 전에 Jigeum이 무엇을 찾았고, 왜 중요한지, 어떤 행동이 준비됐는지 확인하세요.
              </p>
            </div>
            <div className="relative min-h-40 overflow-hidden rounded-lg border border-stone-800 bg-black/20">
              <EveSignalField className="absolute inset-0 border-0" />
              <button
                type="button"
                onClick={() => load(filter)}
                disabled={loading}
                className="absolute right-3 top-3 h-9 rounded-md border border-stone-700 bg-stone-950/70 px-3 text-xs text-stone-300 backdrop-blur transition hover:bg-stone-800 disabled:opacity-50"
                aria-label="결정함 새로고침"
              >
                {loading ? "..." : "새로고침"}
              </button>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-3 overflow-hidden rounded-xl border border-white/10 bg-black/25">
            <QueueMetric label="승인 대기" value={pendingCount} />
            <QueueMetric label="전체 카드" value={actions.length} />
            <QueueMetric label="열린 약속" value={commitments.length} />
          </div>

          <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex w-fit items-center gap-1 rounded-lg border border-stone-800 bg-stone-950/80 p-1">
              <FilterTab
                active={filter === "pending"}
                label={`대기${pendingCount ? ` (${pendingCount})` : ""}`}
                onClick={() => setFilter("pending")}
              />
              <FilterTab active={filter === "all"} label="전체" onClick={() => setFilter("all")} />
            </div>
            <p className="text-xs text-stone-600">
              승인 전에 신호, 판단, 실행 내용을 모두 볼 수 있습니다.
            </p>
          </div>
        </div>
      </header>

      <OperatingLoopCard />
      <BetaLearningCard />

      {loading && actions.length === 0 && (
        <p className="text-sm text-stone-500 py-8 text-center">불러오는 중...</p>
      )}

      {error && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {!loading && !error && actions.length === 0 && commitments.length === 0 && (
        <div className="rounded-lg border border-stone-800 bg-stone-900/40 p-8 text-center">
          <p className="text-sm text-stone-300 mb-1">
            {filter === "pending" ? "기다리는 항목이 없어요." : "아직 결정함 항목이 없어요."}
          </p>
          <p className="text-xs text-stone-500">새 Jigeum 제안이 여기에 나타납니다.</p>
        </div>
      )}

      {actions.length > 0 && (
        <section className="mb-6" aria-label="결정함">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-stone-100">결정 카드</h2>
            <span className="text-[11px] text-stone-500">{actions.length}</span>
          </div>
          <ul className="space-y-3">
            {actions.map((action) => (
              <li key={action.id}>
                <ActionCard
                  action={action}
                  loading={actionLoading[action.id] ?? null}
                  onApprove={() => handleApprove(action.id)}
                  onReject={() => handleReject(action.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {commitments.length > 0 && (
        <CommitmentSection
          commitments={commitments}
          loading={commitmentLoading}
          onDone={(id) => handleCommitmentStatus(id, "DONE")}
          onDismiss={(id) => handleCommitmentStatus(id, "DISMISSED")}
        />
      )}

      <BriefingCard />
      <CommandCenterSummary />
      <WorkGraphSummaryCard />
      <PlaybookRecommendations />
    </div>
  );
}

function CommitmentSection({
  commitments,
  loading,
  onDone,
  onDismiss,
}: {
  commitments: CommitmentItem[];
  loading: Record<string, "done" | "dismiss" | null>;
  onDone: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <section className="mb-6" aria-label="약속 장부">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-stone-100">추적 중인 약속</h2>
        <span className="text-[11px] text-stone-500">{commitments.length}</span>
      </div>
      <ul className="space-y-2">
        {commitments.map((commitment) => (
          <li key={commitment.id}>
            <CommitmentCard
              commitment={commitment}
              loading={loading[commitment.id] ?? null}
              onDone={() => onDone(commitment.id)}
              onDismiss={() => onDismiss(commitment.id)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CommitmentCard({
  commitment,
  loading,
  onDone,
  onDismiss,
}: {
  commitment: CommitmentItem;
  loading: "done" | "dismiss" | null;
  onDone: () => void;
  onDismiss: () => void;
}) {
  return (
    <article className="rounded-lg border border-stone-800 bg-stone-900/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <CommitmentOwnerBadge owner={commitment.owner} />
            <span className="text-[11px] text-stone-500">
              {commitmentKindLabel(commitment.kind)}
            </span>
            <span className="text-[11px] text-stone-600">{commitmentDueLabel(commitment)}</span>
          </div>
          <p className="mt-2 text-sm font-medium text-stone-100 break-words">{commitment.title}</p>
          {commitment.description && (
            <p className="mt-1 text-xs text-stone-400 line-clamp-2">{commitment.description}</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <button
          type="button"
          onClick={onDone}
          disabled={!!loading}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition min-w-[72px]"
        >
          {loading === "done" ? (
            <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            "완료"
          )}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={!!loading}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-stone-700 text-stone-300 hover:bg-stone-800 disabled:opacity-50 disabled:cursor-not-allowed transition min-w-[72px]"
        >
          {loading === "dismiss" ? (
            <span className="w-3 h-3 border-2 border-stone-300/30 border-t-stone-200 rounded-full animate-spin" />
          ) : (
            "숨기기"
          )}
        </button>
        <span className="ml-auto text-[11px] text-stone-600">
          신뢰도 {Math.round((commitment.confidence ?? 0.72) * 100)}%
        </span>
      </div>
    </article>
  );
}

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
      className={`text-xs px-3 py-1.5 rounded-md transition ${
        active ? "bg-stone-800 text-white" : "text-stone-400 hover:text-stone-200"
      }`}
    >
      {label}
    </button>
  );
}

function QueueMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-r border-white/10 px-4 py-3 last:border-r-0">
      <p className="text-2xl font-semibold text-stone-50">{value}</p>
      <p className="mt-1 text-[11px] text-stone-500">{label}</p>
    </div>
  );
}

function ActionCard({
  action,
  loading,
  onApprove,
  onReject,
}: {
  action: PendingActionItem;
  loading: "approve" | "reject" | null;
  onApprove: () => void;
  onReject: () => void;
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
              결정 카드
            </span>
            <StatusBadge status={action.status} />
          </div>
          <span className="text-[11px] text-stone-600">{formatRelative(action.createdAt)}</span>
        </div>
      </div>

      <div className="p-4 pl-5 md:p-5 md:pl-6">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-medium text-amber-200 bg-amber-300/10 border border-amber-300/20 rounded px-1.5 py-0.5">
              {toolName === "prepared_action" ? "준비된 작업" : toolName.replace(/_/g, " ")}
            </span>
            <RiskBadge risk={risk} />
            {action.conversationTitle && (
              <span className="min-w-0 truncate text-[11px] text-stone-600">
                스레드: {action.conversationTitle}
              </span>
            )}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <DecisionSection
              label="신호"
              title="Jigeum이 찾은 것"
              body={
                reasoning.situation ||
                action.conversationTitle ||
                "Jigeum이 연결된 스레드와 업무 신호를 확인했습니다."
              }
            />
            <DecisionSection
              label="판단"
              title="왜 중요한가"
              body={reasoning.judgment || action.reasoning || "실행 전에 검토가 필요합니다."}
            />
            <DecisionSection
              label="실행"
              title="준비된 움직임"
              body={
                reasoning.proposal ||
                preview ||
                action.preview ||
                (toolName === "prepared_action" ? "준비된 작업" : toolName.replace(/_/g, " "))
              }
            />
          </div>

          {emailPreview && (
            <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-amber-300">보내기 전 승인 필요</span>
                <span className="text-[11px] text-stone-500">send_email</span>
              </div>
              <p className="mt-2 text-xs text-stone-300 break-words">
                받는 사람: {emailPreview.to}
              </p>
              <p className="mt-1 text-xs text-stone-400 break-words">
                제목: {emailPreview.subject}
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
                  "승인"
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
                  "거절"
                )}
              </button>
              <Link
                href={`/chat/${action.conversationId}`}
                className="text-xs text-amber-300 hover:text-amber-200 ml-auto transition"
              >
                스레드 열기 →
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
                스레드 열기 →
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
      label: "낮은 리스크",
      className: "text-emerald-300 bg-emerald-400/10 border-emerald-400/20",
    },
    medium: {
      label: "승인 필요",
      className: "text-amber-300 bg-amber-400/10 border-amber-400/20",
    },
    high: {
      label: "높은 리스크",
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

  const read = (label: "상황" | "판단" | "제안"): string | null => {
    const labels = ["상황", "판단", "제안"].filter((item) => item !== label).join("|");
    const match = reasoning.match(
      new RegExp(
        `(?:📋|💡|✅)?\\s*${label}\\s*[:：]\\s*([\\s\\S]*?)(?=(?:📋|💡|✅)?\\s*(?:${labels})\\s*[:：]|$)`,
      ),
    );
    return match?.[1]?.trim() || null;
  };

  const situation = read("상황");
  const judgment = read("판단");
  const proposal = read("제안");
  if (situation || judgment || proposal) return { situation, judgment, proposal };

  return { situation: null, judgment: reasoning.trim(), proposal: null };
}

function CommitmentOwnerBadge({ owner }: { owner: CommitmentItem["owner"] }) {
  const entry = commitmentOwnerEntry(owner);
  return (
    <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 ${entry.className}`}>
      {entry.label}
    </span>
  );
}

function commitmentOwnerEntry(owner: CommitmentItem["owner"]): {
  label: string;
  className: string;
} {
  switch (owner) {
    case "USER":
      return {
        label: "내 약속",
        className: "text-emerald-300 bg-emerald-400/10 border-emerald-400/20",
      };
    case "COUNTERPARTY":
      return {
        label: "상대방",
        className: "text-amber-200 bg-amber-300/10 border-amber-300/20",
      };
    case "TEAM":
      return {
        label: "팀",
        className: "text-amber-200 bg-amber-300/10 border-amber-300/20",
      };
    case "UNKNOWN":
      return {
        label: "담당자 필요",
        className: "text-amber-300 bg-amber-400/10 border-amber-400/20",
      };
  }
}

function commitmentKindLabel(kind: CommitmentItem["kind"]): string {
  const labels: Record<CommitmentItem["kind"], string> = {
    DELIVERABLE: "전달물",
    FOLLOW_UP: "후속 조치",
    DECISION: "결정",
    MEETING: "회의",
    REVIEW: "검토",
  };
  return labels[kind];
}

function commitmentDueLabel(commitment: CommitmentItem): string {
  if (commitment.dueText) return commitment.dueText;
  if (commitment.dueAt) {
    return new Date(commitment.dueAt).toLocaleDateString("ko-KR", {
      month: "short",
      day: "numeric",
    });
  }
  return "기한 미확인";
}

function StatusBadge({ status }: { status: PendingActionItem["status"] }) {
  const map: Record<PendingActionItem["status"], { label: string; className: string }> = {
    PENDING: { label: "대기", className: "text-amber-300 bg-amber-400/10 border-amber-400/20" },
    EXECUTED: {
      label: "완료",
      className: "text-emerald-300 bg-emerald-400/10 border-emerald-400/20",
    },
    REJECTED: {
      label: "거절됨",
      className: "text-stone-400 bg-stone-500/10 border-stone-500/20",
    },
    FAILED: { label: "실패", className: "text-red-300 bg-red-500/10 border-red-500/20" },
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
    return `받는 사람: ${pick("to") || "?"} · ${pick("subject") || "제목 없음"}`;
  }
  if (toolName === "create_event") {
    const start = pick("startTime");
    const when = start
      ? new Date(start).toLocaleString("ko-KR", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    const loc = pick("location");
    return `${pick("title") || "일정"}${when ? ` · ${when}` : ""}${loc ? ` · ${loc}` : ""}`;
  }
  if (toolName === "create_task" || toolName === "create_note") {
    return pick("title") || "제목 없음";
  }
  if (toolName === "create_contact") {
    const email = pick("email");
    return `${pick("name") || "?"}${email ? ` (${email})` : ""}`;
  }
  if (toolName === "delete_task" || toolName === "delete_note" || toolName === "delete_contact") {
    // Prefer server-resolved label (task title / contact name); fall back to
    // the correct id key so the user at least sees *something* they can match.
    const idKey =
      toolName === "delete_task"
        ? "task_id"
        : toolName === "delete_note"
          ? "note_id"
          : "contact_id";
    return `삭제: ${targetLabel || pick(idKey) || "?"}`;
  }
  if (toolName === "update_task" || toolName === "update_note" || toolName === "update_contact") {
    const idKey =
      toolName === "update_task"
        ? "task_id"
        : toolName === "update_note"
          ? "note_id"
          : "contact_id";
    return `수정: ${targetLabel || pick(idKey) || "?"}`;
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
    subject: pick("subject") || "제목 없음",
    body: pick("body") || pick("message"),
  };
}

function formatRelative(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}
