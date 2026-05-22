"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { apiFetch } from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";
import { formatRelative } from "../../lib/text";

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
  called: ReceiptItem[];
  auto: ReceiptItem[];
  summary: {
    totalSeen: number;
    totalInterrupted: number;
    savedFromInbox: number;
    autoHandled: number;
    narrative: string;
  };
}

type Section = "silenced" | "queued" | "pushed" | "called" | "auto";

const EMPTY: DailyReceipt = {
  date: "",
  silenced: [],
  queued: [],
  pushed: [],
  called: [],
  auto: [],
  summary: { totalSeen: 0, totalInterrupted: 0, savedFromInbox: 0, autoHandled: 0, narrative: "" },
};

const SECTION_META: Record<
  Section,
  { label: string; description: string; tone: string; dot: string }
> = {
  silenced: {
    label: "Silenced",
    description: "Signals EVE saw but chose not to surface.",
    tone: "text-stone-400 border-stone-700",
    dot: "bg-stone-500",
  },
  queued: {
    label: "Queued",
    description: "Placed in your inbox without a push.",
    tone: "text-sky-300 border-sky-400/30",
    dot: "bg-sky-400",
  },
  pushed: {
    label: "Pushed",
    description: "Worth interrupting you for.",
    tone: "text-amber-300 border-amber-400/30",
    dot: "bg-amber-400",
  },
  called: {
    label: "Called",
    description: "Highest-urgency interrupt — last-chance signal before damage.",
    tone: "text-red-300 border-red-500/40",
    dot: "bg-red-500",
  },
  auto: {
    label: "Auto-handled",
    description: "Resolved without asking. You can undo any.",
    tone: "text-emerald-300 border-emerald-400/30",
    dot: "bg-emerald-400",
  },
};

function SourceLabel({ source, type }: { source: string; type: string }) {
  return (
    <span className="text-[10px] uppercase tracking-wider text-stone-600">
      {source.replace(/_/g, " ").toLowerCase()} · {type.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

function ItemRow({
  item,
  section,
  onUndo,
  undoing,
}: {
  item: ReceiptItem;
  section: Section;
  onUndo: (id: string) => void;
  undoing: string | null;
}) {
  return (
    <article className="rounded-xl border border-stone-800 bg-stone-900/40 p-3 transition hover:border-stone-700">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="break-words text-[13px] font-medium text-stone-100">{item.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <SourceLabel source={item.source} type={item.type} />
            <span className="text-[11px] text-stone-600">{formatRelative(item.surfacedAt)}</span>
            {section === "pushed" && item.pushStatus && (
              <span className="rounded border border-stone-800 px-1.5 py-0.5 text-[10px] text-stone-500">
                {item.pushStatus.toLowerCase()}
                {item.pushClickedAt ? " · opened" : ""}
              </span>
            )}
          </div>
          {item.tierReason && (
            <p className="mt-1.5 text-[11px] leading-5 text-stone-500">{item.tierReason}</p>
          )}
        </div>

        {section === "auto" && (
          <button
            type="button"
            onClick={() => onUndo(item.id)}
            disabled={undoing === item.id}
            className="shrink-0 rounded-md border border-stone-700 px-2 py-1 text-[11px] text-stone-400 transition hover:border-stone-500 hover:text-stone-200 disabled:opacity-50"
          >
            {undoing === item.id ? "Undoing…" : "Undo"}
          </button>
        )}
      </div>
    </article>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border border-stone-800 bg-stone-950/60 p-3">
      <p className={`text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wider text-stone-600">{label}</p>
    </div>
  );
}

function ReceiptContent() {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<Section>("pushed");

  const { data = EMPTY, isLoading: loading } = useQuery({
    queryKey: queryKeys.inbox.receipt(),
    queryFn: async () => {
      try {
        const res = await apiFetch<DailyReceipt>("/api/inbox/receipt/today");
        return {
          date: res.date ?? "",
          silenced: Array.isArray(res.silenced) ? res.silenced : [],
          queued: Array.isArray(res.queued) ? res.queued : [],
          pushed: Array.isArray(res.pushed) ? res.pushed : [],
          called: Array.isArray(res.called) ? res.called : [],
          auto: Array.isArray(res.auto) ? res.auto : [],
          summary: res.summary ?? EMPTY.summary,
        };
      } catch (err) {
        captureClientError(err, { scope: "receipt.load" });
        throw err;
      }
    },
  });

  // Optimistically drop the undone row from the auto list; the next
  // refetch (focus / refresh) reconciles against the server.
  const undoMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/inbox/receipt/undo/${id}`, { method: "POST" }),
    onMutate: (id) => {
      queryClient.setQueryData<DailyReceipt>(queryKeys.inbox.receipt(), (prev) =>
        prev ? { ...prev, auto: prev.auto.filter((a) => a.id !== id) } : prev,
      );
    },
    onError: (err) => captureClientError(err, { scope: "receipt.undo" }),
  });
  const undoing = undoMutation.isPending ? (undoMutation.variables ?? null) : null;
  const handleUndo = (id: string) => undoMutation.mutate(id);

  const sections: Section[] = ["called", "pushed", "queued", "auto", "silenced"];
  const visible = data[section];

  const dateLabel = data.date
    ? new Date(`${data.date}T00:00:00`).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
    : "Today";

  return (
    <div className="min-h-dvh bg-[#0f1115]">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200">
            Attention receipt
          </p>
          <h1 className="mt-2 text-xl font-semibold text-stone-100">{dateLabel}</h1>
          <p className="mt-1 text-[13px] text-stone-500">
            What EVE did — and didn&apos;t interrupt you with.
          </p>
        </div>

        {loading ? (
          <div className="space-y-3">
            <div className="h-20 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30" />
            <div className="h-16 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30" />
            <div className="h-16 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30" />
          </div>
        ) : (
          <>
            {data.summary.narrative && (
              <p className="mb-5 rounded-xl border border-stone-800 bg-stone-900/30 p-4 text-[13px] leading-6 text-stone-300">
                {data.summary.narrative}
              </p>
            )}

            <div className="mb-6 grid grid-cols-2 gap-2 md:grid-cols-4">
              <StatCard label="Seen" value={data.summary.totalSeen} tone="text-stone-100" />
              <StatCard
                label="Interrupted"
                value={data.summary.totalInterrupted}
                tone="text-amber-300"
              />
              <StatCard label="Saved" value={data.summary.savedFromInbox} tone="text-stone-400" />
              <StatCard label="Auto" value={data.summary.autoHandled} tone="text-emerald-300" />
            </div>

            <div className="mb-3 flex flex-wrap gap-1 border-b border-stone-800 pb-2">
              {sections.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSection(s)}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition ${
                    section === s
                      ? "bg-stone-800 text-stone-100"
                      : "text-stone-600 hover:text-stone-400"
                  }`}
                >
                  {SECTION_META[s].label}
                  <span className="ml-1.5 text-stone-700">{data[s].length}</span>
                </button>
              ))}
            </div>

            <p className="mb-3 text-[12px] text-stone-500">{SECTION_META[section].description}</p>

            {visible.length === 0 ? (
              <div className="rounded-xl border border-stone-800 bg-stone-900/20 py-10 text-center">
                <p className="text-sm text-stone-500">Nothing in this category today.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {visible.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    section={section}
                    onUndo={handleUndo}
                    undoing={undoing}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function ReceiptPage() {
  return (
    <AuthGuard>
      <ReceiptContent />
    </AuthGuard>
  );
}
