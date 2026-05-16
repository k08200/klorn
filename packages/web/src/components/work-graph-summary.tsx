"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { formatRelative } from "../lib/text";
import type { WorkGraphContext, WorkGraphRisk, WorkGraphSummary } from "../lib/work-graph";

const EMPTY_SUMMARY: WorkGraphSummary = { generatedAt: "", contexts: [] };

export default function WorkGraphSummaryCard() {
  const [data, setData] = useState<WorkGraphSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const summary = await apiFetch<WorkGraphSummary>("/api/work-graph/summary?limit=3").catch(
        () => EMPTY_SUMMARY,
      );
      setData({
        generatedAt: summary.generatedAt ?? "",
        contexts: Array.isArray(summary.contexts) ? summary.contexts : [],
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener("conversations-updated", handler);
    return () => window.removeEventListener("conversations-updated", handler);
  }, [refresh]);

  if (loading && data.contexts.length === 0) return null;
  if (data.contexts.length === 0) return null;

  const totals = summarizeContexts(data.contexts);

  return (
    <section
      className="mb-6 overflow-hidden rounded-2xl border border-stone-800 bg-stone-950/70"
      aria-label="Work graph summary"
    >
      <div className="border-b border-stone-800 bg-gradient-to-br from-stone-950 via-stone-950 to-amber-950/20 p-4 md:p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200">
              Work graph
            </p>
            <h2 className="mt-2 text-lg font-semibold tracking-tight text-stone-100">
              Active work contexts
            </h2>
            <p className="mt-2 max-w-xl text-xs leading-5 text-stone-500">
              Jigeum groups mail, decision threads, and commitments into one work context so risk is
              easier to see.
            </p>
          </div>

          <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-white/10 bg-black/20 md:min-w-[240px]">
            <GraphMetric label="Contexts" value={data.contexts.length} />
            <GraphMetric label="Signals" value={totals.signals} />
            <GraphMetric label="Risk" value={totals.highRisk} />
          </div>
        </div>
      </div>

      <ul className="grid gap-3 p-3 md:p-4">
        {data.contexts.map((context) => (
          <li key={context.id}>
            <ContextCard context={context} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ContextCard({ context }: { context: WorkGraphContext }) {
  const legacyContext = context as WorkGraphContext & { lastSignalAt?: string };
  const chips = signalChips(context);
  const people = peopleLabels(context);
  const reasons = (context.reasons ?? []).slice(0, 2);
  const lastActivityAt = context.lastActivityAt ?? legacyContext.lastSignalAt;

  const body = (
    <article className="rounded-xl border border-stone-800 bg-stone-900/40 p-4 transition hover:border-amber-300/30 hover:bg-stone-900/60">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <RiskBadge risk={context.risk} />
            <span className="text-[11px] text-stone-500">{kindLabel(context.kind)}</span>
            <span className="text-[11px] text-stone-600">{formatRelative(lastActivityAt)}</span>
          </div>
          <p className="mt-2 break-words text-sm font-semibold text-stone-100">
            {displayText(context.title)}
          </p>
          <p className="mt-1 line-clamp-2 text-xs text-stone-400">
            {subtitleFor(context) || "No linked signals yet"}
          </p>
        </div>

        <ContextGlyph risk={context.risk} />
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <ContextPanel label="Signals">
          {chips.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <span
                  key={chip}
                  className="rounded border border-stone-800 bg-black/20 px-1.5 py-0.5 text-[11px] text-stone-400"
                >
                  {chip}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-stone-500">No clear signals yet.</p>
          )}
        </ContextPanel>

        <ContextPanel label="Why it appears">
          {reasons.length > 0 ? (
            <ul className="space-y-1.5">
              {reasons.map((reason) => (
                <li key={reason} className="text-xs leading-5 text-stone-400">
                  {displayText(reason)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-stone-500">Shown from recent activity.</p>
          )}
        </ContextPanel>
      </div>

      {people.length > 0 && (
        <div className="mt-3 flex items-center gap-2 border-t border-stone-800 pt-3">
          <span className="shrink-0 text-[11px] text-stone-600">People</span>
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {people.map((person) => (
              <span
                key={person}
                className="max-w-full truncate rounded border border-stone-800 px-1.5 py-0.5 text-[11px] text-stone-400"
              >
                {person}
              </span>
            ))}
          </div>
        </div>
      )}
    </article>
  );

  return context.href ? (
    <Link href={context.href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

function GraphMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-r border-white/10 px-3 py-2 last:border-r-0">
      <p className="text-lg font-semibold text-stone-100">{value}</p>
      <p className="mt-0.5 text-[10px] text-stone-600">{label}</p>
    </div>
  );
}

function ContextPanel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-stone-800 bg-black/20 p-3">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-200">
        {label}
      </p>
      {children}
    </section>
  );
}

function ContextGlyph({ risk }: { risk: WorkGraphRisk }) {
  const color =
    risk === "high"
      ? "border-red-400/25 bg-red-400/10 text-red-200"
      : risk === "medium"
        ? "border-amber-300/25 bg-amber-300/10 text-amber-200"
        : "border-amber-300/20 bg-amber-300/10 text-amber-100";

  return (
    <div
      className={`relative hidden h-16 w-16 shrink-0 items-center justify-center rounded-full border ${color} md:flex`}
      aria-hidden="true"
    >
      <span className="h-2 w-2 rounded-full bg-current" />
      <span className="absolute left-3 top-4 h-1.5 w-1.5 rounded-full bg-stone-500" />
      <span className="absolute right-4 top-3 h-1.5 w-1.5 rounded-full bg-stone-500" />
      <span className="absolute bottom-4 right-5 h-1.5 w-1.5 rounded-full bg-stone-500" />
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 64 64"
        fill="none"
        aria-hidden="true"
      >
        <path d="M19 22 32 32 45 20M32 32l10 16" stroke="currentColor" strokeOpacity=".28" />
      </svg>
    </div>
  );
}

function RiskBadge({ risk }: { risk: WorkGraphRisk }) {
  const entry = riskEntry(risk);
  return (
    <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 ${entry.className}`}>
      {entry.label}
    </span>
  );
}

function riskEntry(risk: WorkGraphRisk): { label: string; className: string } {
  switch (risk) {
    case "high":
      return { label: "High", className: "text-red-300 bg-red-500/10 border-red-500/20" };
    case "medium":
      return {
        label: "Medium",
        className: "text-amber-300 bg-amber-400/10 border-amber-400/20",
      };
    case "low":
      return { label: "Low", className: "text-stone-400 bg-stone-500/10 border-stone-500/20" };
  }
}

function kindLabel(kind: WorkGraphContext["kind"]): string {
  switch (kind) {
    case "email_thread":
      return "Mail";
    case "chat_conversation":
      return "Decision thread";
    case "loose_commitment":
      return "Commitment";
  }
}

function subtitleFor(context: WorkGraphContext): string | null {
  const people = peopleLabels(context).slice(0, 2).join(", ");
  const reasons = (context.reasons ?? []).slice(0, 2).map(displayText).join(" · ");
  return [people, reasons].filter(Boolean).join(" · ") || displayText(context.subtitle || "");
}

function signalChips(context: WorkGraphContext): string[] {
  const chips: string[] = [];
  const signals = context.signals ?? {};
  if (signals.pendingActions) chips.push(`Approval ${signals.pendingActions}`);
  if (signals.overdueCommitments) chips.push(`Overdue commitment ${signals.overdueCommitments}`);
  if (signals.commitments) chips.push(`Commitment ${signals.commitments}`);
  if (signals.urgentEmails) chips.push(`Urgent mail ${signals.urgentEmails}`);
  if (signals.unreadEmails) chips.push(`Unread ${signals.unreadEmails}`);
  if (chips.length === 0 && signals.emails) chips.push(`Mail ${signals.emails}`);
  return chips.slice(0, 4);
}

function peopleLabels(context: WorkGraphContext): string[] {
  return (context.people ?? [])
    .map((person) => person.name || person.email)
    .filter((person): person is string => Boolean(person))
    .slice(0, 3);
}

function summarizeContexts(contexts: WorkGraphContext[]): { signals: number; highRisk: number } {
  return contexts.reduce(
    (acc, context) => {
      acc.signals += Object.values(context.signals ?? {}).reduce(
        (sum, value) => sum + Number(value ?? 0),
        0,
      );
      if (context.risk === "high") acc.highRisk++;
      return acc;
    },
    { signals: 0, highRisk: 0 },
  );
}

function displayText(value: string | null | undefined): string {
  return value ?? "";
}
