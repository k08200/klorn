/**
 * Voice → calendar structuring: turn free text ("내일 3시 김대표 미팅") into a
 * calendar event draft. Parsing ONLY — the write stays on POST /api/calendar.
 *
 * Rides the measured JUDGE_MODEL pin (a structuring task, not a conversational
 * surface — per the #726 doctrine the user-selected chat model does not apply).
 * BYOK credentials ride along so key-holders bill their own account.
 */

import { getUserLlmCredentials } from "./llm-credentials.js";
import { parseLlmJson } from "./llm-json.js";
import { createCompletion, JUDGE_MODEL } from "./openai.js";
import { captureError } from "./sentry.js";
import { offsetStringFor } from "./time-zone.js";
import { getUserTimeZone } from "./user-timezone.js";

export interface ParsedEvent {
  title: string;
  startTime: string;
  endTime: string;
  location?: string;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

function localStamp(now: Date, timeZone: string): string {
  // e.g. "2026-07-06 10:00 (Monday)" in the user's zone — the anchor for
  // relative dates. Hardcoded to Asia/Seoul before #756: a user elsewhere
  // saying "tomorrow" got it resolved against Seoul's already-rolled-over
  // date for a large fraction of each day.
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => local.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} (${get("weekday")})`;
}

function buildPrompt(text: string, now: Date, timeZone: string): string {
  const offset = offsetStringFor(now, timeZone);
  return `Current date/time in the user's timezone (${timeZone}): ${localStamp(now, timeZone)}

Extract ONE calendar event from the user's utterance below. Respond with ONLY a JSON object, no prose:
{"title": string, "startTime": ISO-8601 with ${offset} offset, "endTime": ISO-8601 with ${offset} offset, "location"?: string}

Rules:
- Resolve relative dates ("내일"=tomorrow, "모레", "다음주 화요일", "tomorrow") against the current date above, in the user's own timezone.
- Korean AM/PM: "오전 N시" → morning; "오후 N시" → afternoon. Bare "N시" for meetings defaults to business context: "3시"→15:00, "8시"→20:00 unless the context clearly says morning.
- Default duration is 1 hour when no end time is given.
- The title is the concise subject ("김대표 미팅"), not the whole sentence.
- If no schedulable event can be extracted, respond with exactly {"unparseable": true}.

Utterance: ${text}`;
}

/** Returns the parsed draft, null when the text has no extractable event. Throws on LLM transport failure. */
export async function parseEventText(
  userId: string,
  text: string,
  now: Date = new Date(),
): Promise<ParsedEvent | null> {
  const [credentials, timeZone] = await Promise.all([
    getUserLlmCredentials(userId),
    getUserTimeZone(userId),
  ]);

  const response = await createCompletion(
    {
      model: JUDGE_MODEL,
      messages: [{ role: "user", content: buildPrompt(text, now, timeZone) }],
      temperature: 0,
      max_tokens: 300,
    },
    { userId, priority: "foreground", credentials },
  );

  const content = response.choices[0]?.message?.content ?? "";

  let parsed: Record<string, unknown>;
  try {
    parsed = parseLlmJson<Record<string, unknown>>(content);
  } catch (err) {
    console.error(
      `[PARSE-EVENT] malformed model output for user ${userId}:`,
      content.slice(0, 200),
    );
    captureError(err, { tags: { scope: "parse_event.json", userId } });
    return null;
  }

  if (parsed.unparseable === true) return null;

  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const startTime = typeof parsed.startTime === "string" ? parsed.startTime.trim() : "";
  let endTime = typeof parsed.endTime === "string" ? parsed.endTime.trim() : "";
  if (!title || !startTime) return null;

  const startMs = Date.parse(startTime);
  if (Number.isNaN(startMs)) return null;

  if (!endTime) {
    endTime = new Date(startMs + ONE_HOUR_MS).toISOString();
  } else if (Number.isNaN(Date.parse(endTime))) {
    return null;
  }

  const location =
    typeof parsed.location === "string" && parsed.location.trim()
      ? parsed.location.trim()
      : undefined;

  return { title, startTime, endTime, ...(location ? { location } : {}) };
}
