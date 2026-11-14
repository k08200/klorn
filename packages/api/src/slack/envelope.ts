/**
 * The Events API envelope, parsed only after its signature verified
 * (routes/slack-events.ts). Every field Klorn reads is shape-checked and
 * length-bounded here; anything else in the payload is ignored. Shapes:
 * https://docs.slack.dev/apis/events-api/ and
 * https://docs.slack.dev/reference/events/message.
 */

import { capSlackText, SLACK_MAX_TEXT, sanitizeSlackText } from "./text.js";

export interface SlackMessageEvent {
  channel: string;
  channelType: string;
  subtype: string | null;
  user: string | null;
  text: string;
  ts: string;
  threadTs: string | null;
  deletedTs: string | null;
  isBot: boolean;
}

export interface SlackEventCallback {
  kind: "event_callback";
  eventId: string;
  teamId: string;
  authorizedUserIds: string[];
  isExtShared: boolean;
  /** Null when the inner event is not a usable `message`. */
  event: SlackMessageEvent | null;
  /** The inner event's type, bounded; for the filter's "not a message" drop. */
  eventType: string;
}

export type SlackEnvelope =
  | { kind: "url_verification"; challenge: string }
  | SlackEventCallback
  | { kind: "app_rate_limited" }
  | { kind: "invalid"; reason: string };

const MAX_CHALLENGE = 512;
const MAX_ID = 40;
const MAX_TYPE = 64;
const MAX_AUTHORIZATIONS = 10;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/** Upper-case letters and digits after a fixed one-letter prefix set (Slack ids). */
function slackId(value: unknown, prefixes: string): string | null {
  const id = boundedString(value, MAX_ID);
  if (!id || id.length < 2 || !prefixes.includes(id.charAt(0))) return null;
  for (let i = 1; i < id.length; i++) {
    const c = id.charCodeAt(i);
    const upper = c >= 65 && c <= 90;
    const digit = c >= 48 && c <= 57;
    if (!upper && !digit) return null;
  }
  return id;
}

/** `Ev` + letters/digits (event ids are globally unique per Slack). */
function eventId(value: unknown): string | null {
  const id = boundedString(value, MAX_ID);
  if (!id || !id.startsWith("Ev") || id.length < 4) return null;
  for (let i = 2; i < id.length; i++) {
    const c = id.charCodeAt(i);
    const alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (!alnum) return null;
  }
  return id;
}

/** Slack message timestamps: digits, a dot, digits. */
function slackTs(value: unknown): string | null {
  const ts = boundedString(value, 24);
  if (!ts) return null;
  const dot = ts.indexOf(".");
  if (dot <= 0 || dot === ts.length - 1) return null;
  for (let i = 0; i < ts.length; i++) {
    if (i === dot) continue;
    const c = ts.charCodeAt(i);
    if (c < 48 || c > 57) return null;
  }
  return ts;
}

function parseMessageEvent(raw: Json): SlackMessageEvent | null {
  if (raw.type !== "message") return null;
  const channel = slackId(raw.channel, "CDG");
  const ts = slackTs(raw.ts);
  if (!channel || !ts) return null;
  const subtype = raw.subtype === undefined ? null : boundedString(raw.subtype, MAX_TYPE);
  if (raw.subtype !== undefined && subtype === null) return null;
  return {
    channel,
    channelType: boundedString(raw.channel_type, MAX_TYPE) ?? "",
    subtype,
    user: slackId(raw.user, "UW"),
    text:
      typeof raw.text === "string" ? sanitizeSlackText(capSlackText(raw.text, SLACK_MAX_TEXT)) : "",
    ts,
    threadTs: slackTs(raw.thread_ts),
    deletedTs: slackTs(raw.deleted_ts),
    isBot: raw.bot_id !== undefined || raw.bot_profile !== undefined || subtype === "bot_message",
  };
}

function authorizedUsers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value.slice(0, MAX_AUTHORIZATIONS)) {
    if (!isObject(entry)) continue;
    const id = slackId(entry.user_id, "UW");
    if (id) ids.push(id);
  }
  return ids;
}

function parseEventCallback(body: Json): SlackEnvelope {
  const id = eventId(body.event_id);
  if (!id) return { kind: "invalid", reason: "event_id" };
  const teamId = slackId(body.team_id, "TE");
  if (!teamId) return { kind: "invalid", reason: "team_id" };
  if (!isObject(body.event)) return { kind: "invalid", reason: "event" };
  return {
    kind: "event_callback",
    eventId: id,
    teamId,
    authorizedUserIds: authorizedUsers(body.authorizations),
    isExtShared: body.is_ext_shared_channel === true,
    event: parseMessageEvent(body.event),
    eventType: boundedString(body.event.type, MAX_TYPE) ?? "",
  };
}

/** Parses a verified request body; never throws. */
export function parseSlackEnvelope(rawBody: string): SlackEnvelope {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { kind: "invalid", reason: "json" };
  }
  if (!isObject(body)) return { kind: "invalid", reason: "shape" };
  switch (body.type) {
    case "url_verification": {
      const challenge = boundedString(body.challenge, MAX_CHALLENGE);
      return challenge
        ? { kind: "url_verification", challenge }
        : { kind: "invalid", reason: "challenge" };
    }
    case "event_callback":
      return parseEventCallback(body);
    case "app_rate_limited":
      return { kind: "app_rate_limited" };
    default:
      return { kind: "invalid", reason: "type" };
  }
}
