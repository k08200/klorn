/**
 * What an approval card says (ported from the web's
 * app/assistant/approvals/model.ts) and how Activity reads the day's receipt
 * (app/assistant/activity/model.ts). Pure: no React, no DOM (model.test.ts).
 *
 * Nothing here shows a tool id or a record id as text: the title is a message
 * key, and the "what" is the subject, title or resolved target the server
 * sent — never the raw argument that names a row.
 */
import type { DailyReceipt, ReceiptItem } from "@klorn/contract";
import type { ChatMessageWire, PendingActionWire } from "../../api/wire";
import type { MessageKey } from "../../i18n";

// ── Approvals ───────────────────────────────────────────────────────────────

/** Tools Klorn has a name for; any other tool lists its arguments under "Requested action". */
export const TOOL_LABELS: Readonly<Record<string, MessageKey>> = {
  send_email: "assistant.tool.send_email",
  reply_to_email: "assistant.tool.reply_to_email",
  draft_reply: "assistant.tool.draft_reply",
  archive_email: "assistant.tool.archive_email",
  delete_email: "assistant.tool.delete_email",
  mark_read: "assistant.tool.mark_read",
  create_event: "assistant.tool.create_event",
  delete_event: "assistant.tool.delete_event",
  schedule_meeting: "assistant.tool.schedule_meeting",
  create_contact: "assistant.tool.create_contact",
  update_contact: "assistant.tool.update_contact",
  delete_contact: "assistant.tool.delete_contact",
  create_note: "assistant.tool.create_note",
  delete_note: "assistant.tool.delete_note",
  create_task: "assistant.tool.create_task",
  delete_task: "assistant.tool.delete_task",
  prepared_action: "assistant.tool.prepared_action",
};

export const UNKNOWN_TOOL: MessageKey = "assistant.tool.unknown";

export type ApprovalKind = "email" | "calendar" | "other";

export interface ApprovalFact {
  /** A message key for the lines a tool's own layout names. */
  labelKey?: MessageKey;
  /** An argument's name, for a tool with no layout. */
  label?: string;
  text?: string;
  /** An instant the card formats in the reader's locale and zone. */
  iso?: string;
}

export interface ApprovalModel {
  id: string;
  titleKey: MessageKey;
  kind: ApprovalKind;
  /** The proposal reverses an earlier action (Activity's "Request undo"). */
  undo: boolean;
  /** Approving sends mail, which cannot be taken back. */
  sendsMail: boolean;
  subject: string | null;
  facts: ApprovalFact[];
  why: string | null;
  /** The proposed content itself: the draft body, the event description. */
  preview: string | null;
  createdAt: string;
}

const UNDO_PREFIX = "undo_";
const MAIL_SENDING = new Set(["send_email", "reply_to_email"]);

type Args = ReadonlyMap<string, unknown>;

/** Arguments as a Map, so "constructor" finds nothing inherited. */
export function parseArgs(raw: unknown): Args {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return new Map();
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
  return new Map(Object.entries(value));
}

