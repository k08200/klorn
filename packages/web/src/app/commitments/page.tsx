"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { apiFetch } from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";

type CommitmentStatus = "OPEN" | "DONE" | "DISMISSED" | "SNOOZED";
type CommitmentOwner = "USER" | "COUNTERPARTY";
type TrustBadge = "reliable" | "mostly_reliable" | "unreliable" | "unknown";

interface Commitment {
  id: string;
  title: string;
  description: string | null;
  status: CommitmentStatus;
  owner: CommitmentOwner;
  counterpartyName: string | null;
  counterpartyEmail: string | null;
  dueAt: string | null;
  dueText: string | null;
  confidence: number;
  trustBadge: TrustBadge | null;
  trustLabel: string | null;
  createdAt: string;
}

type FilterTab = "open" | "theirs" | "mine" | "done";

const BADGE_STYLE: Record<TrustBadge, string> = {
  reliable: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20",
  mostly_reliable: "text-amber-400 bg-amber-400/10 border-amber-400/20",
  unreliable: "text-red-400 bg-red-400/10 border-red-400/20",
  unknown: "text-stone-500 bg-stone-800/40 border-stone-700",
};

const BADGE_LABEL: Record<TrustBadge, string> = {
  reliable: "Reliable",
  mostly_reliable: "Mostly reliable",
  unreliable: "Unreliable",
  unknown: "Unknown",
};

function isOverdue(c: Commitment): boolean {
  return c.status === "OPEN" && c.dueAt !== null && new Date(c.dueAt) < new Date();
}

