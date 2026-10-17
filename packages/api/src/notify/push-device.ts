/**
 * Native device push — Firebase Cloud Messaging (FCM)
 *
 * The Capacitor mobile shell (apps/mobile) cannot use Web Push reliably: iOS
 * only delivers Web Push to home-screen PWAs, not to a WKWebView. So the native
 * app registers an FCM token (DevicePushToken) and we deliver through FCM, which
 * reaches Android directly and iOS via APNs (an APNs auth key uploaded to the
 * Firebase project). One backend, both platforms.
 *
 * These senders are invoked from the gated `sendPushNotification` pipeline
 * (push.ts) — AFTER the shared suppression / quiet-hours / rate-limit gates, so
 * native push inherits the same delivery decisions as Web Push — and also
 * directly from the device-test route, which rings a real phone to confirm the
 * FCM/APNs path end to end.
 *
 * Environment:
 * - FIREBASE_SERVICE_ACCOUNT — the Firebase service-account JSON (as a string).
 *   Absent in dev / self-host without FCM → device push is skipped (logged),
 *   exactly like missing VAPID keys skips Web Push.
 */

import type { NativePushMailFields } from "@klorn/contract";
import { type App, cert, getApps, initializeApp } from "firebase-admin/app";
import { type BatchResponse, getMessaging, type Message } from "firebase-admin/messaging";
import { androidDataPushEnabled } from "../config.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import type { NotifCategory } from "./notification-prefs.js";

const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT || "";

// FCM error codes that mean the token is dead and should be pruned, not retried.
// Deliberately NOT including "messaging/invalid-argument": FCM returns it for a
// bad PAYLOAD too, not just a bad token, so a payload bug would mass-delete every
// valid token. Unknown failures are logged + kept (see the else branch below).
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

export interface DevicePushPayload {
  title: string;
  body: string;
  url?: string;
  notificationId?: string;
  /**
   * Mail deep link (native channels only — push.ts never hands these to web push
   * or Telegram). `emailId` is the Klorn EmailMessage id; it is what makes a push
   * "mail-driven": without it none of the fields below reach the device, so every
   * other push is byte-identical to before. `attentionItemId` is the open
   * firewall item, `pendingActionId` a reply draft / approval when one exists.
   */
  emailId?: string;
  attentionItemId?: string;
  pendingActionId?: string;
}

/** Opaque ids and an in-app route — nothing the notification text does not already show. */
export type MailPushTarget = NativePushMailFields;

/**
 * The mail deep link of a native push, or null for a push that is not about one
 * email. The route is the bundled app's reader path for that email.
 */
export function mailPushTarget(payload: DevicePushPayload): MailPushTarget | null {
  if (!payload.emailId) return null;
  return {
    emailId: payload.emailId,
    ...(payload.attentionItemId ? { attentionItemId: payload.attentionItemId } : {}),
    ...(payload.pendingActionId ? { pendingActionId: payload.pendingActionId } : {}),
    route: `/mail/${encodeURIComponent(payload.emailId)}`,
  };
}

export interface DevicePushSummary {
  status: "sent" | "skipped";
  reason?: string;
  tokens: number;
  accepted: number;
  failed: number;
}

// undefined = not yet attempted, null = unavailable (memoize both so we log once).
let firebaseApp: App | null | undefined;

function getFirebaseApp(): App | null {
  if (firebaseApp !== undefined) return firebaseApp;
  if (!FIREBASE_SERVICE_ACCOUNT) {
    console.log("[PUSH-DEVICE] FCM disabled — FIREBASE_SERVICE_ACCOUNT not set");
    firebaseApp = null;
    return firebaseApp;
  }
  try {
    const existing = getApps();
    if (existing.length > 0) {
      firebaseApp = existing[0] ?? null;
      return firebaseApp;
    }
    const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    firebaseApp = initializeApp({ credential: cert(serviceAccount) });
    console.log("[PUSH-DEVICE] FCM configured");
    return firebaseApp;
  } catch (err) {
    // A malformed FIREBASE_SERVICE_ACCOUNT must surface loudly — otherwise every
    // native push silently no-ops and "notifications don't work" is untraceable.
    // console.error so it shows even with Sentry off; captureError so it pages
    // when Sentry is on (a bad Render secret disables FCM for the whole deploy).
    console.error(
      "[PUSH-DEVICE] Failed to init Firebase Admin (check FIREBASE_SERVICE_ACCOUNT JSON):",
      err,
    );
    captureError(err, { tags: { scope: "push-device.init" } });
    firebaseApp = null;
    return firebaseApp;
  }
}

/** Whether FCM is configured (a valid service account is present). */
export function isDevicePushConfigured(): boolean {
  return getFirebaseApp() !== null;
}

function buildDataPayload(payload: DevicePushPayload): Record<string, string> {
  // FCM data values must be strings; drop undefined keys.
  const data: Record<string, string> = {};
  if (payload.url) data.url = payload.url;
  if (payload.notificationId) data.notificationId = payload.notificationId;
  return data;
}

