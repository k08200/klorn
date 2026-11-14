/**
 * Which verified Slack events Klorn keeps (docs/providers/slack.md §6). Kept:
 * DMs and group DMs to the user, channel messages that @mention the user, and
 * every message in a channel the user opted in. Never kept: another team's or
 * another member's events, Slack Connect, bots, joins and other subtypes, and
 * the user's own messages (those only mark an open episode answered).
 */

import type { SlackEventCallback } from "./envelope.js";
import { mentionsSlackUser } from "./text.js";

export interface SlackFilterConnection {
  teamId: string;
  slackUserId: string;
  optInChannelIds: readonly string[];
}

export type SlackKeepKind = "dm" | "group_dm" | "mention" | "opt_in";

export type SlackDropReason =
  | "team-mismatch"
  | "not-authorized-user"
  | "ext-shared"
  | "not-message"
  | "subtype"
  | "bot"
  | "no-user"
  | "empty"
  | "not-relevant";

export type SlackDecision =
  | { action: "keep"; kind: SlackKeepKind; mentionsUser: boolean }
  | { action: "own" }
  | { action: "delete"; ts: string }
  | { action: "drop"; reason: SlackDropReason };

/** Subtypes that are still a person writing to the conversation. */
const KEPT_SUBTYPES: ReadonlySet<string> = new Set(["thread_broadcast", "file_share"]);

function drop(reason: SlackDropReason): SlackDecision {
  return { action: "drop", reason };
}

function keepKind(
  channelType: string,
  channel: string,
  mentionsUser: boolean,
  conn: SlackFilterConnection,
): SlackKeepKind | null {
  if (channelType === "im") return "dm";
  if (channelType === "mpim") return "group_dm";
  if (channelType !== "channel" && channelType !== "group") return null;
  if (mentionsUser) return "mention";
  return conn.optInChannelIds.includes(channel) ? "opt_in" : null;
}

export function decideSlackEvent(
  envelope: SlackEventCallback,
  conn: SlackFilterConnection,
): SlackDecision {
  if (envelope.teamId !== conn.teamId) return drop("team-mismatch");
  if (!envelope.authorizedUserIds.includes(conn.slackUserId)) return drop("not-authorized-user");
  if (envelope.isExtShared) return drop("ext-shared");
  const event = envelope.event;
  if (!event) return drop("not-message");
  if (event.subtype === "message_deleted") {
    return event.deletedTs ? { action: "delete", ts: event.deletedTs } : drop("subtype");
  }
  if (event.isBot) return drop("bot");
  if (event.subtype !== null && !KEPT_SUBTYPES.has(event.subtype)) return drop("subtype");
  if (!event.user) return drop("no-user");
  if (event.user === conn.slackUserId) return { action: "own" };
  if (event.text.trim().length === 0) return drop("empty");
  const mentionsUser = mentionsSlackUser(event.text, conn.slackUserId);
  const kind = keepKind(event.channelType, event.channel, mentionsUser, conn);
  return kind ? { action: "keep", kind, mentionsUser } : drop("not-relevant");
}
