"use client";

// Wire shapes come from @klorn/contract — the same types the server builds
// (routes/receipt.ts), so a response-shape change fails to compile here
// instead of silently desyncing.
import type { ReceiptItem } from "@klorn/contract";
import Link from "next/link";
import AuthGuard from "../../../components/auth-guard";
import { HubHandoff } from "../../../components/hub-handoff";
import { useToast } from "../../../components/toast";
import ErrorAlert from "../../../components/ui/error-alert";
import LoadingState from "../../../components/ui/loading-state";
import { useT } from "../../../lib/i18n";
import { useReceipt } from "./use-receipt";

export default function ReceiptPage() {
  return (
    <AuthGuard>
      <HubHandoff>
        <ReceiptView />
      </HubHandoff>
    </AuthGuard>
  );
}

function ReceiptView() {
  const { t } = useT();
  const { toast } = useToast();
  const { receiptQuery, isUndoing, requestUndo } = useReceipt({
    onUndoAnswer: (result) => toast(result.message, result.ok ? "success" : "error"),
    onUndoError: () => toast(t("receipt.undo.error"), "error"),
  });
  const receipt = receiptQuery.data ?? null;
  const loading = receiptQuery.isLoading;
  const error = receiptQuery.error ? t("receipt.error.load") : null;

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-10">
        <LoadingState rows={2} label={t("receipt.loading")} />
      </div>
    );
  }

  if (error || !receipt) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-10">
        <ErrorAlert>{error ?? t("receipt.error.noReceipt")}</ErrorAlert>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:py-10">
      {/* Flat header on the canvas — no boxed hero. */}
      <header className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-ink">
              {t("receipt.title")}
            </h1>
            <p className="mt-2 text-sm text-ink-mid">{receipt.summary.narrative}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <p className="hidden text-xs text-ink-dim sm:block">
              {formatReceiptDate(receipt.date)}
            </p>
            <button
              type="button"
              onClick={() => receiptQuery.refetch()}
              className="ease-strong inline-flex h-9 items-center rounded-lg border border-line bg-surface-panel/70 px-3 text-xs font-medium text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] focus-ring min-h-11"
            >
              {t("receipt.refresh")}
            </button>
          </div>
        </div>

        {/* Summary row — one elevated panel */}
        <div className="panel-elevated mt-5 grid grid-cols-4 overflow-hidden rounded-2xl border border-line/70 bg-surface-panel">
          <SummaryMetric
            label={t("receipt.metric.signalsSeen")}
            value={receipt.summary.totalSeen}
            color="text-ink"
          />
          <SummaryMetric
            label={t("receipt.silenced.title")}
            value={receipt.summary.savedFromInbox}
            color="text-ink-mid"
          />
          <SummaryMetric
            label={t("receipt.metric.pushed")}
            value={receipt.summary.totalInterrupted}
            color="text-rose-600"
          />
          <SummaryMetric
            label={t("receipt.autoHandled.title")}
            value={receipt.summary.autoHandled}
            color="text-state-ok-ink"
          />
        </div>
      </header>

      <div className="space-y-6">
        {/* Auto-handled */}
        {receipt.auto.length > 0 && (
          <ReceiptSection
            title={t("receipt.autoHandled.title")}
            description={t("receipt.autoHandled.description")}
            accentBar="bg-gradient-to-b from-emerald-400 to-emerald-500"
            labelClass="text-state-ok-ink"
            items={receipt.auto}
            renderActions={(item) => (
              <button
                type="button"
                onClick={() => requestUndo(item.id)}
                disabled={isUndoing(item.id)}
                className="text-[11px] text-ink-dim transition duration-150 hover:text-accent-deeper disabled:opacity-50 focus-ring min-h-9 min-w-9"
              >
                {isUndoing(item.id) ? t("receipt.undo.creating") : t("receipt.undo.request")}
              </button>
            )}
          />
        )}

        {/* Pushed */}
        {receipt.pushed.length > 0 && (
          <ReceiptSection
            title={t("receipt.pushed.title")}
            description={t("receipt.pushed.description")}
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
            title={t("receipt.queued.title")}
            description={t("receipt.queued.description")}
            accentBar="bg-accent-light"
            labelClass="text-accent-deep"
            items={receipt.queued}
          />
        )}

        {/* Silenced */}
        {receipt.silenced.length > 0 && (
          <ReceiptSection
            title={t("receipt.silenced.title")}
            description={t("receipt.silenced.description")}
            accentBar={null}
            labelClass="text-ink-mid"
            items={receipt.silenced}
          />
        )}

        {receipt.summary.totalSeen === 0 && (
          <div className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-8 text-center">
            <p className="text-sm text-ink-mid">{t("receipt.empty.title")}</p>
            <p className="mt-1 text-xs text-ink-mid">{t("receipt.empty.description")}</p>
          </div>
        )}
      </div>

      <div className="mt-8 flex justify-center">
        <Link
          href="/inbox"
          className="text-sm text-ink-dim transition duration-150 hover:text-ink-muted"
        >
          {t("receipt.backToQueue")}
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
          <p className="text-xs text-ink-mid">{description}</p>
        </div>
        <span className="text-[11px] tabular-nums text-ink-dim">{items.length}</span>
      </div>
      <div className="panel-elevated overflow-hidden rounded-2xl border border-line/70 bg-surface-panel">
        <ul className="divide-y divide-line-soft">
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
                    <p className="truncate text-sm font-medium text-ink">{item.title}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <SourceBadge source={item.source} type={item.type} />
                      {item.tierReason && (
                        <span className="text-[11px] text-ink-mid">{item.tierReason}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-[11px] tabular-nums text-ink-dim">
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
    <div className="border-r border-line-soft px-4 py-3 last:border-r-0">
      <p className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
      <p className="mt-1 text-[11px] text-ink-dim">{label}</p>
    </div>
  );
}

