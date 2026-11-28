/**
 * NT0 notification presentation (copy spec decided 2026-11-17): the structured
 * fields beside a notification's text (contract NotificationPresentation) and
 * how each channel carries them.
 *
 *   - Every channel carries the fields flat under their contract names: APNs
 *     top-level custom keys, FCM `data` (strings), Web Push JSON, live frames.
 *     Additive: a client that does not read them sees exactly what it did.
 *   - FCM `data` adds `channelId` (the Android channel of the kind) and
 *     `groupKey` (the thread, else the kind) for the app's channel work.
 *   - APNs presentation — `subtitle`, `thread-id`, `interruption-level`,
 *     `relevance-score`, priority 5 for a passive kind — only while
 *     NOTIFY_PUSH_PRESENTATION is open to the user (config.ts).
 *   - The verified quote, and on APNs / FCM a meeting's join link, only while
 *     NOTIFY_PUSH_QUOTE is open to the user: mail and meeting content through
 *     Apple's and Google's push services. Web Push payloads are end-to-end
 *     encrypted (RFC 8291), so the join link rides there always.
 */

import type {
  AndroidNotificationChannel,
  NotificationKind,
  NotificationPresentation,
} from "@klorn/contract";
import { pushQuoteOpenTo } from "../config.js";
import { safeHttpsLink } from "../safe-https-link.js";
import type { NotifCategory } from "./notification-prefs.js";
import type { PushBucket } from "./push-bucket.js";

type InterruptionLevel = "active" | "passive" | "time-sensitive";

const INTERRUPTION: Record<NotificationKind, InterruptionLevel> = {
  push: "time-sensitive",
  meet: "time-sensitive",
  agent: "active",
  acct: "active",
  brief: "passive",
  wait: "passive",
  digest: "passive",
};

/** iOS orders a notification summary by this (0–1): what needs the user now first. */
const RELEVANCE: Record<NotificationKind, number> = {
  push: 1,
  meet: 0.9,
  agent: 0.6,
  acct: 0.5,
  brief: 0.4,
  wait: 0.3,
  digest: 0.2,
};

const ANDROID_CHANNEL: Record<NotificationKind, AndroidNotificationChannel> = {
  push: "push",
  meet: "meetings",
  wait: "waiting",
  digest: "waiting",
  agent: "waiting",
  brief: "briefing",
  acct: "account",
};

/** A join link longer than this is not sent (bounds the payload; real links are far shorter). */
const JOIN_URL_MAX = 512;
/** A thread id longer than this is not sent (provider ids are far shorter). */
const THREAD_ID_MAX = 256;
/**
 * Hosts a join link may point at (the host itself or a sub-domain of it), with
 * the provider name the meet copy shows: a structured link a client can open in
 * one tap, so a calendar entry naming any other host carries none.
 */
const JOIN_HOSTS: Readonly<Record<string, string>> = {
  "zoom.us": "Zoom",
  "meet.google.com": "Google Meet",
  "teams.microsoft.com": "Microsoft Teams",
  "teams.live.com": "Microsoft Teams",
  "webex.com": "Webex",
  "whereby.com": "Whereby",
};

