/**
 * How a proactive action reaches the user: the bell row (deduped by key when
 * one is given), the live frame and the device push, with the push's kind and
 * preference category per notification type. Split from proactive-actions.ts.
 */

import type { NotificationKind, NotificationPresentation } from "@klorn/contract";
import { prisma } from "../db.js";
import { clampText } from "../notify/clamp-text.js";
import type { NotifCategory } from "../notify/notification-prefs.js";
import { sendPushNotification } from "../notify/push.js";
import { captureDbFailure, logDbFailure } from "../report-db-failure.js";
import { isUniqueViolation } from "../slack/unique-violation.js";
import { pushNotification } from "../websocket.js";

/** The push body cap (the bell row keeps the whole message). */
const PUSH_BODY_MAX = 200;

interface NotifyOptions {
  /** The device push's title when it should differ from the bell row's (NT0 copy). */
  pushTitle?: string;
  /** The device push's text when it should differ from the bell row's message. */
  pushBody?: string;
  /** NT0 structured fields; the type's kind (kindForType) when absent. */
  presentation?: NotificationPresentation;
  /**
   * The bell row's unique key: a second write under it fails on the
   * (userId, dedupeKey) unique, and nothing rings — so two overlapping ticks
   * cannot both notify.
   */
  dedupeKey?: string;
}

/** Create DB notification + WebSocket push + browser push. False when the dedupe key was taken. */
export async function notify(
  userId: string,
  type: string,
  title: string,
  message: string,
  url: string,
  opts: NotifyOptions = {},
): Promise<boolean> {
  const notification = await createBellRow(userId, type, title, message, url, opts.dedupeKey);
  if (!notification) return false;
  const kind = kindForType(type);
  const presentation = opts.presentation ?? (kind ? { kind } : undefined);

  pushNotification(userId, {
    id: notification.id,
    type,
    title,
    message,
    link: url,
    createdAt: notification.createdAt.toISOString(),
    ...(presentation ?? {}),
  });

  // Unawaited (best-effort) but guarded — an unhandled rejection from the push
  // internals would otherwise crash the single dyno.
  sendPushNotification(
    userId,
    {
      title: opts.pushTitle ?? title,
      body: clampText(opts.pushBody ?? message, PUSH_BODY_MAX),
      url,
      presentation,
    },
    categoryForType(type),
    // Heuristic-decided: ambient even for a "meeting" category (a back-to-back
    // warning is not a meeting starting), so it cannot use up the interrupt
    // room real meeting alerts and urgent mail need (push-bucket.ts).
    { bucket: "ambient" },
  ).catch((err) => {
    logDbFailure("[PROACTIVE] push failed", err, { ids: { userId } });
    captureDbFailure("[PROACTIVE] push failed", err, {
      tags: { scope: "proactive.push", userId },
    });
  });
  return true;
}

async function createBellRow(
  userId: string,
  type: string,
  title: string,
  message: string,
  url: string,
  dedupeKey: string | undefined,
): Promise<{ id: string; createdAt: Date } | null> {
  try {
    return await prisma.notification.create({
      data: { userId, type, title, message, link: url, ...(dedupeKey ? { dedupeKey } : {}) },
    });
  } catch (err) {
    if (dedupeKey && isUniqueViolation(err)) return null;
    throw err;
  }
}

/**
 * The NT0 kind of a proactive notification (contract NotificationKind). The
 * reply-wait reminders name theirs; a meeting prep is a meeting; the rest are
 * rule-based heads-ups, read like the briefing (passive).
 */
function kindForType(type: string): NotificationKind | undefined {
  switch (type) {
    case "calendar":
      return "meet";
    case "followup":
      return "digest";
    case "review":
    case "eod_review":
    case "task":
    case "deadline":
    case "schedule_warning":
      return "brief";
    default:
      return undefined;
  }
}

/** Preferences, quiet hours and label only; the push rings ambient regardless. */
function categoryForType(type: string): NotifCategory {
  switch (type) {
    case "calendar":
    case "schedule_warning":
      return "meeting";
    case "task":
    case "deadline":
      return "task_due";
    case "email_followup":
    case "followup":
      return "agent_proposal";
    case "review":
    case "eod_review":
      return "daily_briefing";
    default:
      return "system";
  }
}
