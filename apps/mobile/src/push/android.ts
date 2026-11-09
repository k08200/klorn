/**
 * Android notification actions, pure part. `@capacitor/push-notifications`
 * cannot put action buttons on an FCM *notification* message, so for a
 * data-only FCM message carrying Klorn's payload the app posts the
 * notification itself through `@capacitor/local-notifications`
 * (platform/local-notify.ts) with the decision-N1 actions (2026-11-08) —
 * 나중에 · 급하지 않음 · 처리 완료 (Later · Not urgent · Done), Later only
 * for a MEETING mail. Nothing is ever sent from a notification, on Android
 * either; a tap opens the mail.
 *
 * The keys are the ones the server already puts in FCM `data`
 * (packages/api notify/push-device.ts buildFcmMessage; contract/src/push.ts),
 * plus the title and body, which a data-only message must carry in `data`
 * because it has no `notification` block. Every value is a string:
 *
 *   { "data": { "title", "body",                    // required for data-only
 *               "category",                          // the server's NotifCategory
 *               "url", "notificationId",             // as on every push
 *               "emailId", "route",                  // a mail push
 *               "attentionItemId", "pendingActionId",// when they exist
 *               "lane",                              // "PUSH" | "MEETING" (N1)
 *               "sentAt" },                          // optional, epoch ms
 *     "android": { "priority": "high" } }            // and NO "notification" key
 *
 * The action set follows the ids, as the server picks the APNs category:
 * a `pendingActionId` → the draft set, else a MEETING mail → the meeting set,
 * else a mail (`emailId`, or an `attentionItemId` alone) → the plain set, else
 * no buttons (a tap still routes). `category: "email_urgent"` (a PUSH-lane mail) rings on the
 * high-importance channel. See README "Push payload" for what works in which
 * app state (a data-only message reaches the app only while its process is
 * alive). The server sends notification messages today, which the OS shows
 * by itself (no buttons) and this module leaves alone.
 */
import type { ApnsMailCategory } from "@klorn/contract";
import type { PushData } from "./route";
import { PUSH_ACTIONS } from "./route";

/** Android notification channels (created at launch; importance is the user's afterwards). */
export const ANDROID_CHANNELS = {
  /** PUSH-lane mail: IMPORTANCE_HIGH (heads-up, sound). */
  push: { id: "klorn_push", importance: 4 },
  /** Everything else Klorn sends (MEETING, briefings): IMPORTANCE_DEFAULT. */
  other: { id: "klorn_other", importance: 3 },
} as const;

export type AndroidChannelId = (typeof ANDROID_CHANNELS)[keyof typeof ANDROID_CHANNELS]["id"];

/**
 * Action sets, by the same category ids the server sends as APNs `aps.category`
 * and iOS registers (AppDelegate.swift) — contract/src/push.ts ApnsMailCategory.
 */
export const ACTION_CATEGORIES = {
  withDraft: "KLORN_PUSH_MAIL_DRAFT",
  plain: "KLORN_PUSH_MAIL",
  meeting: "KLORN_PUSH_MEETING",
} as const satisfies Record<string, ApnsMailCategory>;

export type ActionCategory = (typeof ACTION_CATEGORIES)[keyof typeof ACTION_CATEGORIES];

/** The server's NotifCategory of a PUSH-lane mail (judge/email-firewall.ts). */
const URGENT_MAIL_CATEGORY = "email_urgent";

/** A data-only message older than this is a replay (the plugin re-fires its last message on launch). */
export const STALE_AFTER_MS = 15 * 60_000;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TITLE_MAX = 120;
const BODY_MAX = 600;

export interface IncomingMessage {
  /** Set when FCM carried a `notification` block (the OS showed it already). */
  title?: string | null;
  data: PushData;
}

export interface DataPush {
  /** Stable per mail / item, so a repeat replaces the notification instead of stacking. */
  notificationId: number;
  title: string;
  body: string;
  /** Which action set; null = no buttons (a tap still routes). */
  category: ActionCategory | null;
  channelId: AndroidChannelId;
  /** Only the validated fields, handed back on tap / action (push/route.ts reads them). */
  data: PushData;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function id(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

/** 31-bit positive FNV-1a hash — Android notification ids are Java ints. */
export function notificationIdOf(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 1 || 1;
}

/**
 * The notification to post for a data-only Klorn message, or null: a
 * notification message (the OS displayed it), a payload without a title and
 * body, or a stale replay. Everything is external input and validated.
 */
export function parseDataPush(message: IncomingMessage, now: number): DataPush | null {
  if (message.title) return null;
  const data = message.data ?? {};
  const title = text(data.title, TITLE_MAX);
  const body = text(data.body, BODY_MAX);
  if (!title || !body) return null;

  const sentAt = typeof data.sentAt === "string" ? Number(data.sentAt) : Number.NaN;
  if (Number.isFinite(sentAt) && now - sentAt > STALE_AFTER_MS) return null;

  const emailId = id(data.emailId);
  const attentionItemId = id(data.attentionItemId);
  const pendingActionId = id(data.pendingActionId);
  const lane = data.lane === "MEETING" || data.lane === "PUSH" ? data.lane : null;
  const isMail = Boolean(emailId || attentionItemId);
  // Derived from the ids and the lane, never from `category` (that is the NotifCategory).
  const category: ActionCategory | null = pendingActionId
    ? ACTION_CATEGORIES.withDraft
    : isMail && lane === "MEETING"
      ? ACTION_CATEGORIES.meeting
      : isMail
        ? ACTION_CATEGORIES.plain
        : null;
  const isPush = data.category === URGENT_MAIL_CATEGORY;

  const kept: PushData = {};
  if (emailId) kept.emailId = emailId;
  if (attentionItemId) kept.attentionItemId = attentionItemId;
  if (pendingActionId) kept.pendingActionId = pendingActionId;
  if (typeof data.route === "string") kept.route = data.route;
  if (typeof data.url === "string") kept.url = data.url;
  if (lane) kept.lane = lane;

  return {
    notificationId: notificationIdOf(
      attentionItemId ?? emailId ?? pendingActionId ?? `${title}\n${body}`,
    ),
    title,
    body,
    category,
    channelId: isPush ? ANDROID_CHANNELS.push.id : ANDROID_CHANNELS.other.id,
    data: kept,
  };
}

export interface ActionLabels {
  later: string;
  notUrgent: string;
  done: string;
}

/**
 * The action types to register, in the order Android shows the buttons
 * (decision N1): Later · Not urgent · Done; a MEETING mail gets Later only.
 * There is no Send and no Silent; a tap opens the mail (or the draft's
 * approval card).
 */
export function androidActionTypes(labels: ActionLabels) {
  const later = { id: PUSH_ACTIONS.later, title: labels.later };
  const notUrgent = { id: PUSH_ACTIONS.notUrgent, title: labels.notUrgent };
  const done = { id: PUSH_ACTIONS.done, title: labels.done };
  return [
    { id: ACTION_CATEGORIES.withDraft, actions: [later, notUrgent, done] },
    { id: ACTION_CATEGORIES.plain, actions: [later, notUrgent, done] },
    { id: ACTION_CATEGORIES.meeting, actions: [later] },
  ];
}
