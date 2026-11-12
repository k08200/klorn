/**
 * What the morning briefing reads: mail since the previous briefing, the
 * commitments, tasks and notes around today — all from Klorn's own tables.
 *
 * Mail used to be the 30 newest INBOX messages read live from Gmail with no
 * date filter, so a quiet night re-briefed yesterday's mail, and a linked
 * inbox or a non-Gmail account was never read. Now the window starts at the
 * previous briefing (or 24 hours back when there is none, at most 7 days),
 * read from the synced mirror with the firewall's lane already joined.
 *
 * Notes and tasks used to be every note (each earlier briefing included) and
 * every task, done ones too; the prompt grew by one briefing a day. Now: open
 * tasks, and a few recent notes the user wrote, trimmed.
 */

import { prisma } from "../db.js";
import { normalizeTier } from "../judge/tiers.js";
import { wrapUntrusted } from "../untrusted.js";
import { normalizeQuoteText, type PickableMail } from "./briefing-picks.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Window when there is no previous briefing. */
export const BRIEFING_FALLBACK_WINDOW_MS = DAY_MS;
/** The window never reaches further back than this, however old the last briefing. */
const MAX_LOOKBACK_MS = 7 * DAY_MS;
/** Rows read from the window before ranking. */
const WINDOW_SCAN = 100;
/** Mails the prompt carries, highest lane first. */
export const PROMPT_MAIL_LIMIT = 25;
/** Of those, how many carry a body excerpt to quote from. */
const EXCERPT_MAILS = 8;
const EXCERPT_CHARS = 600;
/** Open PUSH mail from before the window, so it does not fall off the briefing. */
const OPEN_PUSH_CAP = 5;
/** Commitments around today: overdue up to two days, or due within a day. */
const COMMITMENT_LOOKBACK_MS = 2 * DAY_MS;
const COMMITMENT_AHEAD_MS = DAY_MS;
const COMMITMENT_LIMIT = 5;
const MIN_COMMITMENT_CONFIDENCE = 0.7;
const TASK_LIMIT = 20;
const NOTE_LIMIT = 5;
const NOTE_RECENCY_MS = 7 * DAY_MS;
const NOTE_CHARS = 400;

export interface BriefingMail {
  emailId: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: Date;
  priority: string;
  needsReply: boolean;
  /** Firewall lane (AttentionItem.tier), null when not judged yet. */
  tier: string | null;
  /** Start of the body, for mail the model may pick; "" otherwise. */
  excerpt: string;
}

/**
 * Start of the briefing's mail window: when the previous day's briefing was
 * made (today's own note, on a regenerate or a self-heal, is not "previous"),
 * else 24 hours back; never more than 7 days back.
 */