/** The allowlisted join host a URL names (itself or as a parent domain), if any. */
function joinHostOf(hostname: string): string | undefined {
  return Object.keys(JOIN_HOSTS).find((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/**
 * The kind of a push whose caller named none, from its category — only where
 * the category says it unambiguously: an urgent mail that rings the interrupt
 * bucket (held mail summarised later, or an agent's note, rings ambient and is
 * not one), the briefing, an agent proposal. A "meeting" category push is not
 * assumed to be a meeting starting (a back-to-back warning is not).
 */
export function defaultKind(
  category: NotifCategory,
  bucket?: PushBucket,
): NotificationKind | undefined {
  if (category === "email_urgent") return bucket === "interrupt" ? "push" : undefined;
  if (category === "daily_briefing") return "brief";
  if (category === "agent_proposal") return "agent";
  return undefined;
}

export function isPassiveKind(kind: NotificationKind | undefined): boolean {
  return kind !== undefined && INTERRUPTION[kind] === "passive";
}

function safeJoinUrl(value: string | undefined): string | undefined {
  if (!value || value.length > JOIN_URL_MAX) return undefined;
  const safe = safeHttpsLink(value);
  if (!safe || safe.length > JOIN_URL_MAX) return undefined;
  const { hostname, port } = new URL(safe);
  return joinHostOf(hostname) && port === "" ? safe : undefined;
}

/**
 * The meeting service a join link belongs to ("Google Meet", "Zoom", …), for
 * the NT0 meet copy: only for a link that passes the same checks as a pushed
 * join link, so the copy never names a service the push would not link to.
 */
export function joinProviderName(joinUrl: string | null | undefined): string | undefined {
  const link = safeJoinUrl(joinUrl ?? undefined);
  if (!link) return undefined;
  const host = joinHostOf(new URL(link).hostname);
  return host ? JOIN_HOSTS[host] : undefined;
}

/**
 * A meeting's fields: the join link only when it passes the same checks as on
 * a push (so a live frame never offers a link a push would drop), and how many
 * people are invited — never who.
 */
export function meetingPresentation(
  joinUrl: string | null | undefined,
  attendeeCount: number | null | undefined,
): NotificationPresentation {
  const link = safeJoinUrl(joinUrl ?? undefined);
  return {
    kind: "meet",
    ...(link ? { joinUrl: link } : {}),
    ...(typeof attendeeCount === "number" ? { attendeeCount } : {}),
  };
}

/** The fields each channel family may carry for this user. */
export function presentationForChannels(
  userId: string,
  presentation: NotificationPresentation | undefined,
  category: NotifCategory,
  bucket?: PushBucket,
): { web?: NotificationPresentation; native?: NotificationPresentation } {
  const kind = presentation?.kind ?? defaultKind(category, bucket);
  if (!presentation && !kind) return {};
  const allowContent = pushQuoteOpenTo(userId);
  const { quote, joinUrl, threadId, ...rest } = presentation ?? {};
  const link = safeJoinUrl(joinUrl);
  const web: NotificationPresentation = {
    ...rest,
    ...(kind ? { kind } : {}),
    ...(threadId && threadId.length <= THREAD_ID_MAX ? { threadId } : {}),
    ...(allowContent && quote ? { quote } : {}),
    ...(link ? { joinUrl: link } : {}),
  };
  const { joinUrl: _contentOnly, ...withoutLink } = web;
  return { web, native: allowContent ? web : withoutLink };
}

/**
 * APNs and FCM refuse a payload over 4096 bytes, and the push is then lost.
 * The structured fields mostly repeat the notification's own text, so when a
 * payload would pass this budget they are dropped — repeats first, then the
 * ids — until it fits. The alert / notification text itself is never cut here.
 */
export const PUSH_PAYLOAD_BUDGET_BYTES = 3900;
const DROP_ORDER = [
  "reasonLine",
  "quote",
  "subject",
  "senderDisplayName",
  "joinUrl",
  "threadId",
  "groupKey",
];

/** `keys` without as many droppable fields as `measure` needs to stay within the budget. */
export function fitWithinBudget<T extends Record<string, string | number>>(
  keys: T,
  measure: (keys: Partial<T>) => number,
): Partial<T> {
  let fitted: Partial<T> = keys;
  for (const key of DROP_ORDER) {
    if (measure(fitted) <= PUSH_PAYLOAD_BUDGET_BYTES) return fitted;
    const { [key]: _dropped, ...rest } = fitted;
    fitted = rest as Partial<T>;
  }
  return fitted;
}

/** APNs top-level custom keys: the fields as they are (attendeeCount a number). */
export function apnsCustomKeys(
  p: NotificationPresentation | undefined,
): Record<string, string | number> {
  if (!p) return {};
  const keys: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(p)) {
    if (typeof value === "string" || typeof value === "number") keys[key] = value;
  }
  return keys;
}

/** The thread a notification belongs to: its mail thread, else its kind. */
function groupOf(p: NotificationPresentation): string | undefined {
  if (p.threadId) return `thread:${p.threadId}`;
  return p.kind ? `kind:${p.kind}` : undefined;
}

/**
 * The APNs presentation (NOTIFY_PUSH_PRESENTATION): the alert laid out as
 * title / subtitle / one-line request when the push names a subject, plus the
 * `aps` keys of its kind. The alert is unchanged when there is no subject.
 */
export function apnsPresentation(
  p: NotificationPresentation,
  alert: { title: string; body: string },
): { alert: Record<string, string>; aps: Record<string, string | number> } {
  const line = p.quote ? `“${p.quote}”` : (p.reasonLine ?? "");
  const laidOut = p.subject
    ? { title: alert.title, subtitle: p.subject, ...(line ? { body: line } : {}) }
    : alert;
  const group = groupOf(p);
  return {
    alert: laidOut,
    aps: {
      ...(group ? { "thread-id": group } : {}),
      ...(p.kind ? { "interruption-level": INTERRUPTION[p.kind] } : {}),
      ...(p.kind ? { "relevance-score": RELEVANCE[p.kind] } : {}),
    },
  };
}

/** FCM `data` keys: the fields as strings, plus the kind's Android channel and the group key. */
export function fcmPresentationData(
  p: NotificationPresentation | undefined,
): Record<string, string> {
  if (!p) return {};
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(p)) {
    if (typeof value === "string" || typeof value === "number") data[key] = String(value);
  }
  if (p.kind) data.channelId = ANDROID_CHANNEL[p.kind];
  const group = groupOf(p);
  if (group) data.groupKey = group;
  return data;
}
