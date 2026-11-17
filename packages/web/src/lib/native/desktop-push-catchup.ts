// Catch-up of urgent mail missed while the Windows desktop shell was closed,
// asleep or offline (decision N6, LOCKED 2026-11-08):
//   - exactly one missed mail → that mail's normal toast (N1 shape, opens it);
//   - two or more → ONE summary toast, "N urgent emails while Klorn was
//     closed", body "Sender1, Sender2, Sender3 +k", opening Today;
//   - only PUSH mail from the last 72h that is still open;
//   - during quiet hours nothing is shown or recorded: the next pass after
//     they end shows it.
// The same holds for mail whose live frame came untagged during quiet hours
// while Klorn was running (./desktop-catchup.ts planLiveAlert keeps its row
// unrecorded, `held`): one toast, or ONE summary titled "N urgent emails
// during quiet hours" when every mail in it waited live — "while Klorn was
// closed" as soon as one of them arrived while it was not running, as the
// Mac's HeldBanners does.
//
// A Slack PUSH whose live frame came untagged during quiet hours is held the
// same way and joins this catch-up: the server answers it under the same gate
// (unread, last 72h, not answered in Slack since) with the row's own text, the
// live Slack push's; one toast for one, and a summary that holds one is
// titled "N urgent messages …". Only held Slack rows are asked about: one that
// rang live, or that the budget held back, never toasts late.
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

import type {
  DesktopCatchUpResponse,
  DesktopMissedMail,
  DesktopMissedSlack,
} from "@klorn/contract";
import {
  BODY_MAX,
  type DesktopAlert,
  MESSAGE_SCAN_MAX,
  mailLedgerKey,
  parseMailToast,
  TITLE_MAX,
  TODAY_PATH,
} from "./desktop-alerts";
import { type AlertLedger, recording, SETTLE_MS, SLACK_ROW_TYPE } from "./desktop-catchup";

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

/** A Slack PUSH row whose live frame the shell held (quiet hours). */
function isHeldSlackRow(record: Record<string, unknown>, id: string, held: ReadonlySet<string>) {
  return record.type === SLACK_ROW_TYPE && held.has(id);
}

/** Sort the bell's unseen mail rows and held Slack rows. Rows younger than
 *  SETTLE_MS are left to their live frame (neither asked nor recorded). Never
 *  throws. */
export function pushCatchUpCandidates(
  ledger: AlertLedger,
  rows: readonly unknown[],
  nowMs: number,
): PushCandidates {
  const known = new Set(ledger.notified);
  const held = new Set(ledger.held ?? []);
  const ask: string[] = [];
  const settled: string[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const id = rowId(record);
    if (!id || known.has(id)) continue;
    const mailRow = isMailRow(record);
    if (!mailRow && !isHeldSlackRow(record, id, held)) continue;
    known.add(id);
    // Another row for a mail already toasted: never again (one mail, one toast).
    if (mailRow && known.has(mailLedgerKey(record.sourceEmailId as string))) {
      settled.push(id);
      continue;
    }
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

/** A held Slack row's toast, capped as a live toast is. Null when malformed. */
function parseMissedSlack(value: unknown): DesktopMissedSlack | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = rowId(record);
  const { title, body, createdAt } = record;
  if (!id || typeof title !== "string" || typeof body !== "string") return null;
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) return null;
  const cleanTitle = title.trim();
  if (!cleanTitle) return null;
  return {
    id,
    title: cleanTitle.slice(0, TITLE_MAX),
    body: body.slice(0, MESSAGE_SCAN_MAX).trim().slice(0, BODY_MAX),
    createdAt,
  };
}

/** The optional summary titles that are well formed (a server before them sends none). */
function optionalTitles(record: Record<string, unknown>) {
  const titles: Partial<
    Pick<
      DesktopCatchUpResponse,
      "heldSummaryTitle" | "messagesSummaryTitle" | "heldMessagesSummaryTitle"
    >
  > = {};
  for (const key of [
    "heldSummaryTitle",
    "messagesSummaryTitle",
    "heldMessagesSummaryTitle",
  ] as const) {
    const value = record[key];
    if (typeof value === "string" && value.includes(COUNT_TOKEN)) titles[key] = value;
  }
  return titles;
}

