"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { useToast } from "../../../components/toast";
import { apiFetch } from "../../../lib/api";
import { queryKeys } from "../../../lib/query-keys";
import { captureClientError } from "../../../lib/sentry";

interface ReceiptItem {
  id: string;
  title: string;
  source: string;
  type: string;
  tierReason: string | null;
  surfacedAt: string;
  pushStatus?: string;
  pushClickedAt?: string | null;
}

interface DailyReceipt {
  date: string;
  silenced: ReceiptItem[];
  queued: ReceiptItem[];
  pushed: ReceiptItem[];
  auto: ReceiptItem[];
  summary: {
    totalSeen: number;
    totalInterrupted: number;
    savedFromInbox: number;
    autoHandled: number;
    narrative: string;
  };
}

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
      apiFetch<{ ok: boolean; message: string }>(`/api/inbox/receipt/undo/${pendingActionId}`, {
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
        <p className="text-sm text-stone-500 text-center">Loading today's receipt...</p>
      </div>
    );
  }

  if (error || !receipt) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-10">
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error ?? "No receipt available."}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:py-10">
      {/* Header */}
      <header className="mb-6 overflow-hidden rounded-lg border border-stone-800/70 bg-stone-950/65 shadow-2xl shadow-black/20">
        <div className="h-1 bg-gradient-to-r from-amber-300 via-amber-200/40 to-transparent" />
        <div className="p-5 md:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300">
                Attention receipt
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-stone-50">
                What Klorn did today
              </h1>
              <p className="mt-2 text-sm leading-6 text-stone-400">{receipt.summary.narrative}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-xs text-stone-500">{formatReceiptDate(receipt.date)}</p>
              <button
                type="button"
                onClick={() => receiptQuery.refetch()}
                className="mt-2 h-8 rounded-md border border-stone-700 bg-stone-950/70 px-3 text-xs text-stone-300 transition hover:bg-stone-800"
              >
                Refresh
              </button>
            </div>
          </div>

          {/* Summary row */}
          <div className="mt-5 grid grid-cols-4 overflow-hidden rounded-xl border border-white/10 bg-black/25">
            <SummaryMetric
              label="Signals seen"
              value={receipt.summary.totalSeen}
              color="text-stone-50"
            />
            <SummaryMetric
              label="Silenced"
              value={receipt.summary.savedFromInbox}
              color="text-stone-300"
            />
            <SummaryMetric
              label="Pushed"
              value={receipt.summary.totalInterrupted}
              color="text-rose-300"
            />
            <SummaryMetric
              label="Auto-handled"
              value={receipt.summary.autoHandled}
              color="text-emerald-300"
            />
          </div>
        </div>
      </header>

      <div className="space-y-6">
        {/* Auto-handled */}
        {receipt.auto.length > 0 && (
          <ReceiptSection
            title="Auto-handled"
            description="Low-risk actions Klorn executed without interrupting you"
            accentClass="border-emerald-500/20 bg-emerald-500/5"
            labelClass="text-emerald-300"
            items={receipt.auto}
            renderActions={(item) => (
              <button
                type="button"
                onClick={() => handleUndo(item.id)}
                disabled={!!undoLoading[item.id]}
                className="text-[11px] text-stone-500 hover:text-stone-300 transition disabled:opacity-50"
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
            accentClass="border-amber-400/20 bg-amber-400/5"
            labelClass="text-amber-300"
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
            accentClass="border-stone-700 bg-stone-900/30"
            labelClass="text-stone-400"
            items={receipt.queued}
          />
        )}

        {/* Silenced */}
        {receipt.silenced.length > 0 && (
          <ReceiptSection
            title="Silenced"
            description="Signals Klorn filtered out to protect your focus"
            accentClass="border-stone-800 bg-black/20"
            labelClass="text-stone-500"
            items={receipt.silenced}
          />
        )}

        {receipt.summary.totalSeen === 0 && (
          <div className="rounded-lg border border-stone-800 bg-stone-900/40 p-8 text-center">
            <p className="text-sm text-stone-400">No signals processed today yet.</p>
            <p className="mt-1 text-xs text-stone-600">
              Come back later — Klorn processes your mail and meetings continuously.
            </p>
          </div>
        )}
      </div>

      <div className="mt-8 flex justify-center">
        <Link href="/inbox" className="text-sm text-stone-500 hover:text-stone-300 transition">
          ← Back to Decision Queue
        </Link>
      </div>
    </div>
  );
}

function ReceiptSection({
  title,
  description,
  accentClass,
  labelClass,
  items,
  renderActions,
  renderExtra,
}: {
  title: string;
  description: string;
  accentClass: string;
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
          <p className="text-xs text-stone-600">{description}</p>
        </div>
        <span className="text-[11px] text-stone-600">{items.length}</span>
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id}>
            <div className={`rounded-lg border p-3 ${accentClass}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-stone-200 truncate">{item.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <SourceBadge source={item.source} type={item.type} />
                    {item.tierReason && (
                      <span className="text-[11px] text-stone-600">{item.tierReason}</span>
                    )}
                  </div>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1">
                  <span className="text-[11px] text-stone-600">{formatTime(item.surfacedAt)}</span>
                  {renderExtra?.(item)}
                  {renderActions?.(item)}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SummaryMetric({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="border-r border-white/10 px-4 py-3 last:border-r-0">
      <p className={`text-2xl font-semibold ${color}`}>{value}</p>
      <p className="mt-1 text-[11px] text-stone-500">{label}</p>
    </div>
  );
}

function SourceBadge({ source, type }: { source: string; type: string }) {
  const label = sourceLabel(source, type);
  return (
    <span className="text-[11px] text-stone-500 bg-stone-800/60 border border-stone-700/60 rounded px-1.5 py-0.5">
      {label}
    </span>
  );
}

function PushStatusBadge({ status, clickedAt }: { status: string; clickedAt: string | null }) {
  if (clickedAt) {
    return (
      <span className="text-[11px] text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded px-1.5 py-0.5">
        Opened
      </span>
    );
  }
  if (status === "SENT") {
    return (
      <span className="text-[11px] text-amber-300 bg-amber-400/10 border border-amber-400/20 rounded px-1.5 py-0.5">
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
