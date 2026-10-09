/**
 * What an approval card says about a pending action (productization plan P7).
 *
 * Pure and import-light so the api vitest suite can pin it. Nothing here
 * returns a tool id or a record id as text: the title is an i18n key from
 * lib/tool-labels, and the "what" is the subject, title or resolved target the
 * server sent — never the raw argument that names a row.
 */

import { KNOWN_TOOL_IDS, toolLabelKey, UNKNOWN_TOOL_LABEL_KEY } from "../../../lib/tool-labels";

/** One row of GET /api/chat/pending-actions. */
export interface PendingActionItem {
  id: string;
  conversationId: string;
  conversationTitle: string | null;
  status: "PENDING" | "REJECTED" | "EXECUTED" | "FAILED";
  toolName: string;
  /** Stored as JSON; arrives as an object, or as a string on older rows. */
  toolArgs: unknown;
  targetLabel: string | null;
  reasoning: string | null;
  result: string | null;
  createdAt: string;
}

/** A labelled line under the title: who it goes to, when, where. */
export interface ApprovalFact {
  labelKey: string;
  /** Shown as written. */
  text?: string;
  /** An instant the card formats in the reader's locale and zone. */
  iso?: string;
}

export interface ApprovalModel {
  id: string;
  /** i18n key of the action's name ("Send email"). */
  titleKey: string;
  /** The proposal reverses an earlier action (receipt "Request undo"). */
  undo: boolean;
  /** Approving sends mail. A sent mail cannot be taken back. */
  sendsMail: boolean;
  /** The thing acted on: a subject, an event title, a resolved target. */
  subject: string | null;
  facts: ApprovalFact[];
  /** Why Klorn proposes it. */
  why: string | null;
  /** The proposed content itself: the draft body, the event description. */
  preview: string | null;
  createdAt: string;
}

const UNDO_PREFIX = "undo_";
const KNOWN_TOOLS: ReadonlySet<string> = new Set(KNOWN_TOOL_IDS);
const MAIL_SENDING_TOOLS: ReadonlySet<string> = new Set(["send_email", "reply_to_email"]);

const FACT = {
  to: "assistantHub.approvals.fact.to",
  when: "assistantHub.approvals.fact.when",
  where: "assistantHub.approvals.fact.where",
  email: "assistantHub.approvals.fact.email",
} as const;

type Args = ReadonlyMap<string, unknown>;

/** Arguments as a Map, so a key such as "constructor" finds nothing inherited. */
function parseArgs(raw: unknown): Args {
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

const REASONING_LABELS = ["Situation", "Judgment", "Proposal"] as const;
type ReasoningLabel = (typeof REASONING_LABELS)[number];

function readSection(reasoning: string, label: ReasoningLabel): string | null {
  const others = REASONING_LABELS.filter((item) => item !== label).join("|");
  const match = reasoning.match(
    new RegExp(
      `(?:📋|💡|✅)?\\s*${label}\\s*[:：]\\s*([\\s\\S]*?)(?=(?:📋|💡|✅)?\\s*(?:${others})\\s*[:：]|$)`,
    ),
  );
  return match?.[1]?.trim() || null;
}

/**
 * The one paragraph of "why". The agent writes Situation / Judgment / Proposal;
 * the judgment is the reason, the situation a weaker stand-in. Unlabelled text
 * is shown whole.
 */
export function splitReasoning(reasoning: string | null): string | null {
  const text = reasoning?.trim();
  if (!text) return null;
  return readSection(text, "Judgment") || readSection(text, "Situation") || text;
}

interface Content {
  subject: string | null;
  facts: ApprovalFact[];
  preview: string | null;
}

const NO_CONTENT: Content = { subject: null, facts: [], preview: null };

function mailContent(args: Args): Content {
  const to = pick(args, "to", "recipient");
  return {
    subject: pick(args, "subject"),
    facts: to ? [{ labelKey: FACT.to, text: to }] : [],
    preview: pick(args, "body", "message"),
  };
}

function whenFact(start: string): ApprovalFact {
  const valid = Number.isFinite(new Date(start).getTime());
  return valid ? { labelKey: FACT.when, iso: start } : { labelKey: FACT.when, text: start };
}

function eventContent(args: Args): Content {
  const start = pick(args, "start_time", "startTime");
  const where = pick(args, "location");
  return {
    subject: pick(args, "summary", "title"),
    facts: [
      ...(start ? [whenFact(start)] : []),
      ...(where ? [{ labelKey: FACT.where, text: where }] : []),
    ],
    preview: pick(args, "description"),
  };
}

function titledContent(args: Args): Content {
  return { subject: pick(args, "title"), facts: [], preview: pick(args, "content", "description") };
}

function contactContent(args: Args): Content {
  const email = pick(args, "email");
  return {
    subject: pick(args, "name"),
    facts: email ? [{ labelKey: FACT.email, text: email }] : [],
    preview: null,
  };
}

/** How each tool's arguments read as a card. A tool not listed shows its title alone. */
const CONTENT_BY_TOOL: ReadonlyMap<string, (args: Args) => Content> = new Map([
  ["send_email", mailContent],
  ["reply_to_email", mailContent],
  ["draft_reply", mailContent],
  ["create_event", eventContent],
  ["schedule_meeting", eventContent],
  ["create_note", titledContent],
  ["create_task", titledContent],
  ["create_contact", contactContent],
  ["update_contact", contactContent],
]);

export function approvalModel(action: PendingActionItem): ApprovalModel {
  const raw = action.toolName || "";
  const undo = raw.startsWith(UNDO_PREFIX);
  const tool = undo ? raw.slice(UNDO_PREFIX.length) : raw;
  const content = CONTENT_BY_TOOL.get(tool)?.(parseArgs(action.toolArgs)) ?? NO_CONTENT;
  return {
    id: action.id,
    titleKey: KNOWN_TOOLS.has(tool) ? toolLabelKey(tool) : UNKNOWN_TOOL_LABEL_KEY,
    undo,
    sendsMail: !undo && MAIL_SENDING_TOOLS.has(tool),
    subject:
      content.subject || action.targetLabel?.trim() || action.conversationTitle?.trim() || null,
    facts: content.facts,
    why: splitReasoning(action.reasoning),
    preview: content.preview,
    createdAt: action.createdAt,
  };
}

/**
 * The card j / k lands on. Nothing is selected until the first press, and the
 * ends stop rather than wrap, so holding a key never loops past the list.
 */
export function nextSelection(
  ids: readonly string[],
  current: string | null,
  step: 1 | -1,
): string | null {
  if (ids.length === 0) return null;
  const index = current === null ? -1 : ids.indexOf(current);
  if (index === -1) return step === 1 ? ids[0] : ids[ids.length - 1];
  return ids[Math.min(ids.length - 1, Math.max(0, index + step))];
}