function pick(args: Args, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args.get(key);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

const REASONING = ["Situation", "Judgment", "Proposal"] as const;

function section(reasoning: string, label: (typeof REASONING)[number]): string | null {
  const others = REASONING.filter((x) => x !== label).join("|");
  const match = reasoning.match(
    new RegExp(
      `(?:📋|💡|✅)?\\s*${label}\\s*[:：]\\s*([\\s\\S]*?)(?=(?:📋|💡|✅)?\\s*(?:${others})\\s*[:：]|$)`,
    ),
  );
  return match?.[1]?.trim() || null;
}

/** The one paragraph of "why": the Judgment, else the Situation, else the text whole. */
export function splitReasoning(reasoning: string | null): string | null {
  const text = reasoning?.trim();
  if (!text) return null;
  return section(text, "Judgment") || section(text, "Situation") || text;
}

interface Content {
  subject: string | null;
  facts: ApprovalFact[];
  preview: string | null;
}

function mail(args: Args): Content {
  const to = pick(args, "to", "recipient");
  return {
    subject: pick(args, "subject"),
    facts: to ? [{ labelKey: "assistant.fact.to", text: to }] : [],
    preview: pick(args, "body", "message"),
  };
}

function event(args: Args): Content {
  const start = pick(args, "start_time", "startTime");
  const where = pick(args, "location");
  const facts: ApprovalFact[] = [];
  if (start) {
    facts.push(
      Number.isFinite(Date.parse(start))
        ? { labelKey: "assistant.fact.when", iso: start }
        : { labelKey: "assistant.fact.when", text: start },
    );
  }
  if (where) facts.push({ labelKey: "assistant.fact.where", text: where });
  return { subject: pick(args, "summary", "title"), facts, preview: pick(args, "description") };
}

function titled(args: Args): Content {
  return { subject: pick(args, "title"), facts: [], preview: pick(args, "content", "description") };
}

function contact(args: Args): Content {
  const email = pick(args, "email");
  return {
    subject: pick(args, "name"),
    facts: email ? [{ labelKey: "assistant.fact.email", text: email }] : [],
    preview: null,
  };
}

const CONTENT: ReadonlyMap<string, (args: Args) => Content> = new Map([
  ["send_email", mail],
  ["reply_to_email", mail],
  ["draft_reply", mail],
  ["create_event", event],
  ["schedule_meeting", event],
  ["create_note", titled],
  ["create_task", titled],
  ["create_contact", contact],
  ["update_contact", contact],
]);

const MAX_LINES = 8;
const RECORD_ID = /(^id$|_id$|Id$)/;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

function argumentLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return clip(words.charAt(0).toUpperCase() + words.slice(1), 40);
}

function argumentText(value: unknown): string | null {
  const parts = (Array.isArray(value) ? value : [value])
    .filter((p) => typeof p === "string" || typeof p === "number" || typeof p === "boolean")
    .map((p) => String(p).replace(/\s+/g, " ").trim());
  const text = parts.filter(Boolean).join(", ");
  return text ? clip(text, 200) : null;
}

/** A tool with no layout still says what it would do: its plain arguments, capped. */
function argumentFacts(args: Args, withIds: boolean): ApprovalFact[] {
  return [...args.entries()]
    .filter(([key]) => withIds || !RECORD_ID.test(key))
    .flatMap(([key, value]): ApprovalFact[] => {
      const text = argumentText(value);
      return text ? [{ label: argumentLabel(key), text }] : [];
    })
    .slice(0, MAX_LINES);
}

export function approvalKindOf(tool: string): ApprovalKind {
  const name = tool.toLowerCase();
  if (/(email|mail|reply|draft)/.test(name)) return "email";
  if (/(calendar|event|meeting|schedule)/.test(name)) return "calendar";
  return "other";
}

export function approvalModel(action: PendingActionWire): ApprovalModel {
  const raw = action.toolName || "";
  const undo = raw.startsWith(UNDO_PREFIX);
  const tool = undo ? raw.slice(UNDO_PREFIX.length) : raw;
  const known = tool in TOOL_LABELS;
  const args = parseArgs(action.toolArgs);
  const content = CONTENT.get(tool)?.(args) ?? {
    subject: null,
    facts: argumentFacts(args, !known),
    preview: null,
  };
  return {
    id: action.id,
    titleKey: known ? (TOOL_LABELS[tool] as MessageKey) : UNKNOWN_TOOL,
    kind: approvalKindOf(tool),
    undo,
    sendsMail: !undo && MAIL_SENDING.has(tool),
    subject:
      content.subject || action.targetLabel?.trim() || action.conversationTitle?.trim() || null,
    facts: content.facts,
    why: splitReasoning(action.reasoning),
    preview: content.preview,
    createdAt: action.createdAt,
  };
}

// ── Activity ────────────────────────────────────────────────────────────────

export type ActivityKind = "handled" | "notified" | "queued" | "silenced";

export interface ActivityEntry {
  key: string;
  kind: ActivityKind;
  item: ReceiptItem;
}

const time = (iso: string) => {
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : 0;
};

