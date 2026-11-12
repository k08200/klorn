/**
 * Daily Briefing - Klorn's autonomous planning feature
 *
 * Aggregates tasks, calendar events, commitments and the mail received since
 * the previous briefing into a daily summary. Can be triggered manually or
 * via cron.
 */

import type { FastifyInstance } from "fastify";
import { getUserId } from "../auth.js";
import { prisma } from "../db.js";
import { recordFeedback } from "../learning/feedback.js";
import { getUserLlmCredentials } from "../llm/llm-credentials.js";
import { parseLlmJson } from "../llm/llm-json.js";
import { createCompletion, MODEL } from "../llm/openai.js";
import { senderName } from "../notify/notification-format.js";
import {
  getUserNotificationLanguage,
  type NotificationLanguage,
  resolveNotificationLanguage,
} from "../notify/notification-strings.js";
import { sendPushNotification } from "../notify/push.js";
import { localDayUtcRange, normalizeTimeZone } from "../time-zone.js";
import { stripUntrusted } from "../untrusted.js";
import { pushNotification } from "../websocket.js";
import { type BriefingCopy, briefingCopy, isQuietBriefing } from "./briefing-copy.js";
import {
  BRIEFING_ANSWER_SCHEMA,
  type BriefingPick,
  type PickableMail,
  parseBriefingAnswer,
  readStoredPicks,
  renderBriefingAnswer,
} from "./briefing-picks.js";
import { BRIEFING_SYSTEM_PROMPT, buildBriefingUserPrompt } from "./briefing-prompt.js";
import { wrapEventsForPrompt, wrapSignalsForPrompt } from "./briefing-prompt-wrap.js";
import { type BriefingSignals, buildBriefingSignals } from "./briefing-signals.js";
import { getBriefingStatus } from "./briefing-status.js";
import {
  type BriefingCommitment,
  type BriefingMail,
  briefingWindowStart,
  hasTaskDueSoon,
  listBriefingCommitments,
  listBriefingNotes,
  listOpenPushMail,
  listWindowMail,
  openTasks,
  PROMPT_MAIL_LIMIT,
  pickableMail,
  promptCommitment,
  promptMail,
  promptNote,
  signalMail,
} from "./briefing-window.js";
import { readCalendarRows } from "./calendar-read.js";
import { listTasks } from "./tasks.js";

export { BRIEFING_SYSTEM_PROMPT } from "./briefing-prompt.js";

const BRIEFING_CALENDAR_WINDOW_DAYS = 14;
/** Events the rule-based briefing reads; the cap applies after the dedupe. */
const BRIEFING_EVENT_LIMIT = 20;
/** Calendar description characters the prompt carries per event (invites embed whole agendas). */
const EVENT_DESCRIPTION_CHARS = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Still-open mail the quiet card lists. */
const QUIET_OPEN_LIMIT = 3;

type BriefingFeedbackChoice = "useful" | "wrong" | "later" | "done";

const BRIEFING_TOP_ACTION_TOOL = "briefing_top_action";
const BRIEFING_FEEDBACK_CHOICES = new Set<BriefingFeedbackChoice>([
  "useful",
  "wrong",
  "later",
  "done",
]);
const BRIEFING_SIGNAL_BY_CHOICE = {
  useful: "APPROVED",
  wrong: "REJECTED",
  later: "SNOOZED",
  done: "DISMISSED",
} as const;
const BRIEFING_CHOICE_BY_SIGNAL = {
  APPROVED: "useful",
  REJECTED: "wrong",
  SNOOZED: "later",
  DISMISSED: "done",
} as const;

/**
 * Read upcoming events from the local calendar table that the Calendar page
 * and the Status readiness check already consume. Previously the briefing
 * pulled events directly from the Google API, which surfaced auto-imported
 * birthdays and other side calendars that the Calendar page never showed —
 * so the briefing claimed eight birthday events while Calendar said "0
 * events in the next 14 days." Sharing the same source removes that lie.
 */
