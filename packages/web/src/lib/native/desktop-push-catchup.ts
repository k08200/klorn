// Catch-up of urgent mail missed while the Windows desktop shell was closed,
// asleep or offline (decision N6, LOCKED 2026-11-08):
//   - exactly one missed mail → that mail's normal toast (N1 shape, opens it);
//   - two or more → ONE summary toast, "N urgent emails while Klorn was
//     closed", body "Sender1, Sender2, Sender3 +k", opening Today;
//   - only PUSH mail from the last 72h that is still open;
//   - during quiet hours nothing is shown or recorded: the next pass after
//     they end shows it.
//
// The bell rows say which interrupts the shell may have missed (their id is
// the id the live frame carried, so one ledger covers both paths). The server
// (GET /api/notifications/desktop-catchup, api notify/desktop-catchup.ts)
// decides which of them still deserve a toast — open PUSH lane, unread, within
// 72h — applies the same category / quiet-hours gate a live frame passes, and
// shapes each toast in the user's notification language.
//
// Pure functions over plain inputs, unit-tested without a browser
// (packages/api/src/__tests__/web-desktop-push-catchup.test.ts).

import type { DesktopCatchUpResponse, DesktopMissedMail } from "@klorn/contract";
import { type DesktopAlert, parseMailToast, TITLE_MAX, TODAY_PATH } from "./desktop-alerts";
import { type AlertLedger, recording, SETTLE_MS } from "./desktop-catchup";

/** Only mail from the last 72 hours is caught up (decision N6). */
export const PUSH_CATCHUP_WINDOW_MS = 72 * 60 * 60 * 1000;
/** Senders named in the summary body before "+k". */
export const SUMMARY_SENDERS_MAX = 3;
/** The server reads at most this many ids per question (the bell's page). */
export const ASK_MAX = 30;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COUNT_TOKEN = "{count}";

export interface PushCandidates {
  /** Unseen PUSH rows worth asking the server about. */
  ask: string[];
  /** Unseen PUSH rows that can never toast (read, stale, bad timestamp). */
  settled: string[];
}

function rowId(record: Record<string, unknown>): string | null {
  const { id } = record;
  return typeof id === "string" && ID_PATTERN.test(id) ? id : null;
}

/** A bell row that may be a missed urgent mail: an `email` row naming one
 *  mail. The server makes the final call (title, lane, open status). */
function isMailRow(record: Record<string, unknown>): boolean {
  return (
    record.type === "email" &&
    typeof record.sourceEmailId === "string" &&
    record.sourceEmailId.length > 0
  );
}

/** Sort the bell's unseen mail rows. Rows younger than SETTLE_MS are left to
 *  their live frame (neither asked nor recorded). Never throws. */
export function pushCatchUpCandidates(
  ledger: AlertLedger,
  rows: readonly unknown[],
  nowMs: number,
): PushCandidates {
  const known = new Set(ledger.notified);
  const ask: string[] = [];
  const settled: string[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const id = rowId(record);
    if (!id || known.has(id) || !isMailRow(record)) continue;
    known.add(id);
    const createdAtMs = typeof record.createdAt === "string" ? Date.parse(record.createdAt) : NaN;
    const age = nowMs - createdAtMs;
    if (Number.isFinite(age) && age < SETTLE_MS) {
      known.delete(id);
      continue;
    }
    const fresh = Number.isFinite(age) && age <= PUSH_CATCHUP_WINDOW_MS;
    if (!fresh || record.isRead === true) settled.push(id);
    // Over the cap: left for a later pass, never recorded unasked.
    else if (ask.length < ASK_MAX) ask.push(id);
  }
  return { ask, settled };
}

function parseMissedMail(value: unknown): DesktopMissedMail | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = rowId(record);
  const toast = parseMailToast(record);
  if (!id || !toast || typeof record.createdAt !== "string") return null;
  return {
    id,
    emailId: toast.open.slice("/email/".length),
    title: toast.title,
    body: toast.body,
    createdAt: record.createdAt,
  };
}

/** The server's answer, validated. Null for anything malformed. */
export function parseCatchUpResponse(raw: unknown): DesktopCatchUpResponse | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { held, summaryTitle, items } = raw as Record<string, unknown>;
  if (typeof held !== "boolean" || typeof summaryTitle !== "string" || !Array.isArray(items)) {
    return null;
  }
  if (!summaryTitle.includes(COUNT_TOKEN)) return null;
  const parsed = items.map(parseMissedMail).filter((m): m is DesktopMissedMail => m !== null);
  return { held, summaryTitle, items: parsed };
}

/** "A, B, C +2": distinct senders in order, at most `max` named. */
export function formatSenders(names: readonly string[], max = SUMMARY_SENDERS_MAX): string {
  const distinct = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
  const shown = distinct.slice(0, max).join(", ");
  const rest = distinct.length - max;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

/** One toast for what was missed: the mail itself when one, else a summary
 *  that opens Today. `items` newest first. */
export function summarizeMissed(
  items: readonly DesktopMissedMail[],
  summaryTitle: string,
): DesktopAlert | null {
  if (items.length === 0) return null;
  const [first] = items;
  if (items.length === 1) {
    return {
      id: first.id,
      kind: "push",
      title: first.title,
      body: first.body,
      open: `/email/${first.emailId}`,
    };
  }
  return {
    id: `missed:${first.id}`,
    kind: "push",
    title: summaryTitle.replace(COUNT_TOKEN, String(items.length)).slice(0, TITLE_MAX),
    body: formatSenders(items.map((i) => i.title)),
    open: TODAY_PATH,
  };
}

export interface PushCatchUpInput {
  ledger: AlertLedger;
  /** Bell rows as returned by GET /api/notifications. */
  rows: readonly unknown[];
  nowMs: number;
  /** The server's answer, or null when it was not asked (or could not
   *  answer) this pass. */
  response: DesktopCatchUpResponse | null;
  /** The ids the question named. Only these are settled by the answer: a row
   *  that became askable while the request was in flight waits for the next
   *  pass instead of being recorded unasked. */
  sent: readonly string[];
}

export interface PushCatchUpPlan {
  toast: DesktopAlert | null;
  next: AlertLedger;
}

/** Plan this pass's urgent-mail catch-up. Never establishes the baseline (the
 *  meeting pass in ./desktop-catchup.ts does, right after). Pure. */
export function planPushCatchUp({
  ledger,
  rows,
  nowMs,
  response,
  sent,
}: PushCatchUpInput): PushCatchUpPlan {
  const { ask, settled } = pushCatchUpCandidates(ledger, rows, nowMs);
  // First run: everything already in the bell is old news.
  if (!ledger.baselineEstablished) {
    return { toast: null, next: recording(ledger, [...ask, ...settled]) };
  }
  // Not asked, no answer, or quiet hours: keep the askable rows for a later
  // pass; only rows that can never toast are recorded.
  if (!response || response.held) {
    return { toast: null, next: recording(ledger, settled) };
  }
  const named = new Set(sent);
  const answered = ask.filter((id) => named.has(id));
  const asked = new Set(answered);
  const missed = response.items.filter((item) => asked.has(item.id));
  return {
    toast: summarizeMissed(missed, response.summaryTitle),
    next: recording(ledger, [...answered, ...settled]),
  };
}