function SourceBadge({ source, type }: { source: string; type: string }) {
  const { t } = useT();
  const label = sourceLabel(t, source, type);
  return (
    <span className="rounded-md bg-surface-hover px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-ink-mid">
      {label}
    </span>
  );
}

function PushStatusBadge({ status, clickedAt }: { status: string; clickedAt: string | null }) {
  const { t } = useT();
  if (clickedAt) {
    return (
      <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-state-ok-ink ring-1 ring-inset ring-emerald-500/20">
        {t("receipt.status.opened")}
      </span>
    );
  }
  if (status === "SENT") {
    return (
      <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-state-warn-ink ring-1 ring-inset ring-amber-500/20">
        {t("receipt.status.sent")}
      </span>
    );
  }
  return null;
}

/** `t` is passed in rather than called via useT() here — this is a plain
 * helper, not a component, so it cannot use hooks itself. */
function sourceLabel(t: (key: string) => string, source: string, type: string): string {
  const typeMap: Record<string, string> = {
    COMMITMENT_DUE: t("receipt.type.commitmentDue"),
    COMMITMENT_OVERDUE: t("receipt.type.commitmentOverdue"),
    COMMITMENT_UNCONFIRMED: t("receipt.type.commitmentUnconfirmed"),
    REPLY_NEEDED: t("receipt.type.replyNeeded"),
    DEADLINE: t("receipt.type.deadline"),
    AGENT_PROPOSAL: t("receipt.type.agentProposal"),
    DECISION: t("receipt.type.decision"),
  };
  if (typeMap[type]) return typeMap[type];
  const sourceMap: Record<string, string> = {
    PENDING_ACTION: t("receipt.source.pendingAction"),
    TASK: t("receipt.source.task"),
    CALENDAR_EVENT: t("receipt.source.calendarEvent"),
    NOTIFICATION: t("receipt.source.notification"),
    COMMITMENT: t("receipt.source.commitment"),
    EMAIL: t("receipt.source.email"),
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