export async function listLocalBriefingEvents(
  userId: string,
  now: Date,
): Promise<{ events: unknown[] }> {
  const windowEnd = new Date(now.getTime() + BRIEFING_CALENDAR_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // Through the one read path: the scope, and an invite in the primary and a
  // linked calendar (two rows, C2) shown once, with the cap applied after that.
  const rows = await readCalendarRows({
    userId,
    when: { startTime: { gte: now, lte: windowEnd } },
    limit: BRIEFING_EVENT_LIMIT,
  });

  // Defense in depth: an older version of calendar sync wrote
  // <untrusted_content> wrappers into CalendarEvent.title / .description /
  // .location. Newer syncs write raw text, but stale prod rows still leak the
  // wrapper into the rule-based briefing — the user sees raw XML-looking tags
  // and the "shared terms" detector treats "untrusted", "content", "source"
  // as meaningful tokens. Strip on the read side so fallback briefings stay
  // clean even before a one-shot DB cleanup runs.
  //
  // Same row collapsed to a single signal: Google's birthday calendar emits
  // one event per upcoming birthday occurrence, all sharing the same title.
  // The fallback briefing previously listed each one as a separate deadline.
  // Dedup by (clean title, day) so a repeating event takes one line.
  const seenKeys = new Set<string>();
  const events: unknown[] = [];
  for (const row of rows) {
    const summary = stripUntrusted(row.title);
    const description = stripUntrusted(row.description);
    const location = stripUntrusted(row.location);
    const startIso = row.startTime.toISOString();
    const dedupKey = `${summary.trim().toLowerCase()}|${startIso.slice(0, 10)}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);
    events.push({
      id: row.id,
      summary,
      description,
      location,
      start: startIso,
      end: row.endTime.toISOString(),
    });
  }
  return { events };
}

interface BriefingData {
  tasks: { tasks: unknown[] };
  events: { events: unknown[] };
  /** Window mail plus still-open PUSH mail, in the shape the rule-based signals read. */
  emails: { emails: Array<Record<string, unknown>> };
  notes: { notes: Array<{ title: string; content: string; updatedAt: string }> };
  commitments: BriefingCommitment[];
  windowMail: BriefingMail[];
  openPush: BriefingMail[];
  /** Window mail the firewall did not file as SILENT. */
  newMailCount: number;
  /** Window mail beyond the prompt's cap. */
  omittedMail: number;
  since: Date;
  /** False when any source failed to read: unknown is not "nothing new". */
  complete: boolean;
  signals: BriefingSignals;
}

/** A best-effort read: a failure logs, marks the gather incomplete, and yields `empty`. */
async function readSource<T>(
  userId: string,
  label: string,
  read: () => Promise<T>,
  empty: T,
  failures: string[],
): Promise<T> {
  try {
    return await read();
  } catch (err) {
    failures.push(label);
    console.warn(
      `[BRIEFING] ${label} read failed for ${userId}:`,
      err instanceof Error ? err.message : err,
    );
    return empty;
  }
}

async function gatherBriefingData(
  userId: string,
  todayKey: string,
  now: Date = new Date(),
): Promise<BriefingData> {
  const failures: string[] = [];
  const since = await readSource(
    userId,
    "window start",
    () => briefingWindowStart(userId, todayKey, now),
    new Date(now.getTime() - DAY_MS),
    failures,
  );
  const [tasks, events, window, commitments, notes] = await Promise.all([
    readSource(userId, "tasks", () => listTasks(userId), { tasks: [] as unknown[] }, failures),
    readSource(
      userId,
      "events",
      () => listLocalBriefingEvents(userId, now),
      { events: [] },
      failures,
    ),
    readSource(
      userId,
      "mail",
      () => listWindowMail(userId, since, now),
      { mails: [], newCount: 0, scanned: 0 },
      failures,
    ),
    readSource(userId, "commitments", () => listBriefingCommitments(userId, now), [], failures),
    readSource(userId, "notes", () => listBriefingNotes(userId, now), [], failures),
  ]);
  const openPush = await readSource(
    userId,
    "open PUSH",
    () => listOpenPushMail(userId, new Set(window.mails.map((m) => m.emailId))),
    [],
    failures,
  );

  const data = {
    tasks: { tasks: openTasks((tasks.tasks ?? []) as Array<Record<string, unknown>>) },
    events,
    emails: { emails: [...window.mails, ...openPush].map(signalMail) },
  };
  return {
    ...data,
    notes: { notes },
    commitments,
    windowMail: window.mails,
    openPush,
    newMailCount: window.newCount,
    omittedMail: Math.max(0, window.scanned - Math.min(window.scanned, PROMPT_MAIL_LIMIT)),
    since,
    complete: failures.length === 0,
    signals: buildBriefingSignals(data, { now }),
  };
}

/**
 * A quiet morning: every source read, no new non-SILENT mail since the last
 * briefing, and nothing scheduled, committed or due in the next day. The
 * briefing then skips the model and delivers the quiet card instead.
 */
export function isQuietMorning(data: BriefingData, now: Date): boolean {
  if (!data.complete || data.newMailCount > 0 || data.commitments.length > 0) return false;
  if (hasTaskDueSoon(data.tasks.tasks as Array<Record<string, unknown>>, now)) return false;
  const horizon = now.getTime() + DAY_MS;
  return !data.events.events.some((event) => {
    const start = (event as { start?: unknown }).start;
    return typeof start === "string" && Date.parse(start) < horizon;
  });
}

/** The quiet card: deterministic, no model call. Lists PUSH mail still open from before. */
export function buildQuietBriefing(
  openPush: readonly BriefingMail[],
  lang: NotificationLanguage,
): string {
  const copy = briefingCopy(lang);
  const lines = [copy.quietHeadline];
  const open = openPush.slice(0, QUIET_OPEN_LIMIT);
  if (open.length > 0) {
    lines.push("", `**${copy.stillOpen}**`);
    for (const mail of open) {
      lines.push(`- ${senderName(mail.from, lang)} — ${stripUntrusted(mail.subject)}`);
    }
  }
  return lines.join("\n");
}

function briefingTopActionSourceId(noteId: string, rank: number): string {
  return `briefing:${noteId}:top:${rank}`;
}

function parseRank(value: string | undefined): number | null {
  if (!value) return null;
  const rank = Number.parseInt(value, 10);
  return Number.isInteger(rank) && rank >= 1 && rank <= 3 ? rank : null;
}

function findUserBriefingNote(userId: string, noteId: string) {
  return prisma.note.findFirst({
    where: {
      id: noteId,
      userId,
      title: { startsWith: "Daily Briefing" },
    },
    select: { id: true, createdAt: true },
  });
}

/**
 * Outcome of the briefing's LLM path, surfaced by POST /generate so "AI
 * summary unavailable" is diagnosable in prod (which branch fired, and why).
 * Threaded through return values — request-scoped, never shared module state
 * (a singleton here leaks one user's diagnostic metadata to another).
 * "skipped": a quiet morning, delivered without a model call.
 */
export interface BriefingLlmOutcome {
  source: "ai" | "fallback" | "cache" | "skipped";
  reason: string | null;
  model: string;
}

export interface GeneratedBriefing {
  content: string;
  llm: BriefingLlmOutcome;
  /** Verified picks (empty for the quiet card and for every fallback). */
  picks: BriefingPick[];
  /** A quiet card: saved, but announced without a device push. */
  quiet: boolean;
}

interface UserBriefingContext {
  timeZone: string;
  lang: NotificationLanguage;
  todayKey: string;
}

async function userBriefingContext(userId: string, now: Date): Promise<UserBriefingContext> {
  const config = await prisma.automationConfig.findUnique({
    where: { userId },
    select: { timezone: true, notificationLanguage: true },
  });
  const timeZone = normalizeTimeZone(config?.timezone);
  return {
    timeZone,
    // The briefing follows the user's notification language (fixed per
    // setting — unlike replies, which mirror the mail's language).
    lang: resolveNotificationLanguage(config?.notificationLanguage),
    todayKey: localDayUtcRange(now, timeZone).dateKey,
  };
}

function localDateLine(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone,
  }).format(now);
}

/** Calendar text in the prompt: wrapped (briefing-prompt-wrap.ts) and descriptions trimmed. */
function promptEvents(events: { events: unknown[] }): unknown {
  return wrapEventsForPrompt({
    events: events.events.map((event) => {
      const e = event as { description?: unknown };
      return typeof e.description === "string"
        ? { ...(event as object), description: e.description.slice(0, EVENT_DESCRIPTION_CHARS) }
        : event;
    }),
  });
}

function buildPrompt(data: BriefingData, ctx: UserBriefingContext, now: Date) {
  const refs = new Map<string, PickableMail>();
  const refFor = (mail: BriefingMail) => {
    const ref = `m${refs.size + 1}`;
    refs.set(ref, pickableMail(mail));
    return promptMail(mail, ref);
  };
  // Calendar and mail text is external content: the prompt's copy carries it
  // wrapped; the rule-based view (`data.signals`, the fallback) keeps clean text.
  const prompt = buildBriefingUserPrompt({
    today: localDateLine(now, ctx.timeZone),
    languageLine: briefingCopy(ctx.lang).languageLine,
    since: data.since.toISOString(),
    signals: wrapSignalsForPrompt(data.signals),
    tasks: data.tasks,
    events: promptEvents(data.events),
    commitments: data.commitments.map(promptCommitment),
    emails: data.windowMail.map(refFor),
    openFromBefore: data.openPush.map(refFor),
    notes: data.notes.notes.map(promptNote),
    omittedMail: data.omittedMail,
  });
  return { prompt, refs };
}

/** The model's answer as briefing text: the checked JSON, else legacy prose, else null. */
function readModelAnswer(
  raw: string,
  refs: ReadonlyMap<string, PickableMail>,
  copy: BriefingCopy,
): { content: string; picks: BriefingPick[] } | null {
  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch {
    // A provider that ignored response_format and wrote prose: keep it (clean).
    return raw.trimStart().startsWith("{") ? null : { content: stripUntrusted(raw), picks: [] };
  }
  const answer = parseBriefingAnswer(parsed, refs);
  return answer ? { content: renderBriefingAnswer(answer, copy), picks: answer.picks } : null;
}

export default async function generateBriefing(
  userId: string,
  now: Date = new Date(),
): Promise<GeneratedBriefing> {
  const ctx = await userBriefingContext(userId, now);
  const data = await gatherBriefingData(userId, ctx.todayKey, now);
  const copy = briefingCopy(ctx.lang);

  if (isQuietMorning(data, now)) {
    return {
      content: buildQuietBriefing(data.openPush, ctx.lang),
      llm: { source: "skipped", reason: "nothing new, nothing scheduled or due", model: "" },
      picks: [],
      quiet: true,
    };
  }

  const fallback = (reason: string): GeneratedBriefing => ({
    content: buildSignalOnlyBriefing(data.signals),
    llm: { source: "fallback", reason, model: MODEL },
    picks: [],
    quiet: false,
  });
  const { prompt, refs } = buildPrompt(data, ctx, now);
  const credentials = await getUserLlmCredentials(userId);
  try {
    const response = await createCompletion(
      {
        model: MODEL,
        response_format: {
          type: "json_schema",
          json_schema: { name: "briefing", schema: BRIEFING_ANSWER_SCHEMA },
        },
        messages: [
          { role: "system", content: BRIEFING_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      },
      { credentials, userId, priority: "background" },
    );

    const raw = response.choices[0]?.message?.content?.trim();
    const answer = raw ? readModelAnswer(raw, refs, copy) : null;
    if (answer) {
      return { ...answer, llm: { source: "ai", reason: null, model: MODEL }, quiet: false };
    }
    const finish = response.choices[0]?.finish_reason ?? "none";
    console.warn(`[BRIEFING] LLM answer unusable for ${userId} — falling back to rule-based view`);
    return fallback(raw ? "unusable answer" : `empty content (finish_reason=${finish})`);
  } catch (err) {
    // LLM provider exhausted, rate-limited, or otherwise unreachable.
    // Fall back to the deterministic signal summary so the user still
    // gets a useful briefing instead of an error or empty screen.
    // Log the reason — without it, "AI summary unavailable" is invisible
    // in prod and the user has no idea whether the issue is credentials,
    // the cost cap, or a transient provider outage.
    console.warn(
      `[BRIEFING] LLM call failed for ${userId} — falling back to rule-based view:`,
      err instanceof Error ? err.message : err,
    );
    return fallback(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
}

/**
 * Render BriefingSignals (already rule-based — see briefing-signals.ts) as a
 * human-readable briefing without any LLM call. Used when every provider is
 * locked out so the briefing page never goes blank.
 */
export const FALLBACK_BRIEFING_SENTINEL = "**Briefing (AI summary unavailable — rule-based view)**";

export function buildSignalOnlyBriefing(signals: BriefingSignals): string {
  const lines: string[] = [FALLBACK_BRIEFING_SENTINEL, ""];

  const topActions = signals.topActions.slice(0, 3);
  if (topActions.length > 0) {
    lines.push("**Top 3 Today**");
    topActions.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.action} — ${a.reason}`);
    });
    lines.push("");
  }

  if (signals.deadlines.length > 0) {
    lines.push("**Deadlines**");
    const seen = new Set<string>();
    let printed = 0;
    for (const d of signals.deadlines) {
      const key = `${d.source}:${d.title.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const due = d.dueText || d.dueAt || "soon";
      lines.push(`- ${d.title} (${due}) — ${d.reason}`);
      printed += 1;
      if (printed === 5) break;
    }
    lines.push("");
  }

  if (signals.urgentItems.length > 0) {
    lines.push("**Urgent**");
    const seen = new Set<string>();
    let printed = 0;
    for (const u of signals.urgentItems) {
      const key = `${u.source}:${u.title.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${u.title} — ${u.reason}`);
      printed += 1;
      if (printed === 5) break;
    }
    lines.push("");
  }

  if (signals.crossLinks.length > 0) {
    lines.push("**Connected items**");
    for (const link of signals.crossLinks.slice(0, 3)) {
      lines.push(`- ${link.reason}`);
    }
    lines.push("");
  }

  if (
    topActions.length === 0 &&
    signals.deadlines.length === 0 &&
    signals.urgentItems.length === 0
  ) {
    lines.push("Nothing urgent surfaced from today's data. Use the open block to plan ahead.");
  }

  return lines.join("\n").trim();
}

/// One heal attempt per user per window — a fallback note otherwise retries
/// the LLM on EVERY sidebar read. In-process is fine on a single instance;
/// worst case after a restart is one extra attempt.
const HEAL_COOLDOWN_MS = 10 * 60 * 1000;
const healAttemptAt = new Map<string, number>();

/** Test seam: cooldown state is module-held. */
export function __resetBriefingHealCooldownForTests(): void {
  healAttemptAt.clear();
}

/** Picks as a JSON column value (Note.picks); undefined leaves the column unset. */
function picksColumn(picks: readonly BriefingPick[]) {
  if (picks.length === 0) return undefined;
  return picks.map((p) => ({
    rank: p.rank,
    emailId: p.emailId,
    action: p.action,
    reason: p.reason,
    quote: p.quote,
    openedAt: p.openedAt ?? null,
  }));
}

/**
 * If the cached note is the rule-based fallback, try ONE fresh generation.
 * Returns the healed content (note rewritten in place) or null when the note
 * is healthy, the cooldown is active, or the LLM is still failing.
 */
async function healFallbackBriefing(
  userId: string,
  note: { id: string; content: string },
): Promise<{ content: string; llm: BriefingLlmOutcome } | null> {
  if (!note.content.startsWith(FALLBACK_BRIEFING_SENTINEL)) return null;
  const last = healAttemptAt.get(userId) ?? 0;
  if (Date.now() - last < HEAL_COOLDOWN_MS) return null;
  healAttemptAt.set(userId, Date.now());
  try {
    const { content, llm, picks } = await generateBriefing(userId);
    // generateBriefing already degraded internally — still no AI. Keep the
    // cached fallback rather than rewriting it with an identical one.
    if (llm.source !== "ai") return null;
    await prisma.note.update({
      where: { id: note.id },
      data: { content, picks: picksColumn(picks) },
    });
    return { content, llm };
  } catch (err) {
    console.warn(`[BRIEFING] fallback self-heal failed for ${userId}:`, err);
    return null;
  }
}

/**
 * Deliver today's briefing at most once per user per local day.
 *
 * The dedup is ATOMIC: a `(userId, dayKey)` unique on Note plus a
 * create-catch-P2002 recovery closes the check-then-create (TOCTOU) race. Four
 * callers can fire concurrently — the scheduler, the agent tool-executor, cron,
 * and post-login auth — but only the create winner generates + pushes; every
 * other caller reuses the winner's note and gets `notification: null` (no push).
 */
export async function createDailyBriefingDelivery(userId: string): Promise<{
  briefing: string;
  note: { id: string; createdAt: Date };
  notification: { id: string; createdAt: Date } | null;
  reused: boolean;
  /** LLM outcome for THIS caller's generation; "cache" when a note was reused. */
  llm: BriefingLlmOutcome;
}> {
  const dayKey = await briefingDayKeyForUser(userId);
  const cacheLlm: BriefingLlmOutcome = {
    source: "cache",
    reason: "reused today's existing note",
    model: "",
  };

  const existing = await prisma.note.findUnique({
    where: { userId_dayKey: { userId, dayKey } },
    select: { id: true, content: true, createdAt: true },
  });
  if (existing) {
    // Self-heal: a transient LLM failure at generation time persisted the
    // rule-based fallback as the DAY'S note, so every later read served
    // "AI summary unavailable" all day even after the provider recovered
    // (founder screenshots 2026-08-19/20). One retry per cooldown window;
    // failure keeps the fallback — the page never goes blank.
    const healed = await healFallbackBriefing(userId, existing);
    const content = healed?.content ?? existing.content;
    const notification = await ensureDailyBriefingNotification(userId, content, dayKey, {
      quiet: isQuietBriefing(content),
    });
    return {
      briefing: content,
      note: { id: existing.id, createdAt: existing.createdAt },
      notification,
      reused: true,
      llm: healed?.llm ?? cacheLlm,
    };
  }

  const { content: briefing, llm, picks, quiet } = await generateBriefing(userId);

  let note: { id: string; createdAt: Date };
  try {
    note = await prisma.note.create({
      data: {
        userId,
        dayKey,
        title: `Daily Briefing — ${new Date().toLocaleDateString("en-US")}`,
        content: briefing,
        picks: picksColumn(picks),
      },
      select: { id: true, createdAt: true },
    });
  } catch (err) {
    // A concurrent caller won the (userId, dayKey) race between our findUnique
    // miss and this create. Recover by reading the winner's note and reusing it
    // — matches the WebhookEvent P2002-dedup idiom (routes/webhook.ts).
    if ((err as { code?: string })?.code !== "P2002") throw err;
    const winner = await prisma.note.findUnique({
      where: { userId_dayKey: { userId, dayKey } },
      select: { id: true, content: true, createdAt: true },
    });
    if (!winner) throw err; // P2002 but no row — genuinely unexpected, surface it
    const notification = await ensureDailyBriefingNotification(userId, winner.content, dayKey, {
      quiet: isQuietBriefing(winner.content),
    });
    return {
      briefing: winner.content,
      note: { id: winner.id, createdAt: winner.createdAt },
      notification,
      reused: true,
      llm: cacheLlm,
    };
  }

  const notification = await ensureDailyBriefingNotification(userId, briefing, dayKey, { quiet });

  return { briefing, note, notification, reused: false, llm };
}

/**
 * Create the briefing notification and push it — WINNER-ONLY and atomic.
 *
 * A `(userId, dedupeKey)` unique on Notification (dedupeKey = "briefing:<dayKey>")
 * means exactly one caller's create succeeds. The winner does both pushes and
 * returns the notification; a concurrent loser gets P2002 → returns null WITHOUT
 * pushing, so the user can never receive a duplicate briefing web-push. Matches
 * the WebhookEvent P2002-dedup idiom (routes/webhook.ts).
 *
 * A quiet card (nothing new, nothing scheduled or due) still gets its bell
 * row — it is the day's dedupe record, so no later caller pushes the day —
 * but already read, and without a live or device push: an interruption that
 * says "nothing" teaches the user to ignore the next one. The title follows
 * the user's notification language.
 */
export async function ensureDailyBriefingNotification(
  userId: string,
  briefing: string,
  dayKey: string,
  options: { quiet?: boolean } = {},
): Promise<{ id: string; createdAt: Date } | null> {
  // Strip first (a note saved before the strip existed may carry tags), then cut.
  const clean = stripUntrusted(briefing);
  const briefingMsg = clean.slice(0, 200) + (clean.length > 200 ? "..." : "");
  const dedupeKey = `briefing:${dayKey}`;
  const title = briefingCopy(await getUserNotificationLanguage(userId)).pushTitle;
  const quiet = options.quiet === true;

  let notification: { id: string; createdAt: Date };
  try {
    notification = await prisma.notification.create({
      data: {
        userId,
        type: "briefing",
        dedupeKey,
        title,
        message: briefingMsg,
        link: "/briefing",
        ...(quiet ? { isRead: true } : {}),
      },
      select: { id: true, createdAt: true },
    });
  } catch (err) {
    // Someone already created + pushed this briefing for the day. Do NOT push
    // again — this is exactly the duplicate-push hole being closed.
    if ((err as { code?: string })?.code === "P2002") return null;
    throw err;
  }
  if (quiet) return notification;

  pushNotification(userId, {
    id: notification.id,
    type: "briefing",
    title,
    message: briefingMsg,
    createdAt: notification.createdAt.toISOString(),
  });

  await sendPushNotification(
    userId,
    {
      title,
      body: briefingMsg,
      url: "/briefing",
      notificationId: notification.id,
    },
    "daily_briefing",
  );

  return notification;
}

const briefingFeedbackSummaryQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    days: { type: "string", maxLength: 500 },
  },
} as const;

export function briefingRoutes(app: FastifyInstance) {
  // GET /api/briefing/feedback/summary — dogfood trust metric for Top 3 quality
  app.get(
    "/feedback/summary",
    { schema: { querystring: briefingFeedbackSummaryQuerySchema } },
    async (request) => {
      const userId = getUserId(request);
      const { days } = request.query as { days?: string };
      const parsedDays = days ? Number.parseInt(days, 10) : 7;
      const windowDays = Number.isFinite(parsedDays) ? Math.min(Math.max(parsedDays, 1), 90) : 7;
      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

      const rows = await prisma.feedbackEvent.groupBy({
        by: ["signal"],
        where: {
          userId,
          source: "ATTENTION_ITEM",
          toolName: BRIEFING_TOP_ACTION_TOOL,
          createdAt: { gte: since },
        },
        _count: { signal: true },
      });

      const counts = { useful: 0, wrong: 0, later: 0, done: 0 };
      for (const row of rows) {
        const choice =
          BRIEFING_CHOICE_BY_SIGNAL[row.signal as keyof typeof BRIEFING_CHOICE_BY_SIGNAL];
        if (choice) counts[choice] = row._count.signal;
      }
      const total = counts.useful + counts.wrong + counts.later + counts.done;

      return {
        since: since.toISOString(),
        days: windowDays,
        total,
        counts,
        usefulRate: total > 0 ? counts.useful / total : null,
      };
    },
  );

  // POST /api/briefing/generate — Generate daily briefing
  app.post(
    "/generate",
    {
      schema: {
        body: {
          type: ["object", "null"],
          properties: { force: { type: "boolean" } },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const userId = getUserId(request);
      // `force` regenerates from scratch: today's briefing is deduped to one
      // note per local day, so without this a user who wants a fresh briefing
      // (after new mail, or when the first run fell back) always gets the
      // cached one. Deleting the day's note lets createDailyBriefingDelivery
      // re-run. Deliberately does NOT reset the day's Notification dedupe: the
      // caller is interacting live and receives the fresh content in this
      // response — a second OS push for the same day would double-notify.
      const { force } = (request.body as { force?: boolean } | null) ?? {};
      if (force) {
        const dayKey = await briefingDayKeyForUser(userId);
        await prisma.note.deleteMany({ where: { userId, dayKey } });
      }
      const { briefing, note, notification, reused, llm } =
        await createDailyBriefingDelivery(userId);
      // llm is THIS request's outcome (request-scoped, threaded through return
      // values) so a rule-based fallback is diagnosable in prod. On a reuse
      // race after force-delete it reads "cache" — honest about what happened.
      return { briefing, note, notification, reused, llm };
    },
  );

  // GET /api/briefing/data — Get raw briefing data
  app.get("/data", async (request) => {
    const userId = getUserId(request);
    const dayKey = await briefingDayKeyForUser(userId);
    const { windowMail, openPush, ...data } = await gatherBriefingData(userId, dayKey);
    return { ...data, windowMailCount: windowMail.length, openPushCount: openPush.length };
  });

  // GET /api/briefing/today — Latest briefing stored today (or null)
  app.get("/today", async (request) => {
    const userId = getUserId(request);
    const today = await todayRangeForUser(userId);

    const row = await prisma.note.findFirst({
      where: {
        userId,
        title: { startsWith: "Daily Briefing" },
        createdAt: today,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, content: true, createdAt: true, picks: true },
    });
    const note = row && { ...row, picks: readStoredPicks(row.picks) };

    // The glanceable v2 layer (verdict + segments + curve + attention).
    // Deterministic at read time; fail-open null keeps old clients working.
    let structured = null;
    try {
      const { buildBriefingStructure } = await import("./briefing-structure.js");
      structured = await buildBriefingStructure(userId);
    } catch (err) {
      console.warn(
        "[BRIEFING] structure build failed:",
        err instanceof Error ? err.message : String(err),
      );
    }

    return { briefing: note, structured };
  });

  // POST /api/briefing/:id/picks/:rank/open — the user opened a pick's mail
  // from the briefing. Stamps the pick's openedAt once (first open wins), so
  // "picks shown" vs "picks opened" is countable per briefing. The client
  // navigates to the mail itself; this only records the open.
  app.post("/:id/picks/:rank/open", async (request, reply) => {
    const userId = getUserId(request);
    const { id, rank: rawRank } = request.params as { id: string; rank: string };
    const rank = parseRank(rawRank);
    if (!rank) return reply.code(400).send({ error: "rank must be 1, 2, or 3" });

    const note = await prisma.note.findFirst({
      where: { id, userId, title: { startsWith: "Daily Briefing" } },
      select: { id: true, picks: true },
    });
    const picks = readStoredPicks(note?.picks);
    const pick = picks.find((p) => p.rank === rank);
    if (!note || !pick) return reply.code(404).send({ error: "Pick not found" });
    if (pick.openedAt) return { emailId: pick.emailId, openedAt: pick.openedAt, first: false };

    const openedAt = new Date().toISOString();
    const next = picks.map((p) => (p.rank === rank ? { ...p, openedAt } : p));
    await prisma.note.updateMany({
      where: { id: note.id, userId },
      data: { picks: picksColumn(next) },
    });
    return { emailId: pick.emailId, openedAt, first: true };
  });

  // GET /api/briefing/:id/top-actions/feedback — latest feedback per Top 3 rank
  app.get("/:id/top-actions/feedback", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const note = await findUserBriefingNote(userId, id);
    if (!note) return reply.code(404).send({ error: "Briefing not found" });

    const sourceIds = [1, 2, 3].map((rank) => briefingTopActionSourceId(id, rank));
    const rows = await prisma.feedbackEvent.findMany({
      where: {
        userId,
        source: "ATTENTION_ITEM",
        toolName: BRIEFING_TOP_ACTION_TOOL,
        sourceId: { in: sourceIds },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        sourceId: true,
        signal: true,
        evidence: true,
        createdAt: true,
      },
    });

    const feedback: Record<number, unknown> = {};
    for (const row of rows) {
      const rank = parseRank(row.sourceId.split(":").at(-1));
      if (!rank || feedback[rank]) continue;
      const choice =
        BRIEFING_CHOICE_BY_SIGNAL[row.signal as keyof typeof BRIEFING_CHOICE_BY_SIGNAL];
      if (!choice) continue;
      feedback[rank] = {
        id: row.id,
        rank,
        choice,
        signal: row.signal,
        evidence: row.evidence,
        createdAt: row.createdAt.toISOString(),
      };
    }

    return { feedback };
  });

  // POST /api/briefing/:id/top-actions/:rank/feedback — capture Top 3 quality
  app.post("/:id/top-actions/:rank/feedback", async (request, reply) => {
    const userId = getUserId(request);
    const { id, rank: rawRank } = request.params as { id: string; rank: string };
    const rank = parseRank(rawRank);
    if (!rank) return reply.code(400).send({ error: "rank must be 1, 2, or 3" });

    const body = (request.body ?? {}) as {
      choice?: string;
      label?: string;
      evidence?: string;
    };
    const choice = body.choice as BriefingFeedbackChoice | undefined;
    if (!choice || !BRIEFING_FEEDBACK_CHOICES.has(choice)) {
      return reply.code(400).send({ error: "choice must be one of useful, wrong, later, done" });
    }

    const note = await findUserBriefingNote(userId, id);
    if (!note) return reply.code(404).send({ error: "Briefing not found" });

    const signal = BRIEFING_SIGNAL_BY_CHOICE[choice];
    const evidence = JSON.stringify({
      choice,
      noteId: id,
      rank,
      label: typeof body.label === "string" ? body.label.slice(0, 500) : null,
      evidence: typeof body.evidence === "string" ? body.evidence.slice(0, 500) : null,
    });

    await recordFeedback({
      userId,
      source: "ATTENTION_ITEM",
      sourceId: briefingTopActionSourceId(id, rank),
      signal,
      toolName: BRIEFING_TOP_ACTION_TOOL,
      evidence,
    });

    return {
      feedback: {
        noteId: id,
        rank,
        choice,
        signal,
      },
    };
  });

  // GET /api/briefing/status — Today's briefing, notification, and push state
  app.get("/status", (request) => {
    const userId = getUserId(request);
    return getBriefingStatus(userId);
  });
}

async function todayRangeForUser(userId: string): Promise<{ gte: Date; lt: Date }> {
  const config = await prisma.automationConfig.findUnique({
    where: { userId },
    select: { timezone: true },
  });
  const { gte, lt } = localDayUtcRange(new Date(), normalizeTimeZone(config?.timezone));
  return { gte, lt };
}

/**
 * The user's LOCAL calendar day as YYYY-MM-DD, using the SAME timezone
 * resolution as todayRangeForUser (localDayUtcRange returns this exact key as
 * `dateKey`). Sharing the resolution keeps dayKey aligned with the "today"
 * window and stable across a local day — the dedup key for the daily briefing.
 */
async function briefingDayKeyForUser(userId: string): Promise<string> {
  const config = await prisma.automationConfig.findUnique({
    where: { userId },
    select: { timezone: true },
  });
  return localDayUtcRange(new Date(), normalizeTimeZone(config?.timezone)).dateKey;
}

// Tool for Klorn to generate briefing on demand
export const BRIEFING_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "generate_briefing",
      description:
        "Generate a daily briefing summarizing today's tasks, calendar events, emails, and notes. Use this when the user asks for a daily summary or morning briefing.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];
