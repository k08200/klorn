"use client";

// Wire shapes come from @klorn/contract — the same types the server builds
// (routes/receipt.ts), so a response-shape change fails to compile here
// instead of silently desyncing.
import type { DailyReceipt, ReceiptItem, ReceiptUndoResponse } from "@klorn/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { useToast } from "../../../components/toast";
import { apiFetch } from "../../../lib/api";
import { queryKeys } from "../../../lib/query-keys";
import { captureClientError } from "../../../lib/sentry";

export default function ReceiptPage() {
  return (
    <AuthGuard>
      <ReceiptView />
    </AuthGuard>
  );
}

function ReceiptView() {
  const queryClient = useQueryClient();
  const [undoLoading, setUndoLoading] = useState<Record<string, boolean>>({});
  const { toast } = useToast();

  const receiptQuery = useQuery({
    queryKey: queryKeys.inbox.receipt(),
    queryFn: async () => {
      try {
        return await apiFetch<DailyReceipt>("/api/inbox/receipt/today");
      } catch (err) {
        captureClientError(err, { scope: "receipt.load" });
        throw err;
      }
    },
  });
  const receipt = receiptQuery.data ?? null;
  const loading = receiptQuery.isLoading;
  const error = receiptQuery.error ? "Could not load today's attention receipt." : null;

  const undoMutation = useMutation({
    mutationFn: (pendingActionId: string) =>
      apiFetch<ReceiptUndoResponse>(`/api/inbox/receipt/undo/${pendingActionId}`, {
        method: "POST",
      }),
    onMutate: (pendingActionId) => {
      setUndoLoading((prev) => ({ ...prev, [pendingActionId]: true }));
    },
    onSuccess: (result) => {
      if (result.ok) {
        toast(result.message, "success");
        // The undo creates a new proposal server-side; refetch reflects it.
        void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.receipt() });
      } else {
        toast(result.message, "error");
      }
    },
    onError: (err, pendingActionId) => {
      captureClientError(err, { scope: "receipt.undo", pendingActionId });
      toast("Could not create undo proposal. Please try again.", "error");
    },
    onSettled: (_data, _err, pendingActionId) => {
      setUndoLoading((prev) => ({ ...prev, [pendingActionId]: false }));
    },
  });

  const handleUndo = (pendingActionId: string) => {
    if (undoLoading[pendingActionId]) return;
    undoMutation.mutate(pendingActionId);
  };

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-10">
        <p className="text-sm text-slate-400 text-center">Loading today's receipt...</p>
      </div>
    );
  }

  if (error || !receipt) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-10">
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error ?? "No receipt available."}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:py-10">
      {/* Flat header on the canvas — no boxed hero. */}
      <header className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-slate-900">
              What Klorn did today
            </h1>
            <p className="mt-2 text-sm text-slate-500">{receipt.summary.narrative}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <p className="hidden text-xs text-slate-400 sm:block">
              {formatReceiptDate(receipt.date)}
            </p>
            <button
              type="button"
              onClick={() => receiptQuery.refetch()}
              className="ease-strong inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white/70 px-3 text-xs font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Summary row — one elevated panel */}
        <div className="panel-elevated mt-5 grid grid-cols-4 overflow-hidden rounded-2xl border border-slate-200/70 bg-white">
          <SummaryMetric
            label="Signals seen"
            value={receipt.summary.totalSeen}
            color="text-slate-900"
          />
          <SummaryMetric
            label="Silenced"
            value={receipt.summary.savedFromInbox}
            color="text-slate-500"
          />
          <SummaryMetric
            label="Pushed"
            value={receipt.summary.totalInterrupted}
            color="text-rose-600"
          />
          <SummaryMetric
            label="Auto-handled"
            value={receipt.summary.autoHandled}
            color="text-emerald-600"
          />
        </div>
      </header>

      <div className="space-y-6">
        {/* Auto-handled */}
        {receipt.auto.length > 0 && (
          <ReceiptSection
            title="Auto-handled"
            description="Low-risk actions Klorn executed without interrupting you"
            accentBar="bg-gradient-to-b from-emerald-400 to-emerald-500"
            labelClass="text-emerald-600"
            items={receipt.auto}
            renderActions={(item) => (
              <button
                type="button"
                onClick={() => handleUndo(item.id)}
                disabled={!!undoLoading[item.id]}
                className="text-[11px] text-slate-400 transition duration-150 hover:text-sky-700 disabled:opacity-50"
              >
                {undoLoading[item.id] ? "Creating undo..." : "Request undo"}
              </button>
            )}
          />
        )}

        {/* Pushed */}
        {receipt.pushed.length > 0 && (
          <ReceiptSection
            title="Pushed to you"
            description="Signals Klorn judged urgent enough to interrupt you"
            accentBar="bg-gradient-to-b from-rose-400 to-rose-500"
            labelClass="text-rose-600"
            items={receipt.pushed}
            renderExtra={(item) =>
              item.pushStatus ? (
                <PushStatusBadge status={item.pushStatus} clickedAt={item.pushClickedAt ?? null} />
              ) : null
            }
          />
        )}

        {/* Queued */}
        {receipt.queued.length > 0 && (
          <ReceiptSection
            title="Queued in inbox"
            description="Items placed in your decision queue — no push sent"
            accentBar="bg-sky-400"
            labelClass="text-sky-600"
            items={receipt.queued}
          />
        )}

        {/* Silenced */}
        {receipt.silenced.length > 0 && (
          <ReceiptSection
            title="Silenced"
            description="Signals Klorn filtered out to protect your focus"
            accentBar={null}
            labelClass="text-slate-500"
            items={receipt.silenced}
          />
        )}

        {receipt.summary.totalSeen === 0 && (
          <div className="panel-elevated rounded-2xl border border-slate-200/70 bg-white p-8 text-center">
            <p className="text-sm text-slate-500">No signals processed today yet.</p>
            <p className="mt-1 text-xs text-slate-500">
              Come back later — Klorn processes your mail and meetings continuously.
            </p>
          </div>
        )}
      </div>

      <div className="mt-8 flex justify-center">
        <Link
          href="/inbox"
          className="text-sm text-slate-400 transition duration-150 hover:text-slate-600"
        >
          ← Back to Decision Queue
        </Link>
      </div>
    </div>
  );
}

