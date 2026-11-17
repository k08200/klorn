/**
 * Today on a phone (mobile redesign PR2, MB1 "Editorial Brief", LOCKED
 * 2026-11-14) — the pure half: why a PUSH card rang, which events the strip
 * shows, the day's meeting count and the quiet lanes in the footer. No React
 * and no DOM, so the api vitest suite pins it
 * (packages/api/src/__tests__/web-today-brief-model.test.ts).
 */

import type { EmailLaneCounts, EmailListItem, LiveTier } from "@klorn/contract";
import { type ReasonLine, reasonLine } from "../../lib/notification-center";
import { type CalendarEventWire, eventPhase, orderEvents } from "./model";

/** Events on the phone's next-events strip. */
export const BRIEF_NEXT_EVENTS = 3;

/**
 * Why a PUSH mail rang, as the card's title. Evidence on a v3 reason was
 * checked against the mail by the facts extractor (api judge/v3/evidence.ts),
 * so it is the verified quote; otherwise the judge's free text, which the card
 * prefixes "Klorn's call · ". The same rule as the notification center
 * (reasonLine). Plain text only: both may be model or sender output.
 */
export function pushWhy(email: Pick<EmailListItem, "tierReason" | "v3">): ReasonLine {
  const evidence = email.v3?.reasons.find((r) => r.evidence?.trim())?.evidence ?? undefined;
  return reasonLine({
    verified: Boolean(evidence),
    quote: evidence,
    text: email.tierReason ?? "",
  });
}

export interface NextEvent {
  event: CalendarEventWire;
  /** Running right now. */
  now: boolean;
}

/** The running and upcoming timed events of the day, in order. */
export function nextEvents(
  events: readonly CalendarEventWire[],
  now: Date,
  limit: number = BRIEF_NEXT_EVENTS,
): NextEvent[] {
  return orderEvents(events)
    .map((event) => ({ event, phase: eventPhase(event, now) }))
    .filter(({ phase }) => phase === "now" || phase === "upcoming")
    .slice(0, limit)
    .map(({ event, phase }) => ({ event, now: phase === "now" }));
}

/** The day's timed events: all-day ones are not meetings. */
export function meetingCount(events: readonly CalendarEventWire[]): number {
  return events.filter((event) => !event.allDay).length;
}

// lane-subset: the quiet footer lists only the lanes Klorn sorted away; PUSH
// and MEETING have their own place on the brief (cards, the Meeting block).
const QUIET_LANES: readonly LiveTier[] = ["QUEUE", "INFO", "SILENT"];

/** The lanes Klorn sorted away, by threads, only those that hold mail. */
export function quietLanes(counts: EmailLaneCounts | null): { lane: LiveTier; count: number }[] {
  if (!counts) return [];
  return QUIET_LANES.flatMap((lane) => {
    const count = counts[lane].threads ?? counts[lane].total;
    return count > 0 ? [{ lane, count }] : [];
  });
}

/** The headline's key: calm at zero, `.one` / `.many` otherwise. */
export function briefHeadlineKey(count: number): string {
  if (count <= 0) return "today.brief.headline.none";
  return count === 1 ? "today.brief.headline.one" : "today.brief.headline.many";
}
