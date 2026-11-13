/**
 * The "Add to calendar" proposal for one of the user's own mails
 * (routes/smart-actions.ts). Proposing never writes: the confirm card shows the
 * proposal and only the user's Save writes (POST .../event).
 *
 * Date and clock time are deterministic (event-when.ts over the Commitment
 * Ledger's rules); where they would be guessed, the proposal carries a question
 * instead. The model (event-parse.ts, the same parser chat's event drafts use,
 * on a ≤500-char quote wrapped as untrusted) only names the event, its place
 * and its length — and the card shows all three for the user to edit. When the
 * model is unavailable the proposal still stands, titled from the subject.
 */

import type { ParsedEvent } from "../event-parse.js";
import { costCapRefusal } from "../llm/cost-cap-refusal.js";
import { captureError } from "../sentry.js";
import { localDateTimeToUtc } from "../time-zone.js";
import { getUserTimeZone } from "../user-timezone.js";
import { readOverlappingTimedEvents } from "./calendar-read.js";
import { findDueSpans } from "./commitment-due.js";
import {
  type EventQuestion,
  type EventWhen,
  eventTitleFromSubject,
  quoteAround,
  readEventWhen,
  withClockContext,
} from "./event-when.js";

export const DEFAULT_EVENT_MINUTES = 60;
export const MIN_EVENT_MINUTES = 5;
export const MAX_EVENT_MINUTES = 24 * 60;
/** The model's length is a suggestion; keep it to a plausible meeting. */
const MAX_SUGGESTED_MINUTES = 8 * 60;
const MAX_SCAN_CHARS = 4_000;
const MAX_TITLE_CHARS = 120;
const MAX_LOCATION_CHARS = 200;
const MAX_EXISTING = 3;
const MINUTE_MS = 60_000;

export interface ExistingEvent {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
}

export interface EventProposal {
  title: string;
  /** `YYYY-MM-DD` in `timeZone`; null = the card asks which day. */
  date: string | null;
  /** `HH:MM` (24h) in `timeZone`; null = the card asks (see `question`). */
  time: string | null;
  durationMinutes: number;
  location: string | null;
  timeZone: string;
  /** The sentence the date was read from, verbatim from the mail. */
  quote: string;
  question: EventQuestion | null;
  /** Events already on the calendar at that time (an invite already accepted, say). */
  existing: ExistingEvent[];
}

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Timed events overlapping [start, end) — the duplicate check before a write.
 * The calendar readers' own query (pim/calendar-read.ts): the same visibility
 * scope, one row per invite, and all-day markers (a birthday, a holiday) left
 * out as the conflict check leaves them out.
 */
export async function overlappingEvents(
  userId: string,
  start: Date,
  end: Date,
): Promise<ExistingEvent[]> {
  const rows = await readOverlappingTimedEvents(userId, { start, end });
  return rows.slice(0, MAX_EXISTING).map((row) => ({
    id: row.id,
    title: row.title,
    startTime: row.startTime.toISOString(),
    endTime: row.endTime.toISOString(),
  }));
}

/** The model's title, place and length for the quote; null when it has none or fails. */
async function modelDetails(
  userId: string,
  quote: string,
  receivedAt: Date,
): Promise<ParsedEvent | null> {
  try {
    const { parseEventText } = await import("../event-parse.js");
    return await parseEventText(userId, quote.slice(0, 500), receivedAt);
  } catch (err) {
    // The deterministic proposal stands without the model; only a real fault alerts.
    if (!costCapRefusal(err)) {
      captureError(err, { tags: { scope: "smart-actions.event-details" }, extra: { userId } });
    }
    return null;
  }
}

function suggestedMinutes(details: ParsedEvent | null): number {
  if (!details) return DEFAULT_EVENT_MINUTES;
  const minutes = (Date.parse(details.endTime) - Date.parse(details.startTime)) / MINUTE_MS;
  if (!Number.isFinite(minutes) || minutes < MIN_EVENT_MINUTES) return DEFAULT_EVENT_MINUTES;
  return Math.min(MAX_SUGGESTED_MINUTES, Math.round(minutes / 5) * 5);
}

/** The proposal for this mail, or null when it names no date or time at all. */
export async function proposeEventFromEmail(
  userId: string,
  email: { subject: string; body: string | null; receivedAt: Date },
): Promise<EventProposal | null> {
  const text = `${email.subject}\n\n${email.body ?? ""}`.slice(0, MAX_SCAN_CHARS);
  const spans = findDueSpans(text);
  if (spans.length === 0) return null;

  const timeZone = await getUserTimeZone(userId);
  const ctx = { referenceDate: email.receivedAt, timeZone };
  const readings = spans.map((span) => ({
    span,
    when: withClockContext(readEventWhen(span.phrase, ctx), text, span),
  }));
  // "Need your reply today" in the subject is a deadline; "tomorrow at 3pm" in
  // the body is the meeting. Prefer a phrase with a day and a clock time, then
  // one with a clock time, then the first.
  const hasClock = (w: EventWhen) => w.time !== null || w.question?.kind === "meridiem";
  const { span, when } =
    readings.find(({ when: w }) => w.date !== null && hasClock(w)) ??
    readings.find(({ when: w }) => hasClock(w)) ??
    readings[0];
  const quote = quoteAround(text, span.phrase, span.start);
  const details = await modelDetails(userId, quote, email.receivedAt);
  const durationMinutes = suggestedMinutes(details);

  let existing: ExistingEvent[] = [];
  if (when.date && when.time) {
    const start = localDateTimeToUtc(when.date, when.time, timeZone);
    existing = await overlappingEvents(
      userId,
      start,
      new Date(start.getTime() + durationMinutes * MINUTE_MS),
    );
  }

  return {
    title:
      oneLine(details?.title ?? "", MAX_TITLE_CHARS) ||
      eventTitleFromSubject(email.subject) ||
      oneLine(quote, MAX_TITLE_CHARS),
    date: when.date,
    time: when.time,
    durationMinutes,
    location: oneLine(details?.location ?? "", MAX_LOCATION_CHARS) || null,
    timeZone,
    quote,
    question: when.question,
    existing,
  };
}
