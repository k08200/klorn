/**
 * Which part of an export is processed (docs/providers/kakaotalk-import.md §3).
 *
 * Only the last 30 days before the upload, and at most the latest 2,000 text
 * messages of them, so a five-year chat cannot spend the user's LLM budget:
 * an open promise is a recent one, and older ones are mostly done or stale.
 * The window is measured from now, not from the chat's last message, so an old
 * export yields nothing to process instead of a ledger of long-past deadlines.
 *
 * Cost: an export can hold 200,000 messages, and one zone conversion
 * (wallClockToUtcMs) costs a few Intl calls. So nothing here converts every
 * message: a message whose printed wall clock is days outside the window is
 * dropped before any conversion (no zone is more than a day off UTC), and the
 * rest share one conversion per wall-clock hour (exact per message only in an
 * hour where the zone's offset changes).
 */

import { wallClockToUtcMs } from "../time-zone.js";
import type { KakaoFormat, KakaoMessage, KakaoMessageKind } from "./parse.js";

export const KAKAO_WINDOW_DAYS = 30;
export const KAKAO_MAX_WINDOW_MESSAGES = 2_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A phone clock a little ahead of the server's still counts. */
const FUTURE_SLACK_MS = DAY_MS;
/** More than any zone's distance from UTC: the wall-clock pre-filter's margin. */
const ZONE_MARGIN_MS = 2 * DAY_MS;

export interface KakaoTimedMessage {
  readonly sentAt: Date;
  readonly speaker: string;
  readonly kind: KakaoMessageKind;
  readonly text: string;
}

export interface KakaoWindow {
  readonly start: Date;
  readonly end: Date;
}

export interface KakaoSpeaker {
  readonly name: string;
  readonly total: number;
  /** Text messages of this speaker that an import would process. */
  readonly inWindow: number;
}

export interface KakaoPreview {
  readonly format: KakaoFormat;
  readonly totalMessages: number;
  readonly windowMessages: number;
  readonly windowTruncated: boolean;
  readonly speakers: readonly KakaoSpeaker[];
  readonly firstAt: string;
  readonly lastAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly windowDays: number;
}

export function kakaoWindow(now: Date): KakaoWindow {
  return {
    start: new Date(now.getTime() - KAKAO_WINDOW_DAYS * DAY_MS),
    end: new Date(now.getTime() + FUTURE_SLACK_MS),
  };
}

/**
 * Wall clock → instant in `timeZone`, one wallClockToUtcMs per wall-clock hour.
 * An hour whose offset is the same at both ends has no transition inside it,
 * so its offset applies to every minute; otherwise each message is converted.
 */
function zoneConverter(timeZone: string): (localMs: number) => number {
  const offsets = new Map<number, number | null>();
  const offsetAt = (localMs: number) => wallClockToUtcMs(localMs, timeZone) - localMs;
  return (localMs) => {
    const hour = Math.floor(localMs / HOUR_MS) * HOUR_MS;
    let offset = offsets.get(hour);
    if (offset === undefined) {
      const atStart = offsetAt(hour);
      offset = atStart === offsetAt(hour + HOUR_MS) ? atStart : null;
      offsets.set(hour, offset);
    }
    return offset === null ? wallClockToUtcMs(localMs, timeZone) : localMs + offset;
  };
}

/** Text messages inside the window, with their instants, oldest first. */
function windowCandidates(
  messages: readonly KakaoMessage[],
  timeZone: string,
  window: KakaoWindow,
): KakaoTimedMessage[] {
  const start = window.start.getTime();
  const end = window.end.getTime();
  const toUtc = zoneConverter(timeZone);
  const kept: KakaoTimedMessage[] = [];
  for (const message of messages) {
    if (message.kind !== "text") continue;
    if (message.localMs < start - ZONE_MARGIN_MS || message.localMs > end + ZONE_MARGIN_MS)
      continue;
    const at = toUtc(message.localMs);
    if (at < start || at > end) continue;
    kept.push({
      sentAt: new Date(at),
      speaker: message.speaker,
      kind: message.kind,
      text: message.text,
    });
  }
  return kept.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
}

/** The text messages an import stores and processes: in the window, the latest N, oldest first. */
export function selectWindowMessages(
  messages: readonly KakaoMessage[],
  timeZone: string,
  window: KakaoWindow,
): KakaoTimedMessage[] {
  return windowCandidates(messages, timeZone, window).slice(-KAKAO_MAX_WINDOW_MESSAGES);
}

function speakerCounts(
  messages: readonly KakaoMessage[],
  selected: readonly KakaoTimedMessage[],
): KakaoSpeaker[] {
  const totals = new Map<string, number>();
  for (const message of messages)
    totals.set(message.speaker, (totals.get(message.speaker) ?? 0) + 1);
  const windowed = new Map<string, number>();
  for (const message of selected) {
    windowed.set(message.speaker, (windowed.get(message.speaker) ?? 0) + 1);
  }
  return [...totals.entries()]
    .map(([name, total]) => ({ name, total, inWindow: windowed.get(name) ?? 0 }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ko"));
}

/** The earliest and latest printed wall clock: two conversions, not one per message. */
function bounds(messages: readonly KakaoMessage[], timeZone: string): { first: Date; last: Date } {
  let first = messages[0].localMs;
  let last = messages[0].localMs;
  for (const message of messages) {
    if (message.localMs < first) first = message.localMs;
    if (message.localMs > last) last = message.localMs;
  }
  return {
    first: new Date(wallClockToUtcMs(first, timeZone)),
    last: new Date(wallClockToUtcMs(last, timeZone)),
  };
}

/** What the upload holds and what an import of it would process. `messages` is non-empty. */
export function previewKakaoExport(
  format: KakaoFormat,
  messages: readonly KakaoMessage[],
  timeZone: string,
  window: KakaoWindow,
): KakaoPreview {
  const candidates = windowCandidates(messages, timeZone, window);
  const selected = candidates.slice(-KAKAO_MAX_WINDOW_MESSAGES);
  const { first, last } = bounds(messages, timeZone);
  return {
    format,
    totalMessages: messages.length,
    windowMessages: selected.length,
    windowTruncated: candidates.length > selected.length,
    speakers: speakerCounts(messages, selected),
    firstAt: first.toISOString(),
    lastAt: last.toISOString(),
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    windowDays: KAKAO_WINDOW_DAYS,
  };
}
