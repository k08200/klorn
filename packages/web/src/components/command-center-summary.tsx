"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import type { AttentionItem, InboxSummary, TodaySection } from "../lib/inbox-summary";

const EMPTY_SUMMARY: InboxSummary = {
  top3: [],
  today: { events: [], overdueTasks: [], todayTasks: [] },
};

export default function CommandCenterSummary() {
  const [data, setData] = useState<InboxSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const summary = await apiFetch<InboxSummary>("/api/inbox/summary").catch(() => EMPTY_SUMMARY);
      setData(summary);
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

  const todayHasContent =
    data.today.events.length + data.today.overdueTasks.length + data.today.todayTasks.length > 0;

  if (loading && data.top3.length === 0 && !todayHasContent) {
    return null;
  }

  if (data.top3.length === 0 && !todayHasContent) {
    return null;
  }

  return (
    <section className="mb-6 space-y-4" aria-label="Command center summary">
      {data.top3.length > 0 && <Top3Section items={data.top3} />}
      {todayHasContent && <TodaySectionView section={data.today} />}
    </section>
  );
}

function Top3Section({ items }: { items: AttentionItem[] }) {
  return (
    <div className="rounded-xl border border-stone-800 bg-stone-900/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-stone-100">Needs attention now</h2>
        <span className="text-[11px] text-stone-500">Top {items.length}</span>
      </div>
      <ol className="space-y-2">
        {items.map((item, idx) => (
          <li key={`${item.kind}_${item.id}`}>
            <AttentionRow item={item} index={idx + 1} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function AttentionRow({ item, index }: { item: AttentionItem; index: number }) {
  const badge = badgeFor(item);
  const body = bodyFor(item);
  const href = hrefFor(item);
  const content = (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg border border-stone-800/60 bg-stone-900/40 hover:bg-stone-800/40 transition">
      <span className="text-[11px] font-semibold text-stone-500 mt-0.5 shrink-0 w-4 text-center">
        {index}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`text-[10px] font-medium border rounded px-1.5 py-0.5 ${badge.className}`}
          >
            {badge.label}
          </span>
          <span className="text-sm text-stone-100 truncate">{body.title}</span>
        </div>
        {body.subtitle && (
          <p className="mt-1 text-[11px] text-stone-400 line-clamp-1">{body.subtitle}</p>
        )}
        <DecisionTrace item={item} />
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {content}
    </Link>
  ) : (
    content
  );
}

function DecisionTrace({ item }: { item: AttentionItem }) {
  const decision = item.decision;
  const facts = decision.evidence.slice(0, 2);
  if (!decision.costOfIgnoring && facts.length === 0) return null;

  return (
    <div className="mt-2 grid gap-1.5 rounded-md border border-stone-800/70 bg-black/20 p-2">
      {decision.costOfIgnoring && (
        <p className="line-clamp-2 text-[11px] leading-4 text-stone-400">
          If missed: {decision.costOfIgnoring}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded border border-stone-800 px-1.5 py-0.5 text-[10px] text-stone-500">
          Confidence {Math.round(decision.confidence * 100)}%
        </span>
        {decision.suggestedAction && (
          <span className="rounded border border-amber-300/20 bg-amber-300/10 px-1.5 py-0.5 text-[10px] text-amber-200">
            {decision.suggestedAction}
          </span>
        )}
        {facts.map((fact) => (
          <span
            key={`${fact.label}:${fact.value}`}
            className="max-w-full truncate rounded border border-stone-800 px-1.5 py-0.5 text-[10px] text-stone-500"
          >
            {fact.label}: {fact.value}
          </span>
        ))}
      </div>
    </div>
  );
}

function badgeFor(item: AttentionItem): { label: string; className: string } {
  switch (item.kind) {
    case "pending_action":
      return {
        label: "Needs approval",
        className: "text-amber-300 bg-amber-400/10 border-amber-400/20",
      };
    case "overdue_task":
      return { label: "Overdue", className: "text-red-300 bg-red-500/10 border-red-500/20" };
    case "today_event":
      return {
        label: "Starting soon",
        className: "text-amber-200 bg-amber-300/10 border-amber-300/20",
      };
    case "agent_proposal":
      return {
        label: "Decision proposal",
        className: "text-amber-200 bg-amber-300/10 border-amber-300/20",
      };
    case "commitment":
      if (item.attentionType === "COMMITMENT_OVERDUE") {
        return {
          label: "Commitment overdue",
          className: "text-red-300 bg-red-500/10 border-red-500/20",
        };
      }
      if (item.attentionType === "COMMITMENT_UNCONFIRMED") {
        return {
          label: "Needs confirmation",
          className: "text-violet-300 bg-violet-400/10 border-violet-400/20",
        };
      }
      return {
        label: "Commitment due",
        className: "text-emerald-300 bg-emerald-400/10 border-emerald-400/20",
      };
  }
}

function bodyFor(item: AttentionItem): { title: string; subtitle: string | null } {
  switch (item.kind) {
    case "pending_action":
      return { title: item.label, subtitle: item.reasoning };
    case "overdue_task":
      return {
        title: item.title,
        subtitle: `${item.daysOverdue}d overdue`,
      };
    case "today_event":
      return {
        title: item.title,
        subtitle: formatEventSubtitle(item.startTime, item.minutesAway, item.location),
      };
    case "agent_proposal":
      return { title: stripEvePrefix(item.title), subtitle: item.message };
    case "commitment":
      return {
        title: item.title,
        subtitle:
          [ownerLabel(item.owner), dueLabel(item), item.description].filter(Boolean).join(" · ") ||
          null,
      };
  }
}

function hrefFor(item: AttentionItem): string | null {
  switch (item.kind) {
    case "pending_action":
      return `/chat/${item.conversationId}`;
    case "overdue_task":
      return null;
    case "today_event":
      return "/calendar";
    case "agent_proposal":
      return item.link ?? null;
    case "commitment":
      return null;
  }
}

function ownerLabel(owner: string): string | null {
  switch (owner) {
    case "USER":
      return "Your commitment";
    case "COUNTERPARTY":
      return "Counterparty commitment";
    case "TEAM":
      return "Team commitment";
    case "UNKNOWN":
      return "Needs owner";
    default:
      return null;
  }
}

function dueLabel(item: Extract<AttentionItem, { kind: "commitment" }>): string | null {
  if (item.dueText) return item.dueText;
  if (!item.dueAt) return null;
  return formatDate(item.dueAt);
}

function stripEvePrefix(title: string): string {
  const legacyPrefix = "[EV" + "E]";
  if (title.startsWith("[Eve]")) return title.slice(5).trim();
  if (title.startsWith(legacyPrefix)) return title.slice(5).trim();
  return title;
}

function formatEventSubtitle(
  startTime: string,
  minutesAway: number,
  location: string | null,
): string {
  const time = new Date(startTime).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const inMin =
    minutesAway <= 0
      ? "in progress"
      : minutesAway < 60
        ? `in ${minutesAway}m`
        : `in ${Math.round(minutesAway / 60)}h`;
  return location ? `${time} · ${inMin} · ${location}` : `${time} · ${inMin}`;
}

function TodaySectionView({ section }: { section: TodaySection }) {
  return (
    <div className="rounded-xl border border-stone-800 bg-stone-900/40 p-4">
      <h2 className="text-sm font-semibold text-stone-100 mb-3">Today at a glance</h2>
      <div className="space-y-3">
        {section.events.length > 0 && (
          <SubList
            label="Today's events"
            items={section.events.map((e) => ({
              key: e.id,
              primary: e.title,
              secondary: formatTime(e.startTime),
            }))}
          />
        )}
        {section.overdueTasks.length > 0 && (
          <SubList
            label="Overdue"
            tone="warn"
            items={section.overdueTasks.map((t) => ({
              key: t.id,
              primary: t.title,
              secondary: t.dueDate ? formatDate(t.dueDate) : null,
            }))}
          />
        )}
        {section.todayTasks.length > 0 && (
          <SubList
            label="Due today"
            items={section.todayTasks.map((t) => ({
              key: t.id,
              primary: t.title,
              secondary: priorityLabel(t.priority),
            }))}
          />
        )}
      </div>
    </div>
  );
}

interface SubListItem {
  key: string;
  primary: string;
  secondary: string | null;
}

function SubList({ label, items, tone }: { label: string; items: SubListItem[]; tone?: "warn" }) {
  const labelClass = tone === "warn" ? "text-red-300" : "text-stone-400";
  return (
    <div>
      <p className={`text-[11px] font-medium mb-1.5 ${labelClass}`}>
        {label} · {items.length}
      </p>
      <ul className="space-y-1">
        {items.slice(0, 3).map((it) => (
          <li
            key={it.key}
            className="flex items-center gap-2 text-sm text-stone-200 px-2 py-1 rounded border border-transparent hover:border-stone-800/80"
          >
            <span className="truncate flex-1">{it.primary}</span>
            {it.secondary && (
              <span className="text-[11px] text-stone-500 shrink-0">{it.secondary}</span>
            )}
          </li>
        ))}
        {items.length > 3 && (
          <li className="text-[11px] text-stone-600 px-2">+ {items.length - 3} more</li>
        )}
      </ul>
    </div>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function priorityLabel(p: string): string | null {
  const up = p.toUpperCase();
  if (up === "URGENT") return "Urgent";
  if (up === "HIGH") return "High";
  if (up === "MEDIUM") return "Medium";
  if (up === "LOW") return "Low";
  return null;
}