export async function briefingWindowStart(
  userId: string,
  todayKey: string,
  now: Date,
): Promise<Date> {
  const previous = await prisma.note.findFirst({
    where: {
      userId,
      dayKey: { not: null },
      NOT: { dayKey: todayKey },
      title: { startsWith: "Daily Briefing" },
      createdAt: { lt: now },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!previous) return new Date(now.getTime() - BRIEFING_FALLBACK_WINDOW_MS);
  return new Date(Math.max(previous.createdAt.getTime(), now.getTime() - MAX_LOOKBACK_MS));
}

/** Prompt order: what interrupts first, noise last. Recency breaks ties. */
function laneRank(mail: BriefingMail): number {
  if (mail.tier === null) return mail.needsReply ? 1 : 3;
  const tier = normalizeTier(mail.tier);
  if (tier === "SILENT") return 5;
  if (tier === "PUSH") return 0;
  if (tier === "MEETING" || mail.needsReply) return 1;
  if (tier === "INFO") return 4;
  return 2;
}

/** Mail the model may quote from: it interrupts, it is a meeting, or it wants a reply. */
function isPickable(mail: BriefingMail): boolean {
  return laneRank(mail) <= 1;
}

const MAIL_SELECT = {
  id: true,
  from: true,
  subject: true,
  snippet: true,
  receivedAt: true,
  priority: true,
  needsReply: true,
} as const;

async function tiersFor(userId: string, ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const items = await prisma.attentionItem.findMany({
    where: { userId, source: "EMAIL", sourceId: { in: ids } },
    select: { sourceId: true, tier: true },
  });
  return new Map(items.map((item) => [item.sourceId, item.tier]));
}

async function bodiesFor(userId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.emailMessage.findMany({
    where: { userId, id: { in: ids } },
    select: { id: true, body: true },
  });
  return new Map(
    rows.map((row) => [row.id, normalizeQuoteText(row.body ?? "").slice(0, EXCERPT_CHARS)]),
  );
}

function toBriefingMail(
  row: {
    id: string;
    from: string;
    subject: string;
    snippet: string | null;
    receivedAt: Date;
    priority: string;
    needsReply: boolean;
  },
  tier: string | null,
): BriefingMail {
  return {
    emailId: row.id,
    from: row.from,
    subject: normalizeQuoteText(row.subject),
    snippet: normalizeQuoteText(row.snippet ?? ""),
    receivedAt: row.receivedAt,
    priority: row.priority,
    needsReply: row.needsReply,
    tier,
    excerpt: "",
  };
}

async function withExcerpts(userId: string, mails: BriefingMail[]): Promise<BriefingMail[]> {
  const ids = mails
    .filter(isPickable)
    .slice(0, EXCERPT_MAILS)
    .map((m) => m.emailId);
  const bodies = await bodiesFor(userId, ids);
  return mails.map((m) => ({ ...m, excerpt: bodies.get(m.emailId) ?? "" }));
}

/**
 * Mail received in [since, now], highest lane first, capped for the prompt.
 * `newCount` counts every window mail the firewall did not file as SILENT
 * (an unjudged mail counts): zero means nothing new arrived.
 */
export async function listWindowMail(
  userId: string,
  since: Date,
  now: Date,
): Promise<{ mails: BriefingMail[]; newCount: number; scanned: number }> {
  const rows = await prisma.emailMessage.findMany({
    where: { userId, receivedAt: { gte: since, lte: now } },
    orderBy: { receivedAt: "desc" },
    take: WINDOW_SCAN,
    select: MAIL_SELECT,
  });
  const tiers = await tiersFor(
    userId,
    rows.map((r) => r.id),
  );
  const all = rows.map((row) => toBriefingMail(row, tiers.get(row.id) ?? null));
  const ranked = all
    .map((mail, index) => ({ mail, index }))
    .sort((a, b) => laneRank(a.mail) - laneRank(b.mail) || a.index - b.index)
    .map(({ mail }) => mail);
  const newCount = all.filter((m) => laneRank(m) !== 5).length;
  return {
    mails: await withExcerpts(userId, ranked.slice(0, PROMPT_MAIL_LIMIT)),
    newCount,
    scanned: rows.length,
  };
}

/**
 * Recency-cliff guard: still-OPEN PUSH mail from before the window (highest
 * priority first, capped), so it does not fall off the briefing the morning
 * after it arrived. status=OPEN: a resolved, dismissed or snoozed item never
 * comes back.
 */
export async function listOpenPushMail(
  userId: string,
  exclude: ReadonlySet<string>,
): Promise<BriefingMail[]> {
  const items = await prisma.attentionItem.findMany({
    where: { userId, source: "EMAIL", status: "OPEN", tier: "PUSH" },
    orderBy: [{ priority: "desc" }, { surfacedAt: "desc" }],
    take: OPEN_PUSH_CAP,
    select: { sourceId: true },
  });
  const ids = items.map((i) => i.sourceId).filter((id) => !exclude.has(id));
  if (ids.length === 0) return [];
  const rows = await prisma.emailMessage.findMany({
    where: { userId, id: { in: ids } },
    select: MAIL_SELECT,
  });
  return withExcerpts(
    userId,
    rows.map((row) => toBriefingMail(row, "PUSH")),
  );
}

export interface BriefingCommitment {
  title: string;
  dueText: string | null;
  dueAt: Date | null;
  owner: string;
  counterpartyName: string | null;
}

/** Open, confident commitments overdue by up to two days or due within a day. */
export async function listBriefingCommitments(
  userId: string,
  now: Date,
): Promise<BriefingCommitment[]> {
  return prisma.commitment.findMany({
    where: {
      userId,
      status: "OPEN",
      confidence: { gte: MIN_COMMITMENT_CONFIDENCE },
      dueAt: {
        gte: new Date(now.getTime() - COMMITMENT_LOOKBACK_MS),
        lt: new Date(now.getTime() + COMMITMENT_AHEAD_MS),
      },
    },
    orderBy: { dueAt: "asc" },
    take: COMMITMENT_LIMIT,
    select: { title: true, dueText: true, dueAt: true, owner: true, counterpartyName: true },
  });
}

/** Notes the user wrote recently — never a scheduled note (an earlier briefing, a weekly report). */
export async function listBriefingNotes(
  userId: string,
  now: Date,
): Promise<Array<{ title: string; content: string; updatedAt: string }>> {
  const notes = await prisma.note.findMany({
    where: { userId, dayKey: null, updatedAt: { gte: new Date(now.getTime() - NOTE_RECENCY_MS) } },
    orderBy: { updatedAt: "desc" },
    take: NOTE_LIMIT,
    select: { title: true, content: true, updatedAt: true },
  });
  return notes.map((n) => ({
    title: n.title,
    content: n.content.slice(0, NOTE_CHARS),
    updatedAt: n.updatedAt.toISOString(),
  }));
}

interface TaskLike {
  status?: unknown;
  dueDate?: unknown;
}

/** Open tasks only, capped: done tasks are not today's news. */
export function openTasks<T extends TaskLike>(tasks: readonly T[]): T[] {
  return tasks.filter((t) => t.status !== "DONE").slice(0, TASK_LIMIT);
}

/** An open task overdue or due within a day. */
export function hasTaskDueSoon(tasks: readonly TaskLike[], now: Date): boolean {
  const horizon = now.getTime() + DAY_MS;
  return tasks.some((t) => {
    if (t.status === "DONE" || typeof t.dueDate !== "string") return false;
    const due = Date.parse(t.dueDate);
    return Number.isFinite(due) && due < horizon;
  });
}

/** The rule-based signals' view of a mail: clean text, as the user would read it. */
export function signalMail(mail: BriefingMail): Record<string, unknown> {
  return {
    id: mail.emailId,
    from: mail.from,
    subject: mail.subject,
    snippet: mail.snippet,
    date: mail.receivedAt.toISOString(),
    priority: mail.priority,
    needsReply: mail.needsReply,
    tier: mail.tier ?? "",
  };
}

/** The prompt's view of a mail: every sender-written field wrapped as untrusted. */
export function promptMail(mail: BriefingMail, ref: string): Record<string, unknown> {
  return {
    ref,
    from: wrapUntrusted(mail.from, "email:from"),
    subject: wrapUntrusted(mail.subject, "email:subject"),
    snippet: wrapUntrusted(mail.snippet, "email:snippet"),
    ...(mail.excerpt ? { excerpt: wrapUntrusted(mail.excerpt, "email:body") } : {}),
    receivedAt: mail.receivedAt.toISOString(),
    lane: mail.tier ? normalizeTier(mail.tier) : "UNJUDGED",
    needsReply: mail.needsReply,
  };
}

/** The text a pick's quote must come from: exactly what the prompt showed. */
export function pickableMail(mail: BriefingMail): PickableMail {
  return {
    emailId: mail.emailId,
    text: [mail.subject, mail.snippet, mail.excerpt].filter(Boolean).join("\n"),
  };
}

/** Commitment text came from mail: the prompt carries it wrapped. */
export function promptCommitment(c: BriefingCommitment): Record<string, unknown> {
  return {
    title: wrapUntrusted(c.title, "commitment:title"),
    owner: c.owner === "COUNTERPARTY" ? "they owe the user" : "the user owes",
    ...(c.counterpartyName ? { who: wrapUntrusted(c.counterpartyName, "commitment:who") } : {}),
    due: c.dueAt ? c.dueAt.toISOString() : null,
    ...(c.dueText ? { dueText: wrapUntrusted(c.dueText, "commitment:due") } : {}),
  };
}

/** Notes can carry pasted mail: the prompt carries them wrapped. */
export function promptNote(note: { title: string; content: string; updatedAt: string }) {
  return {
    title: wrapUntrusted(note.title, "note:title"),
    content: wrapUntrusted(note.content, "note:content"),
    updatedAt: note.updatedAt,
  };
}
