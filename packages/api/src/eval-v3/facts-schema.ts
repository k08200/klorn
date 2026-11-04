/**
 * Facts schema v1 (docs/design/attention-engine-v3.md §3(1)): EVAL-ONLY copy.
 *
 * The canonical types and validator belong to the P2 extractor
 * (`src/judge/v3/facts-schema.ts`, `parseFactsV1`). This copy lets the P1
 * benchmark run before that lands. It matches the doc field for field. Once
 * P2 is on main, switch the imports to it and delete this file. Do not grow
 * this copy: a schema change goes to the doc first, by PR.
 *
 * `factsVersion` is the persistence column, not a field; an extra key is ignored.
 */

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
export const FACT_KINDS = [
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
export type FactKind = (typeof FACT_KINDS)[number];

export interface FactAsk {
  kind: AskKind;
  object: string;
  /** Absolute ISO 8601, computed against the mail's Date header; null when none. */
  due: string | null;
  /** Verbatim quote from the subject/body; verified by evidence.ts. */
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
  kind: FactKind;
  ambiguous: boolean;
}

export interface ParsedFacts {
  /** null when a required top-level field is missing or invalid. */
  facts: FactsV1 | null;
  /** Every coercion or drop, so a run can report model anomalies. */
  issues: string[];
}

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function oneOf<T extends string>(allowed: readonly T[], v: unknown): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAIVE_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * A due the policy can compare on any machine. `Date.parse` reads a datetime
 * without an offset in the PROCESS time zone, so the same stored facts would
 * replay to different lanes in Seoul and in CI. A naive datetime is read as
 * UTC (the eval sets' Date headers are UTC); a date-only due as 23:59 that day.
 */
function canonicalDue(v: string): { due: string | null; note?: string } {
  if (DATE_ONLY_RE.test(v)) return { due: `${v}T23:59:00Z`, note: "date-only — read as 23:59 UTC" };
  if (NAIVE_DATETIME_RE.test(v)) return { due: `${v}Z`, note: "no offset — read as UTC" };
  return isIsoDate(v) ? { due: v } : { due: null };
}

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
}

function parseAsk(raw: unknown, i: number, issues: string[]): FactAsk | null {
  if (!isRecord(raw)) {
    issues.push(`ask[${i}] is not an object`);
    return null;
  }
  const kind = oneOf(ASK_KINDS, raw.kind);
  if (!kind) {
    issues.push(`ask[${i}] has invalid kind ${JSON.stringify(raw.kind)}`);
    return null;
  }
  if (typeof raw.evidence !== "string") {
    issues.push(`ask[${i}] has no evidence string`);
    return null;
  }
  let due: string | null = null;
  if (raw.due !== null && raw.due !== undefined) {
    const parsed = typeof raw.due === "string" ? canonicalDue(raw.due) : { due: null };
    due = parsed.due;
    if (parsed.note) issues.push(`ask[${i}] due ${JSON.stringify(raw.due)}: ${parsed.note}`);
    if (due === null)
      issues.push(`ask[${i}] due ${JSON.stringify(raw.due)} is not ISO 8601 — set to null`);
  }
  const object = typeof raw.object === "string" ? raw.object : "";
  return { kind, object, due, evidence: raw.evidence };
}

function parseEvent(raw: unknown, issues: string[]): FactEvent | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw) || !Array.isArray(raw.proposedTimes) || typeof raw.hasInvite !== "boolean") {
    issues.push("event is malformed — set to null");
    return null;
  }
  const proposedTimes = raw.proposedTimes.filter(isIsoDate);
  if (proposedTimes.length < raw.proposedTimes.length) {
    issues.push("event.proposedTimes had non-ISO entries — dropped");
  }
  const conflict = typeof raw.conflict === "boolean" ? raw.conflict : null;
  return { proposedTimes, hasInvite: raw.hasInvite, conflict };
}

function parseTransaction(raw: unknown, issues: string[]): FactTransaction | null {
  if (raw === null || raw === undefined) return null;
  const kind = isRecord(raw) ? oneOf(TRANSACTION_KINDS, raw.kind) : null;
  if (!isRecord(raw) || !kind || typeof raw.actionRequired !== "boolean") {
    issues.push("transaction is malformed — set to null");
    return null;
  }
  return { kind, actionRequired: raw.actionRequired };
}

function parseRisk(raw: unknown, issues: string[]): Risk[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) issues.push("risk is not an array — set to []");
    return [];
  }
  const kept = raw.map((r) => oneOf(RISKS, r)).filter((r): r is Risk => r !== null);
  if (kept.length < raw.length) issues.push("risk had unknown values — dropped");
  return [...new Set(kept)];
}

/** Validate a model answer against schema v1. Lenient per field, strict on the four enums. */
export function parseFactsV1(raw: unknown): ParsedFacts {
  const issues: string[] = [];
  if (!isRecord(raw)) return { facts: null, issues: ["answer is not a JSON object"] };

  const addressedTo = oneOf(ADDRESSED_TO, raw.addressedTo);
  const threadTurn = oneOf(THREAD_TURNS, raw.threadTurn);
  const kind = oneOf(FACT_KINDS, raw.kind);
  const ambiguous = typeof raw.ambiguous === "boolean" ? raw.ambiguous : null;
  const missing = [
    addressedTo ? null : "addressedTo",
    threadTurn ? null : "threadTurn",
    kind ? null : "kind",
    ambiguous === null ? "ambiguous" : null,
  ].filter((m): m is string => m !== null);
  if (!addressedTo || !threadTurn || !kind || ambiguous === null) {
    return { facts: null, issues: [`missing or invalid: ${missing.join(", ")}`] };
  }

  const rawAsks = Array.isArray(raw.asks) ? raw.asks : [];
  if (!Array.isArray(raw.asks)) issues.push("asks is not an array — set to []");
  const asks = rawAsks
    .map((a, i) => parseAsk(a, i, issues))
    .filter((a): a is FactAsk => a !== null);

  return {
    facts: {
      asks,
      addressedTo,
      threadTurn,
      event: parseEvent(raw.event, issues),
      transaction: parseTransaction(raw.transaction, issues),
      risk: parseRisk(raw.risk, issues),
      kind,
      ambiguous,
    },
    issues,
  };
}