function formatDue(dueAt: string | null, dueText: string | null): string | null {
  if (dueText) return dueText;
  if (!dueAt) return null;
  const d = new Date(dueAt);
  const now = new Date();
  const diffDays = Math.round((d.getTime() - now.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`;
  if (diffDays < 7) return `${diffDays}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function CommitmentRow({
  commitment,
  onStatusChange,
}: {
  commitment: Commitment;
  onStatusChange: (id: string, status: CommitmentStatus) => void;
}) {
  const overdue = isOverdue(commitment);
  const dueLabel = formatDue(commitment.dueAt, commitment.dueText);
  const trust = commitment.trustBadge;
  const counterparty =
    commitment.counterpartyName ||
    commitment.counterpartyEmail ||
    (commitment.owner === "COUNTERPARTY" ? "Them" : null);

  return (
    <div
      className={`group flex items-start gap-3 rounded-xl border px-4 py-3 transition ${
        overdue
          ? "border-red-500/20 bg-red-500/5 hover:border-red-500/30"
          : "border-stone-800 bg-stone-900/40 hover:border-stone-700 hover:bg-stone-900/70"
      }`}
    >
      {/* Done checkbox */}
      <button
        type="button"
        onClick={() =>
          onStatusChange(commitment.id, commitment.status === "DONE" ? "OPEN" : "DONE")
        }
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
          commitment.status === "DONE"
            ? "border-emerald-500 bg-emerald-500/20 text-emerald-400"
            : overdue
              ? "border-red-500/40 bg-transparent hover:border-red-400"
              : "border-stone-700 bg-transparent hover:border-stone-500"
        }`}
        title={commitment.status === "DONE" ? "Mark open" : "Mark done"}
      >
        {commitment.status === "DONE" && (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <polyline
              points="2 6 5 9 10 3"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <p
          className={`text-sm font-medium leading-snug ${
            commitment.status === "DONE" ? "text-stone-600 line-through" : "text-stone-100"
          }`}
        >
          {commitment.title}
        </p>

        <div className="mt-1 flex flex-wrap items-center gap-2">
          {/* Owner chip */}
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              commitment.owner === "COUNTERPARTY"
                ? "bg-stone-800 text-stone-400"
                : "bg-amber-500/10 text-amber-300"
            }`}
          >
            {commitment.owner === "COUNTERPARTY" ? "Theirs" : "Mine"}
          </span>

          {/* Counterparty name */}
          {counterparty && <span className="text-[11px] text-stone-500">{counterparty}</span>}

          {/* Trust badge */}
          {trust && commitment.owner === "COUNTERPARTY" && (
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${BADGE_STYLE[trust]}`}
            >
              {BADGE_LABEL[trust]}
            </span>
          )}

          {/* Due date */}
          {dueLabel && (
            <span
              className={`text-[11px] font-medium ${overdue ? "text-red-400" : "text-stone-500"}`}
            >
              {overdue && "⚠ "}
              {dueLabel}
            </span>
          )}
        </div>
      </div>

      {/* Dismiss button */}
      {commitment.status === "OPEN" && (
        <button
          type="button"
          onClick={() => onStatusChange(commitment.id, "DISMISSED")}
          className="hidden shrink-0 rounded p-1 text-stone-700 transition hover:text-stone-400 group-hover:flex"
          title="Dismiss"
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
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}

function CommitmentsContent() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<FilterTab>("open");
  const statusKey = tab === "done" ? "DONE" : undefined;

  const { data: commitments = [], isLoading: loading } = useQuery({
    queryKey: queryKeys.commitments.list(statusKey),
    queryFn: async () => {
      const qs = tab === "done" ? "?status=DONE" : "";
      try {
        const data = await apiFetch<{ commitments: Commitment[] }>(`/api/commitments${qs}`);
        return Array.isArray(data.commitments) ? data.commitments : [];
      } catch (err) {
        captureClientError(err, { scope: "commitments.load" });
        throw err;
      }
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: CommitmentStatus }) =>
      apiFetch(`/api/commitments/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.commitments.list(statusKey) });
      const snapshot = queryClient.getQueryData<Commitment[]>(
        queryKeys.commitments.list(statusKey),
      );
      queryClient.setQueryData<Commitment[]>(queryKeys.commitments.list(statusKey), (prev) =>
        (prev ?? []).map((c) => (c.id === id ? { ...c, status } : c)),
      );
      return { snapshot };
    },
    onError: (err, _vars, ctx) => {
      captureClientError(err, { scope: "commitments.status-change" });
      if (ctx?.snapshot) {
        queryClient.setQueryData(queryKeys.commitments.list(statusKey), ctx.snapshot);
      }
    },
  });

  const handleStatusChange = (id: string, status: CommitmentStatus) => {
    statusMutation.mutate({ id, status });
  };

  const visible = commitments.filter((c) => {
    if (tab === "open") return c.status === "OPEN" || c.status === "SNOOZED";
    if (tab === "mine")
      return (c.status === "OPEN" || c.status === "SNOOZED") && c.owner === "USER";
    if (tab === "theirs")
      return (c.status === "OPEN" || c.status === "SNOOZED") && c.owner === "COUNTERPARTY";
    if (tab === "done") return c.status === "DONE" || c.status === "DISMISSED";
    return true;
  });

  const overdue = visible.filter(isOverdue);
  const open = visible.filter((c) => !isOverdue(c));

  const counts = {
    open: commitments.filter((c) => c.status === "OPEN" || c.status === "SNOOZED").length,
    mine: commitments.filter(
      (c) => (c.status === "OPEN" || c.status === "SNOOZED") && c.owner === "USER",
    ).length,
    theirs: commitments.filter(
      (c) => (c.status === "OPEN" || c.status === "SNOOZED") && c.owner === "COUNTERPARTY",
    ).length,
    done: commitments.filter((c) => c.status === "DONE" || c.status === "DISMISSED").length,
  };

  const TABS: { key: FilterTab; label: string }[] = [
    { key: "open", label: "All open" },
    { key: "mine", label: "Mine" },
    { key: "theirs", label: "Theirs" },
    { key: "done", label: "Done" },
  ];

  return (
    <div className="flex h-dvh flex-col bg-[#0f1115]">
      {/* Header */}
      <div className="border-b border-stone-800 px-6 py-4">
        <h1 className="text-lg font-semibold text-stone-100">Commitments</h1>
        <p className="mt-0.5 text-[12px] text-stone-500">
          Promises detected from your mail and conversations — tracked automatically.
        </p>

        {/* Tabs */}
        <div className="mt-3 flex gap-1">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-[12px] font-medium transition ${
                tab === key
                  ? "bg-stone-800 text-stone-100"
                  : "text-stone-500 hover:bg-stone-800/50 hover:text-stone-300"
              }`}
            >
              {label}
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                  tab === key ? "bg-stone-700 text-stone-300" : "text-stone-700"
                }`}
              >
                {counts[key]}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-14 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30"
              />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <svg
              aria-hidden="true"
              className="mb-4 h-10 w-10 text-stone-700"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 11 12 14 22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            <p className="text-sm text-stone-500">
              {tab === "done" ? "No completed commitments yet." : "No commitments in this view."}
            </p>
            <p className="mt-1 text-[12px] text-stone-700">
              Klorn detects commitments from mail and chat — they appear here automatically.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {overdue.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-red-500">
                  Overdue
                  <span className="ml-2 font-normal normal-case tracking-normal text-red-700">
                    {overdue.length}
                  </span>
                </p>
                <div className="space-y-2">
                  {overdue.map((c) => (
                    <CommitmentRow key={c.id} commitment={c} onStatusChange={handleStatusChange} />
                  ))}
                </div>
              </div>
            )}

            {open.length > 0 && (
              <div>
                {overdue.length > 0 && (
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-stone-600">
                    Upcoming
                    <span className="ml-2 font-normal normal-case tracking-normal text-stone-700">
                      {open.length}
                    </span>
                  </p>
                )}
                <div className="space-y-2">
                  {open.map((c) => (
                    <CommitmentRow key={c.id} commitment={c} onStatusChange={handleStatusChange} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function CommitmentsPage() {
  return (
    <AuthGuard>
      <CommitmentsContent />
    </AuthGuard>
  );
}