/**
 * One FCM message. The keys a push always carried come first and unchanged;
 * a mail push then appends its deep link (all strings, as FCM requires).
 *
 * `dataOnly` (a device that registered `dataMessages: true`, while
 * ANDROID_DATA_PUSH_ENABLED is on): a MAIL push goes out with no
 * `notification` block — title and body move into `data`, plus `sentAt` (epoch
 * ms; the app drops a replay older than 15 min) — so the app's native service
 * posts it with action buttons (apps/mobile push/KlornMessagingService.java,
 * contract/src/push.ts). A push that is not about one mail never goes data-only.
 */
export function buildFcmMessage(
  token: string,
  payload: DevicePushPayload,
  category: NotifCategory,
  opts: { dataOnly?: boolean; now?: number } = {},
): Message {
  const mail = mailPushTarget(payload);
  if (opts.dataOnly && mail) {
    return {
      token,
      data: {
        ...buildDataPayload(payload),
        category,
        ...mail,
        title: payload.title,
        body: payload.body,
        sentAt: String(opts.now ?? Date.now()),
      },
      android: { priority: "high" },
    };
  }
  return {
    token,
    notification: { title: payload.title, body: payload.body },
    data: { ...buildDataPayload(payload), category, ...(mail ?? {}) },
    android: { priority: "high" },
  };
}

function skipped(reason: string): DevicePushSummary {
  return { status: "skipped", reason, tokens: 0, accepted: 0, failed: 0 };
}

/**
 * Send a push to a user's ANDROID devices via FCM. Prunes tokens FCM reports as
 * permanently dead. Best-effort: returns a summary and never throws — a callsite
 * should treat a thrown error here as a bug, not an expected path.
 *
 * iOS is deliberately excluded: @capacitor/push-notifications yields an APNs
 * token on iOS (not an FCM token), which FCM would reject as invalid-argument
 * and we would then wrongly prune. iOS delivery goes through push-apns.ts.
 */
export async function sendDevicePush(
  userId: string,
  payload: DevicePushPayload,
  category: NotifCategory = "system",
): Promise<DevicePushSummary> {
  const app = getFirebaseApp();
  if (!app) {
    console.log(`[PUSH-DEVICE] Skipped — FCM not configured (user ${userId})`);
    return skipped("missing_firebase_credentials");
  }

  const rows = await prisma.devicePushToken.findMany({
    where: { userId, platform: "android" },
    select: { token: true, dataMessages: true },
  });
  if (rows.length === 0) {
    return skipped("no_device_tokens");
  }

  const dataPush = androidDataPushEnabled();
  const messages: Message[] = rows.map((row) =>
    buildFcmMessage(row.token, payload, category, {
      dataOnly: dataPush && row.dataMessages === true,
    }),
  );

  // sendEach throws only on a TOTAL failure (network down, bad service-account
  // key, FCM quota). Treat that as best-effort: log + capture and return a skip
  // so a callsite (and the Phase 2 push-pipeline integration) is never broken by
  // FCM being down — but it must NOT go silent.
  let res: BatchResponse;
  try {
    res = await getMessaging(app).sendEach(messages);
  } catch (err) {
    console.error(`[PUSH-DEVICE] FCM sendEach failed (systemic) for ${userId}:`, err);
    captureError(err, {
      tags: { scope: "push-device.send" },
      extra: { userId, tokenCount: messages.length },
    });
    return skipped("fcm_error");
  }

  const deadTokens: string[] = [];
  const transientCodes: string[] = [];
  res.responses.forEach((r, i) => {
    if (r.success) return;
    const code = r.error?.code;
    const token = rows[i]?.token;
    if (token && code && DEAD_TOKEN_CODES.has(code)) {
      deadTokens.push(token);
    } else {
      // Transient/unknown failure — leave the token, but log a signal so a
      // systemic FCM problem (bad APNs key, quota) is visible, not swallowed.
      transientCodes.push(code ?? "unknown");
      console.error(`[PUSH-DEVICE] Send failed for user ${userId} (${code ?? "unknown"})`);
    }
  });

  // console.error alone is invisible when Sentry is the alerting channel. A
  // systemic FCM problem (bad service-account key, quota) surfaces as per-token
  // transient failures rather than a sendEach throw, so capture it once (not per
  // token, to avoid one Sentry event per device) so it actually pages.
  if (transientCodes.length > 0) {
    captureError(new Error(`FCM transient send failures (${transientCodes.length})`), {
      tags: { scope: "push-device.transient-failure" },
      extra: { userId, count: transientCodes.length, codes: transientCodes.slice(0, 20) },
    });
  }

  if (deadTokens.length > 0) {
    // Scope the delete to this user (least privilege) even though token is unique.
    await prisma.devicePushToken.deleteMany({ where: { userId, token: { in: deadTokens } } });
    console.log(`[PUSH-DEVICE] Pruned ${deadTokens.length} dead device token(s) for ${userId}`);
  }

  console.log(
    `[PUSH-DEVICE] Sent ${res.successCount}/${rows.length} device push(es) for ${userId}`,
  );
  return {
    status: "sent",
    tokens: rows.length,
    accepted: res.successCount,
    failed: res.failureCount,
  };
}