/** The four receipt lists as one timeline, newest first. */
export function activityEntries(receipt: DailyReceipt): ActivityEntry[] {
  const tag = (kind: ActivityKind, items: readonly ReceiptItem[] | undefined): ActivityEntry[] =>
    (Array.isArray(items) ? items : []).map((item) => ({ key: `${kind}:${item.id}`, kind, item }));
  return [
    ...tag("handled", receipt.auto),
    ...tag("notified", receipt.pushed),
    ...tag("queued", receipt.queued),
    ...tag("silenced", receipt.silenced),
  ].sort((a, b) => time(b.item.surfacedAt) - time(a.item.surfacedAt));
}

export type DayPart = "night" | "morning" | "afternoon" | "evening";

export function dayPartOf(iso: string, timeZone: string): DayPart {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "morning";
  let hour: number;
  try {
    hour = Number.parseInt(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(
        date,
      ),
      10,
    );
  } catch {
    return "morning";
  }
  if (!Number.isInteger(hour)) return "morning";
  if (hour < 5) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

export interface ActivityGroup {
  part: DayPart;
  entries: ActivityEntry[];
}

/** Consecutive entries of the same part of the day, in order. */
export function groupByDayPart(
  entries: readonly ActivityEntry[],
  timeZone: string,
): ActivityGroup[] {
  const out: ActivityGroup[] = [];
  for (const entry of entries) {
    const part = dayPartOf(entry.item.surfacedAt, timeZone);
    const last = out[out.length - 1];
    if (last && last.part === part) last.entries.push(entry);
    else out.push({ part, entries: [entry] });
  }
  return out;
}

export type ActivityText = { key: MessageKey } | { text: string };

const OBSERVED = /^Email signal \(.*\)$/;

/** The row's title: a tool id spelled with spaces becomes its label. */
export function activityTitle(item: ReceiptItem): ActivityText {
  const title = item.title?.trim() ?? "";
  if (item.source === "PENDING_ACTION") {
    const tool = title.replace(/ /g, "_");
    const key = TOOL_LABELS[tool];
    if (key) return { key };
  }
  if (OBSERVED.test(title)) return { key: "assistant.activity.observed" };
  return { text: title };
}

const FIXED_REASONS: ReadonlyMap<string, MessageKey> = new Map([
  ["Auto-executed — low risk, pre-approved", "assistant.activity.reason.executed"],
  ["Observed in SHADOW mode — not surfaced yet", "assistant.activity.reason.observed"],
]);

/** The two reasons the server writes in English get a translation; the judge's own stay. */
export function activityReason(reason: string | null): ActivityText | null {
  if (!reason) return null;
  const key = FIXED_REASONS.get(reason);
  return key ? { key } : { text: reason };
}

// ── Chat ────────────────────────────────────────────────────────────────────

/** Messages the thread shows: the user's and the assistant's (system rows stay hidden). */
export function visibleMessages(messages: readonly ChatMessageWire[]): ChatMessageWire[] {
  return messages.filter((m) => (m.role === "USER" || m.role === "ASSISTANT") && m.content.trim());
}

// ── The daily AI allowance ──────────────────────────────────────────────────

export interface ChatCapNotice {
  key: MessageKey;
  /** A FREE user can lift the cap by subscribing: the line ends with See plans. */
  plans: boolean;
}

/**
 * What the thread says when a turn stopped at the daily AI allowance
 * (ChatTurnResponse.errorCode). The server's `reply` is English, so the app
 * writes the line itself; an unknown or absent code (an older server) is no
 * notice and the thread behaves as before.
 */
export function chatCapNotice(errorCode: string | null | undefined): ChatCapNotice | null {
  if (errorCode === "DAILY_COST_CAP_FREE") return { key: "assistant.chat.capFree", plans: true };
  if (errorCode === "DAILY_COST_CAP") return { key: "assistant.chat.cap", plans: false };
  return null;
}

/**
 * The notice a stored assistant message shows, if any. The code the server
 * stored on the message (`metadata.turnErrorCode`) wins, so the line survives
 * a reload or leaving the screen; `live` (replies that stopped at the cap in
 * this session, by their text) only covers a server that stores no code.
 */
export function capNoticeOf(
  message: ChatMessageWire,
  live: ReadonlyMap<string, ChatCapNotice>,
): ChatCapNotice | null {
  if (message.role !== "ASSISTANT") return null;
  return chatCapNotice(message.metadata?.turnErrorCode) ?? live.get(message.content) ?? null;
}