function ReceiptSection({
  title,
  description,
  accentBar,
  labelClass,
  items,
  renderActions,
  renderExtra,
}: {
  title: string;
  description: string;
  accentBar: string | null;
  labelClass: string;
  items: ReceiptItem[];
  renderActions?: (item: ReceiptItem) => React.ReactNode;
  renderExtra?: (item: ReceiptItem) => React.ReactNode;
}) {
  return (
    <section aria-label={title}>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h2 className={`text-sm font-semibold ${labelClass}`}>{title}</h2>
          <p className="text-xs text-slate-500">{description}</p>
        </div>
        <span className="text-[11px] tabular-nums text-slate-400">{items.length}</span>
      </div>
      <div className="panel-elevated overflow-hidden rounded-2xl border border-slate-200/70 bg-white">
        <ul className="divide-y divide-slate-100">
          {items.map((item) => (
            <li key={item.id} className="row-wash relative">
              {accentBar && (
                <span
                  aria-hidden="true"
                  className={`absolute left-0 top-0 h-full w-[3px] ${accentBar}`}
                />
              )}
              <div className="px-4 py-3 pl-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900">{item.title}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <SourceBadge source={item.source} type={item.type} />
                      {item.tierReason && (
                        <span className="text-[11px] text-slate-500">{item.tierReason}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-[11px] tabular-nums text-slate-400">
                      {formatTime(item.surfacedAt)}
                    </span>
                    {renderExtra?.(item)}
                    {renderActions?.(item)}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function SummaryMetric({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="border-r border-slate-100 px-4 py-3 last:border-r-0">
      <p className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
      <p className="mt-1 text-[11px] text-slate-400">{label}</p>
    </div>
  );
}

function SourceBadge({ source, type }: { source: string; type: string }) {
  const label = sourceLabel(source, type);
  return (
    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-slate-500">
      {label}
    </span>
  );
}

function PushStatusBadge({ status, clickedAt }: { status: string; clickedAt: string | null }) {
  if (clickedAt) {
    return (
      <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-emerald-600 ring-1 ring-inset ring-emerald-500/20">
        Opened
      </span>
    );
  }
  if (status === "SENT") {
    return (
      <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-amber-600 ring-1 ring-inset ring-amber-500/20">
        Sent
      </span>
    );
  }
  return null;
}

function sourceLabel(source: string, type: string): string {
  const typeMap: Record<string, string> = {
    COMMITMENT_DUE: "Commitment due",
    COMMITMENT_OVERDUE: "Overdue commitment",
    COMMITMENT_UNCONFIRMED: "Unconfirmed commitment",
    REPLY_NEEDED: "Reply needed",
    DEADLINE: "Deadline",
    AGENT_PROPOSAL: "Agent proposal",
    DECISION: "Auto action",
  };
  if (typeMap[type]) return typeMap[type];
  const sourceMap: Record<string, string> = {
    PENDING_ACTION: "Agent",
    TASK: "Task",
    CALENDAR_EVENT: "Calendar",
    NOTIFICATION: "Notification",
    COMMITMENT: "Commitment",
    EMAIL: "Email",
  };
  return sourceMap[source] ?? source.toLowerCase().replace(/_/g, " ");
}

function formatReceiptDate(dateStr: string): string {
  try {
    return new Date(`${dateStr}T12:00:00`).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function formatTime(isoStr: string): string {
  try {
    return new Date(isoStr).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}
