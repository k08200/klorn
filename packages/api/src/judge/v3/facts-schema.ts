/**
 * Attention Engine v3 — facts schema v1. Canonical types and validator.
 *
 * Contract: docs/design/attention-engine-v3.md §3(1). The field names, enums
 * and nullability here mirror that table exactly; change the doc by PR before
 * changing this file. Every consumer (extractor, policy, replay, eval) reads
 * facts through parseFactsV1 so a stored row and a fresh model answer go
 * through the same gate.
 *
 * The model's output is untrusted: free text is trimmed, stripped of control
 * characters and length-capped, and anything outside the enums is dropped
 * with a recorded issue (an issue marks the item for escalation upstream).
 */

export const FACTS_VERSION = 1 as const;

export const ASK_KINDS = ["reply", "decide", "pay", "attend", "review", "provide"] as const;
export const ADDRESSED_TO = ["me_direct", "me_cc", "group", "bulk"] as const;
export const THREAD_TURNS = ["mine_to_reply", "theirs", "none"] as const;
export const TRANSACTION_KINDS = ["receipt", "invoice", "shipping", "code", "statement"] as const;
export const RISKS = [
  "payment_failed",
  "security_alert",
  "account_change",
  "phishing_suspect",
] as const;
export const MAIL_KINDS = [
  "personal",
  "work_thread",
  "notification",
  "newsletter",
  "promotion",
  "receipt",
  "meeting",
] as const;

export type AskKind = (typeof ASK_KINDS)[number];
export type AddressedTo = (typeof ADDRESSED_TO)[number];
export type ThreadTurn = (typeof THREAD_TURNS)[number];
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];
export type Risk = (typeof RISKS)[number];
export type MailKind = (typeof MAIL_KINDS)[number];

export interface FactAsk {
  kind: AskKind;
  object: string;
  /** Absolute ISO-8601 date-time with an explicit offset, or null. */
  due: string | null;
  /** Verbatim quote from the mail; verified by v3/evidence.ts. */
  evidence: string;
}

export interface FactEvent {
  proposedTimes: string[];
  hasInvite: boolean;
  conflict: boolean | null;
}

export interface FactTransaction {
  kind: TransactionKind;
  actionRequired: boolean;
}

export interface FactsV1 {
  asks: FactAsk[];
  addressedTo: AddressedTo;
  threadTurn: ThreadTurn;
  event: FactEvent | null;
  transaction: FactTransaction | null;
  risk: Risk[];
  kind: MailKind;
  ambiguous: boolean;
}

export const FACT_FIELDS = [
  "asks",
  "addressedTo",
  "threadTurn",
  "event",
  "transaction",
  "risk",
  "kind",
  "ambiguous",
] as const satisfies readonly (keyof FactsV1)[];
export type FactField = (typeof FACT_FIELDS)[number];

export const MAX_ASKS = 8;
export const MAX_PROPOSED_TIMES = 8;
export const MAX_OBJECT_CHARS = 160;
export const MAX_EVIDENCE_CHARS = 300;

export interface ParseFactsResult {
  facts: FactsV1 | null;
  issues: string[];
}

// Offset is mandatory: a floating local time is not absolute.
const ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

// C0/C1 controls (incl. ESC, so no terminal escape survives) — free text from
// the model is shown in reasons and must stay inert.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point.
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

function isOneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (values as readonly string[]).includes(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True for an absolute ISO-8601 date-time that names a real calendar instant. */
export function isAbsoluteIsoDateTime(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = ISO_DATETIME_RE.exec(v);
  if (!m) return false;
  const [, y, mo, d, h, mi, s, oh, om] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s ?? 0) > 59) return false;
  if (oh !== undefined && (Number(oh) > 14 || Number(om) > 59)) return false;
  return !Number.isNaN(Date.parse(v));
}

