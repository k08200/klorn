"use client";

/**
 * Small presentational atoms and shared types for the chat detail page.
 *
 * Pulled out of page.tsx (which was 1323 lines) so the message/action
 * domain types and the tiny ThreadMetric pill have somewhere to live
 * apart from the 1200-line ChatPageContent component.
 */

export interface Message {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  // JSONB after migration 20260519070000 — server now returns a
  // parsed object instead of a JSON-string. Kept as `unknown` because
  // the client does not actually read it today.
  metadata?: unknown;
  createdAt: string;
}

export interface PendingAction {
  id: string;
  messageId: string;
  status: "PENDING" | "REJECTED" | "EXECUTED" | "FAILED";
  toolName: string;
  toolArgs: string;
  /** Server-resolved human label (task title, contact name, …) — null when n/a */
  targetLabel?: string | null;
  reasoning?: string;
  result?: string;
}

export function ThreadMetric({
  label,
  value,
  tone = "idle",
}: {
  label: string;
  value: number;
  tone?: "idle" | "hot";
}) {
  return (
    <div
      className={`rounded-lg border px-2.5 py-1.5 ${
        tone === "hot"
          ? "border-amber-300/25 bg-amber-300/10 text-amber-100"
          : "border-stone-700/45 bg-stone-950/35 text-stone-300"
      }`}
    >
      <p className="text-[10px] text-stone-600">{label}</p>
      <p className="text-sm font-semibold leading-none">{value}</p>
    </div>
  );
}

/**
 * Heuristic follow-up suggestions surfaced under the assistant's reply.
 * Pure over `(userMsg, assistantMsg)` so it can be tested without the
 * chat page's state context.
 */
export function buildChatSuggestions(userMsg: string, assistantMsg: string): string[] {
  const s: string[] = [];
  const lower = `${userMsg} ${assistantMsg}`.toLowerCase();

  if (lower.includes("email") || lower.includes("mail")) {
    s.push("Show only important mail", "Draft a reply");
  } else if (lower.includes("task") || lower.includes("todo")) {
    s.push("Show today's deadlines", "Sort by priority");
  } else if (lower.includes("calendar") || lower.includes("schedule")) {
    s.push("Show this week's schedule", "Find open time");
  } else if (lower.includes("note") || lower.includes("memo")) {
    s.push("Show recent notes", "Draft a report");
  }

  if (s.length === 0) {
    s.push("Show more evidence", "Compare other options");
  }
  s.push("Summarize this");
  return s.slice(0, 3);
}