/** The server's answer, validated. Null for anything malformed. */
export function parseCatchUpResponse(raw: unknown): DesktopCatchUpResponse | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const { held, summaryTitle, items, slack } = record;
  if (typeof held !== "boolean" || typeof summaryTitle !== "string" || !Array.isArray(items)) {
    return null;
  }
  if (!summaryTitle.includes(COUNT_TOKEN)) return null;
  const parsed = items.map(parseMissedMail).filter((m): m is DesktopMissedMail => m !== null);
  const slackItems = (Array.isArray(slack) ? slack : [])
    .map(parseMissedSlack)
    .filter((m): m is DesktopMissedSlack => m !== null);
  // Optional titles: a malformed or missing one costs only its wording.
  return { held, summaryTitle, ...optionalTitles(record), items: parsed, slack: slackItems };
}

/** "A, B, C +2": distinct senders in order, at most `max` named. */
export function formatSenders(names: readonly string[], max = SUMMARY_SENDERS_MAX): string {
  const distinct = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
  const shown = distinct.slice(0, max).join(", ");
  const rest = distinct.length - max;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

/** A missed mail, or a Slack message held during quiet hours. */
export type MissedItem = DesktopMissedMail | DesktopMissedSlack;

/** One toast for what was missed: the mail itself (opening it) or the Slack
 *  message (as its live toast, opening nothing) when one, else a summary that
 *  opens Today. `items` newest first. */
export function summarizeMissed(
  items: readonly MissedItem[],
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
      open: "emailId" in first ? `/email/${first.emailId}` : null,
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
  const held = new Set(ledger.held ?? []);
  // First run: everything already in the bell is old news — except mail whose
  // live frame this launch already held (it arrived while running).
  if (!ledger.baselineEstablished) {
    const old = [...ask, ...settled].filter((id) => !held.has(id));
    return { toast: null, next: recording(ledger, old) };
  }
  // Not asked, no answer, or quiet hours: keep the askable rows for a later
  // pass; only rows that can never toast are recorded.
  if (!response || response.held) {
    return { toast: null, next: recording(ledger, settled) };
  }
  const named = new Set(sent);
  const answered = ask.filter((id) => named.has(id));
  const asked = new Set(answered);
  const mail = distinctMail(response.items.filter((item) => asked.has(item.id)));
  const slack = (response.slack ?? []).filter((item) => asked.has(item.id));
  const missed = slack.length > 0 ? newestFirst([...mail, ...slack]) : mail;
  return {
    toast: summarizeMissed(missed, summaryTitleFor(response, missed, held, slack.length > 0)),
    next: recording(ledger, [
      ...answered,
      ...settled,
      ...mail.map((item) => mailLedgerKey(item.emailId)),
    ]),
  };
}

/** Every item waited live → "during quiet hours"; any mail missed while
 *  closed → "while Klorn was closed" (the Mac's SummaryKind rule). A hold
 *  from a gate lookup error (rare) also reads as quiet hours. With a Slack
 *  message among them, the "urgent messages" wording of the same pick. */
function summaryTitleFor(
  response: DesktopCatchUpResponse,
  missed: readonly MissedItem[],
  held: ReadonlySet<string>,
  withSlack: boolean,
): string {
  const allHeldLive = missed.every((item) => held.has(item.id));
  const quiet = withSlack ? response.heldMessagesSummaryTitle : response.heldSummaryTitle;
  const closed = withSlack ? response.messagesSummaryTitle : undefined;
  if (allHeldLive && quiet) return quiet;
  return closed ?? response.summaryTitle;
}

/** Newest first, by the row's time; ties keep their order. */
function newestFirst(items: readonly MissedItem[]): MissedItem[] {
  return [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** One entry per mail, the first (newest) row kept: two rows for one mail are
 *  one missed mail, not two. */
function distinctMail(items: readonly DesktopMissedMail[]): DesktopMissedMail[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.emailId)) return false;
    seen.add(item.emailId);
    return true;
  });
}