/** Trim, strip control characters, collapse inner whitespace, cap length. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

function parseAsks(raw: unknown, issues: string[]): FactAsk[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_ASKS) issues.push(`asks: truncated to ${MAX_ASKS}`);
  const asks: FactAsk[] = [];
  raw.slice(0, MAX_ASKS).forEach((a, i) => {
    if (!isRecord(a) || !isOneOf(ASK_KINDS, a.kind)) {
      issues.push(`asks[${i}]: invalid kind`);
      return;
    }
    const evidence = cleanText(a.evidence, MAX_EVIDENCE_CHARS);
    if (!evidence) {
      issues.push(`asks[${i}]: empty evidence`);
      return;
    }
    const object = cleanText(a.object, MAX_OBJECT_CHARS);
    if (!object) {
      issues.push(`asks[${i}]: empty object`);
      return;
    }
    let due: string | null = null;
    if (a.due !== null && a.due !== undefined) {
      if (isAbsoluteIsoDateTime(a.due)) due = a.due;
      else issues.push(`asks[${i}].due: not an absolute ISO-8601 date-time`);
    }
    asks.push({ kind: a.kind, object, due, evidence });
  });
  return asks;
}

function parseEvent(raw: unknown, issues: string[]): FactEvent | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw) || typeof raw.hasInvite !== "boolean" || !Array.isArray(raw.proposedTimes)) {
    issues.push("event: invalid");
    return null;
  }
  const conflict = typeof raw.conflict === "boolean" ? raw.conflict : null;
  if (raw.proposedTimes.length > MAX_PROPOSED_TIMES) {
    issues.push(`event.proposedTimes: truncated to ${MAX_PROPOSED_TIMES}`);
  }
  const proposedTimes: string[] = [];
  raw.proposedTimes.slice(0, MAX_PROPOSED_TIMES).forEach((t, i) => {
    if (isAbsoluteIsoDateTime(t)) proposedTimes.push(t);
    else issues.push(`event.proposedTimes[${i}]: not an absolute ISO-8601 date-time`);
  });
  return { proposedTimes, hasInvite: raw.hasInvite, conflict };
}

function parseTransaction(raw: unknown, issues: string[]): FactTransaction | null {
  if (raw === null || raw === undefined) return null;
  if (
    !isRecord(raw) ||
    !isOneOf(TRANSACTION_KINDS, raw.kind) ||
    typeof raw.actionRequired !== "boolean"
  ) {
    issues.push("transaction: invalid");
    return null;
  }
  return { kind: raw.kind, actionRequired: raw.actionRequired };
}

function parseRisk(raw: unknown, issues: string[]): Risk[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Risk[] = [];
  raw.forEach((r, i) => {
    if (!isOneOf(RISKS, r)) issues.push(`risk[${i}]: invalid`);
    else if (!out.includes(r)) out.push(r);
  });
  return out;
}

/**
 * Validate an untrusted value as facts v1. Required scalars (addressedTo,
 * threadTurn, kind, ambiguous) and the two arrays must be valid or the whole
 * set is rejected; individual bad entries inside arrays/objects are dropped
 * and reported. Unknown keys are ignored.
 */
export function parseFactsV1(raw: unknown): ParseFactsResult {
  const issues: string[] = [];
  if (!isRecord(raw)) return { facts: null, issues: ["facts: not an object"] };

  const asks = parseAsks(raw.asks, issues);
  if (asks === null) issues.push("asks: invalid");
  if (!isOneOf(ADDRESSED_TO, raw.addressedTo)) issues.push("addressedTo: invalid");
  if (!isOneOf(THREAD_TURNS, raw.threadTurn)) issues.push("threadTurn: invalid");
  if (!isOneOf(MAIL_KINDS, raw.kind)) issues.push("kind: invalid");
  if (typeof raw.ambiguous !== "boolean") issues.push("ambiguous: invalid");
  const risk = parseRisk(raw.risk, issues);
  if (risk === null) issues.push("risk: invalid");
  const event = parseEvent(raw.event, issues);
  const transaction = parseTransaction(raw.transaction, issues);

  if (
    asks === null ||
    risk === null ||
    !isOneOf(ADDRESSED_TO, raw.addressedTo) ||
    !isOneOf(THREAD_TURNS, raw.threadTurn) ||
    !isOneOf(MAIL_KINDS, raw.kind) ||
    typeof raw.ambiguous !== "boolean"
  ) {
    return { facts: null, issues };
  }

  return {
    facts: {
      asks,
      addressedTo: raw.addressedTo,
      threadTurn: raw.threadTurn,
      event,
      transaction,
      risk,
      kind: raw.kind,
      ambiguous: raw.ambiguous,
    },
    issues,
  };
}
