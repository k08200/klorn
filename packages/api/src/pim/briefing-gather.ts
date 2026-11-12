/**
 * What the morning briefing reads and how it is put to the model: the gather
 * (best-effort per source, with a completeness flag), the quiet-morning rule
 * and card, the per-user context, and the prompt with its pick refs.
 * The read helpers themselves live in briefing-window.ts.
 */

import { prisma } from "../db.js";
import { senderName } from "../notify/notification-format.js";
import {
  type NotificationLanguage,
  resolveNotificationLanguage,
} from "../notify/notification-strings.js";
import { localDayUtcRange, normalizeTimeZone } from "../time-zone.js";
import { stripUntrusted } from "../untrusted.js";
import { briefingCopy } from "./briefing-copy.js";
import { displaySafe, type PickableMail } from "./briefing-picks.js";
import { buildBriefingUserPrompt } from "./briefing-prompt.js";
import { wrapEventsForPrompt, wrapSignalsForPrompt } from "./briefing-prompt-wrap.js";
import { type BriefingSignals, buildBriefingSignals } from "./briefing-signals.js";
import {
  type BriefingCommitment,
  type BriefingMail,
  briefingWindowStart,
  hasTaskDueSoon,
  hasUsableMailConnection,
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
  promptTask,
  signalMail,
  WINDOW_SCAN,
} from "./briefing-window.js";
import { readCalendarRows } from "./calendar-read.js";
import { listTasks } from "./tasks.js";

const BRIEFING_CALENDAR_WINDOW_DAYS = 14;
/** Events the rule-based briefing reads; the cap applies after the dedupe. */
const BRIEFING_EVENT_LIMIT = 20;
/** Calendar description characters the prompt carries per event (invites embed whole agendas). */
const EVENT_DESCRIPTION_CHARS = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Still-open mail the quiet card lists. */
const QUIET_OPEN_LIMIT = 3;
const QUIET_SUBJECT_CHARS = 80;

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

export interface BriefingData {
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
  quiet: QuietFacts;
  signals: BriefingSignals;
}

/** What the quiet-morning rule reads beyond the prompt data, each from the full set. */
interface QuietFacts {
  /** A previous briefing exists: the first one always goes to the model. */
  hasPrevious: boolean;
  /** The window scan hit its cap: there may be more mail than was read. */
  windowFull: boolean;
  /** An open task is overdue or due within a day (all open tasks, not the prompt's 20). */
  taskDueSoon: boolean;
  /** An event is in progress or starts within a day, all-day events included. */
  eventSoon: boolean;
  /** The sync has a usable mail connection. */
  mailConnected: boolean;
}

async function hasEventSoon(userId: string, now: Date): Promise<boolean> {
  const rows = await readCalendarRows({
    userId,
    when: { startTime: { lt: new Date(now.getTime() + DAY_MS) }, endTime: { gt: now } },
    limit: 1,
  });
  return rows.length > 0;
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

export async function gatherBriefingData(
  userId: string,
  todayKey: string,
  now: Date = new Date(),
): Promise<BriefingData> {
  const failures: string[] = [];
  const { since, hasPrevious } = await readSource(
    userId,
    "window start",
    () => briefingWindowStart(userId, todayKey, now),
    { since: new Date(now.getTime() - DAY_MS), hasPrevious: false },
    failures,
  );
  const [tasks, events, window, commitments, notes, eventSoon, mailConnected] = await Promise.all([
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
    readSource(userId, "events soon", () => hasEventSoon(userId, now), true, failures),
    readSource(
      userId,
      "mail connection",
      () => hasUsableMailConnection(userId, now),
      false,
      failures,
    ),
  ]);
  const openPush = await readSource(
    userId,
    "open PUSH",
    () => listOpenPushMail(userId, new Set(window.mails.map((m) => m.emailId)), now),
    [],
    failures,
  );

  const allTasks = (tasks.tasks ?? []) as Array<Record<string, unknown>>;
  const data = {
    tasks: { tasks: openTasks(allTasks) },
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
    quiet: {
      hasPrevious,
      windowFull: window.scanned >= WINDOW_SCAN,
      taskDueSoon: hasTaskDueSoon(allTasks, now),
      eventSoon,
      mailConnected,
    },
    signals: buildBriefingSignals(data, { now }),
  };
}

/**
 * A quiet morning: every source read, a previous briefing exists, the mail
 * connection is usable, no new non-SILENT mail since the last briefing (with
 * the whole window read), and nothing scheduled, committed or due within a
 * day. The briefing then skips the model and delivers the quiet card instead.
 */
export function isQuietMorning(data: BriefingData): boolean {
  const q = data.quiet;
  if (!data.complete || !q.hasPrevious || !q.mailConnected || q.windowFull) return false;
  if (data.newMailCount > 0 || data.commitments.length > 0) return false;
  return !q.taskDueSoon && !q.eventSoon;
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
      const subject = displaySafe(mail.subject, QUIET_SUBJECT_CHARS);
      lines.push(`- ${displaySafe(senderName(mail.from, lang), QUIET_SUBJECT_CHARS)} — ${subject}`);
    }
  }
  return lines.join("\n");
}

export interface UserBriefingContext {
  timeZone: string;
  lang: NotificationLanguage;
  todayKey: string;
}

export async function userBriefingContext(userId: string, now: Date): Promise<UserBriefingContext> {
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

export function buildPrompt(data: BriefingData, ctx: UserBriefingContext, now: Date) {
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
    tasks: data.tasks.tasks.map((task) => promptTask(task as Record<string, unknown>)),
    events: promptEvents(data.events),
    commitments: data.commitments.map(promptCommitment),
    emails: data.windowMail.map(refFor),
    openFromBefore: data.openPush.map(refFor),
    notes: data.notes.notes.map(promptNote),
    omittedMail: data.omittedMail,
  });
  return { prompt, refs };
}
