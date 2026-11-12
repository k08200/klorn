/**
 * Web Push — Send browser push notifications
 *
 * Uses the Web Push protocol to deliver notifications to subscribed browsers.
 * Requires VAPID keys (generate with: npx web-push generate-vapid-keys)
 *
 * Environment variables:
 * - VAPID_PUBLIC_KEY
 * - VAPID_PRIVATE_KEY
 * - VAPID_EMAIL (mailto: contact email)
 */

import crypto from "node:crypto";
import webPush from "web-push";
import { recordEvent } from "../analytics.js";
import { pushZombieEvictionEnabled } from "../config.js";
import { prisma } from "../db.js";
import { Semaphore } from "../semaphore.js";
import {
  type ChannelSendOutcome,
  type NativeSendSummary,
  nativeSendOutcome,
  recordChannelSend,
} from "./channel-delivery-log.js";
import { isSafePushEndpoint } from "./is-safe-push-endpoint.js";
import { type MailPushLane, mailPushReplyPath, mailPushWebActions } from "./mail-push-content.js";
import { notificationSuppressionReason } from "./notification-policy.js";
import { evaluateNotificationGate, type NotifCategory } from "./notification-prefs.js";
import { sendApnsPush } from "./push-apns.js";
import { type PushBucket, resolvePushBucket } from "./push-bucket.js";
import {
  createPushDeliveryAttempt,
  createSkippedPushDelivery,
  markPushAccepted,
  markPushFailed,
} from "./push-delivery.js";
import { sendDevicePush } from "./push-device.js";
import { mintPushLaterToken } from "./push-later-token.js";
import { isAllowedPushOrigin } from "./push-origin-allowlist.js";
import { recordPushAttempt } from "./push-rate-limit.js";
import { evaluateZombieSubscription } from "./push-zombie.js";
import { ssrfSafeHttpsAgent } from "./ssrf-safe-agent.js";
import { sendTelegramForPush } from "./telegram-notify.js";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL = process.env.VAPID_EMAIL || "mailto:k0820086@gmail.com";
const PUSH_RECEIPT_BASE_URL =
  process.env.PUSH_RECEIPT_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
const AGENT_PROPOSAL_PUSH_COOLDOWN_HOURS = 6;

// In-process retry with exponential backoff for transient FCM/WPS failures.
// We do NOT retry permanent failures (410 gone, 404 not found) — those mean
// the subscription is dead and gets cleaned up. We retry on 5xx, 429, and
// network errors, which empirically account for the bulk of "user said
// they didn't get the push" reports during dogfood (see memory:
// project_eve_dogfood_pain).
const PUSH_RETRY_DELAYS_MS = [3_000, 9_000]; // total ≤12s — bounded so the
// caller's tick doesn't stall.

// Fan-out concurrency: how many of a user's subscriptions we deliver to in
// parallel. Bounded so a user with many subscriptions during an upstream blip
// no longer serializes to N×(retry budget); one subscription's `await sleep`
// retry no longer blocks the others in the fire-and-forget judge path.
const PUSH_FANOUT_CONCURRENCY = 6;

export function shouldRetryPushError(statusCode: number | undefined): boolean {
  if (statusCode === undefined) return true; // network / no response
  if (statusCode >= 500 && statusCode < 600) return true;
  if (statusCode === 429) return true;
  return false;
}

// Budgeted-retry eviction threshold: after this many CONSECUTIVE ambiguous
// (non-410/404) delivery failures across pushes, a subscription is treated as
// dead and deleted, so it stops consuming the per-send retry budget every tick.
export const MAX_CONSECUTIVE_PUSH_FAILURES = 10;

export type PushFailureAction =
  | { kind: "delete"; reason: "expired" | "evicted" }
  | { kind: "increment"; failureCount: number };

/**
 * Decide what to do with a subscription after a failed delivery. A 410/404 is
 * definitively gone → delete. Otherwise count the consecutive failure; once it
 * reaches MAX_CONSECUTIVE_PUSH_FAILURES the endpoint has failed every push for
 * too long → evict it. A successful send resets the count (caller's job).
 */
export function decidePushFailureAction(
  currentFailureCount: number,
  statusCode: number | undefined,
): PushFailureAction {
  if (statusCode === 410 || statusCode === 404) {
    return { kind: "delete", reason: "expired" };
  }
  const next = currentFailureCount + 1;
  if (next >= MAX_CONSECUTIVE_PUSH_FAILURES) {
    return { kind: "delete", reason: "evicted" };
  }
  return { kind: "increment", failureCount: next };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  origin: string | null;
  failureCount: number;
  needsResubscribeAt?: Date | null;
}

export interface PushSendOptions {
  /**
   * The rate bucket this push rings against. Omitted means ambient. Only the
   * callers pinned in __tests__/push-interrupt-callers-guard.test.ts may ask
   * for "interrupt"; agent-originated pushes pass "ambient" explicitly. Pass it
   * as a literal object so that guard can read it (push-bucket.ts).
   */
  bucket?: PushBucket;
}

export interface PushSendSummary {
  status: "sent" | "skipped";
  reason?: string;
  subscriptions: number;
  attempted: number;
  accepted: number;
  failed: number;
}

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log("[PUSH] Web Push configured");
} else {
  console.log("[PUSH] Web Push disabled — missing VAPID keys");
}

/** Send push notification to all subscriptions of a user */
/**
 * Maps a push category to the "adjudicated surface" token that
 * notificationSuppressionReason treats as authored (skips the inbound-mail
 * noise heuristic). Only surfaces the system has already decided to interrupt
 * on qualify — the briefing (author-controlled body) and email_urgent (the
 * firewall judge / URGENT classifier already tiered it PUSH). Everything else
 * stays subject to the noise + housekeeping filters.
 */
export function authoredSurface(category: NotifCategory): "briefing" | "firewall" | null {
  if (category === "daily_briefing") return "briefing";
  if (category === "email_urgent") return "firewall";
  // email_candidate is an explicitly firewall-decided interrupt (candidate
  // materials), not inbound noise — author it as a firewall surface like the
  // other urgent surfaces, else the noise heuristic can suppress it.
  if (category === "email_candidate") return "firewall";
  // meeting is a first-party calendar interrupt (a starting-in-N-min alert),
  // not inbound mail — author it so a summary that collides with a noise
  // keyword ("confirm your…", "sale") is not silently suppressed at the gate.
  if (category === "meeting") return "firewall";
  return null;
}

export async function sendPushNotification(
  userId: string,
  payload: {
    title: string;
    body: string;
    url?: string;
    notificationId?: string;
    // AttentionItem id, when the interrupt maps 1:1 to a firewall item.
    // Lets secondary channels (Telegram) attach tier-override buttons.
    attentionItemId?: string;
    // Mail deep link for the NATIVE channels only (push-device.ts
    // mailPushTarget): the Klorn EmailMessage id of a mail-driven interrupt and
    // the reply draft / approval when one exists. Stripped before web push and
    // Telegram, so their payloads are exactly what they were.
    emailId?: string;
    pendingActionId?: string;
    // The bell row (Notification id) this push rings for, sent to WEB push
    // only: the service worker tags its OS notification with it, the same tag
    // an open tab gives its own notification for that row, so the two never
    // stack. Not `notificationId`: that one is also written to the delivery
    // log, where phone escalation keys on it.
    bellNotificationId?: string;
    // Decision N1: the lane of a notification about ONE mail (with `emailId`),
    // and the user's notification language for the action titles. Picks the
    // action set: web push gets Reply + Later (PUSH) or Later (MEETING); the
    // native channels get the lane (APNs category, Android data). Never sent
    // to Telegram, and never serialized into the web payload as such.
    lane?: MailPushLane;
    language?: string;
    // A reminder the user set themselves (the mail "Later",
    // pim/reminder-scheduler.ts): its title quotes a mail subject the user
    // chose to be reminded of, so the inbound-mail noise heuristic must not
    // veto it. Every other gate still applies. Never sent to a channel.
    userSet?: boolean;
  },
  category: NotifCategory = "system",
  options: PushSendOptions = {},
): Promise<PushSendSummary> {
  const {
    emailId,
    pendingActionId,
    bellNotificationId,
    lane,
    language,
    userSet,
    ...channelPayload
  } = payload;
  const nativePayload = {
    ...channelPayload,
    ...(emailId ? { emailId } : {}),
    ...(pendingActionId ? { pendingActionId } : {}),
    ...(emailId && lane ? { lane } : {}),
  };
  const webPayload = {
    ...channelPayload,
    ...(bellNotificationId ? { bellNotificationId } : {}),
    ...webMailActionFields(userId, emailId, lane, language),
  };
  // First line of defense: drop housekeeping + noise pushes BEFORE any
  // other check. Six other modules call this function (briefing,
  // reminder-scheduler, automation-scheduler, proactive-actions,
  // background, autonomous-agent). Patching each one is whack-a-mole;
  // the policy check belongs here.
  //
  // Anchored to the 2026-05-31 prod incident: 5 identical phone pushes
  // ("[Klorn] Action complete — mark read finished") from the LOW-risk
  // auto-exec path that PR #456's notify_user-tool guard did not cover.
  const suppression = notificationSuppressionReason({
    title: payload.title,
    message: payload.body,
    // category is a routing/preference dimension; we co-opt it as the
    // adjudicated-surface hint so content the system already decided to
    // interrupt on bypasses the inbound-mail noise heuristic.
    notificationType: userSet ? "reminder" : authoredSurface(category),
  });
  if (suppression) {
    // Log the category, never payload.title — the title is "Klorn — {sender}"
    // for mail interrupts, i.e. a third party's identity + evidence of the
    // user's private correspondence, which must not reach stdout/log drains.
    console.log(`[PUSH] Suppressed (${suppression}) for ${userId} (${category})`);
    await recordSkipped(userId, payload.title, category, `policy_${suppression}`);
    return skipped(`policy_${suppression}`);
  }

  // Respect per-user category preferences and quiet hours. Quiet hours get
  // their own skipReason so PushDeliveryLog can tell "user opted out of this
  // category" apart from "user is asleep". Either way the browser stays
  // silent while the upstream Notification row keeps the event in the bell.
  // (The VAPID check runs later, after the Telegram send, so a
  // Telegram-only self-host without VAPID keys still gets interrupts.)
  // PUSH mail held by quiet hours rings once after they end, read back from
  // that bell row (quiet-hours-summary.ts).
  const gate = await evaluateNotificationGate(userId, category);
  if (!gate.allowed) {
    console.log(`[PUSH] Suppressed (${gate.reason}) for ${userId} (${category})`);
    await recordSkipped(userId, payload.title, category, gate.reason);
    return skipped(gate.reason);
  }

  if (category === "agent_proposal") {
    const cooldownHit = await hasRecentAgentProposalPush(userId);
    if (cooldownHit) {
      console.log(`[PUSH] Suppressed agent proposal cooldown for ${userId} (${category})`);
      await recordSkipped(userId, payload.title, category, "agent_proposal_cooldown");
      return skipped("agent_proposal_cooldown");
    }
  }

  // Per-user rate limit (Postgres-backed, survives deploys) in two buckets.
  // The caller picks the bucket, not the category: the firewall's PUSH and
  // MEETING mail, the urgent sweep, meeting alerts and reminders ask for an
  // interrupt bucket that briefings, proposals and every agent-originated push
  // ring ambient beside and can never use up (push-bucket.ts).
  // Blocks the phone ring only; the DB notification is already persisted
  // upstream so the bell still surfaces this event. The skipReason names the
  // bucket that refused.
  const bucket = resolvePushBucket(options.bucket);
  const rate = await recordPushAttempt(userId, bucket);
  if (!rate.allowed) {
    console.log(`[PUSH] Rate-limited (${bucket}) for ${userId} (${category}): ${rate.reason}`);
    await recordSkipped(
      userId,
      payload.title,
      category,
      `rate_limited_${bucket}:${rate.reason ?? "unknown"}`,
    );
    return skipped("rate_limited");
  }

  // Secondary channel: Telegram (best-effort). Runs AFTER the shared gates
  // above so it inherits exactly the same suppression decisions as web push,
  // and BEFORE the VAPID check so a Telegram-only self-hoster (no VAPID keys,
  // no browser subscriptions) still gets PUSH-tier interrupts. Contained:
  // sendTelegramForPush never throws by design, and the .catch is a second
  // belt so a bug there can never fail the web-push path.
  const telegramQueuedAt = new Date();
  const telegram = await sendTelegramForPush(userId, channelPayload, category).catch((err) => {
    // Defense-in-depth: sendTelegramForPush is designed never to throw and
    // logs/captures its own failures. If it ever does throw, this must not
    // sink the web-push path below — but don't swallow it silently either,
    // or a Telegram-only self-hoster loses every PUSH alert with no trace.
    console.warn(`[PUSH] Telegram secondary channel threw for ${userId}:`, err);
    return "failed" as const;
  });
  // Delivery lifecycle: a Telegram send that went out (or failed) is one
  // channel attempt; "skipped" (not linked / not configured) is none.
  if (telegram === "sent" || telegram === "failed") {
    await recordChannelSend({
      ...channelRecordBase(userId, channelPayload, category),
      channel: "telegram",
      outcome:
        telegram === "sent" ? { status: "sent" } : { status: "failed", reason: "telegram_error" },
      queuedAt: telegramQueuedAt,
    });
  }

  // Native mobile channels (Capacitor shell): FCM for Android, APNs for iOS.
  // Best-effort and in ADDITION to web push, running after the shared gates
  // above so they inherit the same suppression/quiet-hours/rate-limit decisions.
  // Contained like Telegram: a device-channel fault must never sink web push.
  // Each is a no-op (logged skip) when its credentials/tokens are absent.
  // FCM (Android) and APNs (iOS) are independent — run in parallel. Fire them
  // WITHOUT awaiting so a slow/stalled APNs http2 handshake (fresh session +
  // 10s per-request timeout) never stacks latency onto the primary web-push
  // path below. Each has its own .catch, so no unhandled rejection escapes.
  const nativeQueuedAt = new Date();
  const recordNative = (channel: "fcm" | "apns") => (summary: NativeSendSummary | undefined) =>
    recordNativeOutcome(channel, nativeSendOutcome(summary), {
      ...channelRecordBase(userId, channelPayload, category),
      queuedAt: nativeQueuedAt,
    });
  void Promise.all([
    sendDevicePush(userId, nativePayload, category)
      .then(recordNative("fcm"))
      .catch((err) => {
        console.warn(`[PUSH] FCM device channel threw for ${userId}:`, err);
      }),
    sendApnsPush(userId, nativePayload, category)
      .then(recordNative("apns"))
      .catch((err) => {
        console.warn(`[PUSH] APNs device channel threw for ${userId}:`, err);
      }),
  ]);

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.log(`[PUSH] Skipped — VAPID keys not configured`);
    await recordSkipped(userId, payload.title, category, "missing_vapid_keys");
    return skipped("missing_vapid_keys");
  }

  const allSubscriptions = (await prisma.pushSubscription.findMany({
    where: { userId },
  })) as PushSubscriptionRow[];

  // Skip subs whose SW origin is no longer in the allowlist. Their SW would
  // openWindow() to a domain we no longer serve. NULL origins are pre-migration
  // rows of unknown provenance — treat as stale and let cleanup-stale-push-subs
  // delete them.
  const subscriptions = allSubscriptions.filter((sub) => isAllowedPushOrigin(sub.origin));
  const droppedForOrigin = allSubscriptions.length - subscriptions.length;
  if (droppedForOrigin > 0) {
    console.log(
      `[PUSH] Skipping ${droppedForOrigin} sub(s) for ${userId} with disallowed/missing origin`,
    );
  }

  // Zombie subscriptions (push-zombie.ts): flagged rows get no more pushes
  // once PUSH_ZOMBIE_EVICTION is on. "Send test" does not come through here,
  // so it still reaches them and a receipt can clear the flag.
  const live = pushZombieEvictionEnabled()
    ? subscriptions.filter((sub) => !sub.needsResubscribeAt)
    : subscriptions;
  const parked = subscriptions.length - live.length;
  if (parked > 0) {
    console.log(`[PUSH] Skipping ${parked} sub(s) for ${userId} that need re-subscribe`);
  }

  if (live.length === 0) {
    const reason = parked > 0 ? "subscriptions_need_resubscribe" : "no_subscriptions";
    console.log(`[PUSH] No live push subscriptions for user ${userId} — browser push skipped`);
    await recordSkipped(userId, payload.title, category, reason);
    return skipped(reason);
  }
  // Category only, never payload.title (== "Klorn — {sender}" for mail) — this
  // fires on every successful send, so it is the highest-volume leak of the
  // three suppression-path lines already redacted above.
  console.log(`[PUSH] Sending to ${live.length} subscription(s) for ${userId} (${category})`);

  // Fan out with bounded concurrency (same Semaphore util gmail-fetch.ts uses).
  // sem.all preserves per-thunk isolation as long as no thunk throws — and
  // deliverToSubscription is total (it catches per-attempt), so one sub's
  // failure or retry-sleep never sinks or blocks the others, mirroring the old
  // serial loop's `continue`.
  const sem = new Semaphore(PUSH_FANOUT_CONCURRENCY);
  const results = await sem.all(
    live.map((sub) => () => deliverToSubscription(userId, sub, webPayload, category)),
  );
  const attempted = results.filter((r) => r.attempted).length;
  const accepted = results.filter((r) => r.delivered).length;
  const failed = attempted - accepted;

  console.log(`[PUSH] Sent ${accepted}/${attempted} push notifications successfully`);
  // Retention analytics: count a real delivery as the open-rate denominator.
  if (accepted > 0) void recordEvent(userId, "push_sent", { category });
  return {
    status: "sent",
    subscriptions: live.length,
    attempted,
    accepted,
    failed,
  };
}

/**
 * Deliver one push to one subscription: unsafe-endpoint skip, delivery-attempt
 * log, bounded in-process retry, accept/fail marking, failure-count reset on
 * recover, and budgeted eviction (410/404 delete + atomic increment + threshold
 * evict). Total by design — never throws — so a bounded-concurrency fan-out over
 * these stays failure-isolated like the old serial loop's `continue`.
 *
 * (Slightly over the 50-line guideline: this is the extracted per-subscription
 * body kept verbatim rather than over-split, to preserve behavior exactly.)
 */
async function deliverToSubscription(
  userId: string,
  sub: PushSubscriptionRow,
  payload: {
    title: string;
    body: string;
    url?: string;
    notificationId?: string;
    attentionItemId?: string;
    bellNotificationId?: string;
  } & WebMailActionFields,
  category: NotifCategory,
): Promise<{ attempted: boolean; delivered: boolean; deliveryId: string | null }> {
  if (!isSafePushEndpoint(sub.endpoint)) {
    await recordSkipped(userId, payload.title, category, "unsafe_endpoint");
    return { attempted: false, delivered: false, deliveryId: null };
  }
  const deliveryId = await createPushDeliveryAttempt({
    userId,
    subscriptionId: sub.id,
    endpoint: sub.endpoint,
    notificationId: payload.notificationId ?? null,
    category,
    title: payload.title,
  });

  // Stable, ≤32-char, URL/filename-safe topic derived from deliveryId. Constant
  // across this subscription's retries, so after an AMBIGUOUS failure (e.g. a
  // network timeout where the message was actually delivered) the push service
  // REPLACES the still-pending message instead of stacking a duplicate. This
  // only dedupes within the service's pending-delivery window — not a full
  // guarantee — and complements the app-level dedup done elsewhere.
  const topic = crypto.createHash("sha256").update(deliveryId).digest("base64url").slice(0, 32);

  let lastStatusCode: number | undefined;
  let lastBody: string | undefined;
  let lastError: unknown;
  let delivered = false;
  const maxAttempts = 1 + PUSH_RETRY_DELAYS_MS.length;
  // Lifecycle "queued": the first attempt is handed to the push service now.
  const queuedAt = new Date();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify({
          ...payload,
          deliveryId,
          receiptUrl: pushReceiptUrl(deliveryId),
        }),
        // agent: re-validates the resolved IP at connect time (SSRF / DNS
        // rebinding) — the hostname-string check alone can't catch a public
        // name that resolves to an internal address.
        { topic, agent: ssrfSafeHttpsAgent },
      );
      delivered = true;
      if (attempt > 0) {
        console.log(`[PUSH] Recovered on retry ${attempt} for subscription ${sub.id}`);
      }
      break;
    } catch (err) {
      lastError = err;
      lastStatusCode = (err as { statusCode?: number })?.statusCode;
      lastBody = (err as { body?: string })?.body;
      // Permanent failures: stop retrying so we can clean up below.
      if (!shouldRetryPushError(lastStatusCode)) break;
      const nextDelay = PUSH_RETRY_DELAYS_MS[attempt];
      if (nextDelay === undefined) break;
      console.warn(
        `[PUSH] Transient failure status=${lastStatusCode ?? "network"} for ${sub.id}; retrying in ${nextDelay}ms`,
      );
      await sleep(nextDelay);
    }
  }

  if (delivered) {
    await markPushAccepted(deliveryId, new Date(), queuedAt);
    // Recovered: clear the consecutive-failure tally so a sub that had a
    // transient bad spell isn't evicted on a later push.
    if (sub.failureCount > 0) {
      await prisma.pushSubscription.update({
        where: { id: sub.id },
        data: { failureCount: 0, lastFailedAt: null },
      });
    }
    await checkZombie(sub.id);
    return { attempted: true, delivered: true, deliveryId };
  }

  await markPushFailed(deliveryId, { statusCode: lastStatusCode, body: lastBody }, queuedAt);
  console.error(
    `[PUSH] Failed to send to subscription ${sub.id} after ${maxAttempts} attempts: status=${lastStatusCode}, body=${lastBody}, error=${lastError}`,
  );
  // Budgeted eviction: 410/404 → delete now; otherwise count the consecutive
  // failure and delete once it crosses the threshold (stops a dead endpoint
  // from burning the retry budget every tick).
  const action = decidePushFailureAction(sub.failureCount, lastStatusCode);
  if (action.kind === "delete") {
    await prisma.pushSubscription.delete({ where: { id: sub.id } });
    console.log(
      `[PUSH] Removed ${action.reason} subscription ${sub.id} (failureCount=${sub.failureCount})`,
    );
  } else {
    // Increment ATOMICALLY — sub.failureCount is from a findMany snapshot, so
    // two pushes to the same sub in one tick would otherwise both write the
    // same absolute value and lose a failure. Re-check the threshold on the
    // fresh value so eviction can't be delayed by a stale read.
    const updated = await prisma.pushSubscription.update({
      where: { id: sub.id },
      data: { failureCount: { increment: 1 }, lastFailedAt: new Date() },
      select: { failureCount: true },
    });
    if (updated.failureCount >= MAX_CONSECUTIVE_PUSH_FAILURES) {
      await prisma.pushSubscription.delete({ where: { id: sub.id } });
      console.log(
        `[PUSH] Evicted subscription ${sub.id} after ${updated.failureCount} consecutive failures`,
      );
    }
  }
  return { attempted: true, delivered: false, deliveryId };
}

/**
 * An accepted push extends this subscription's run of unconfirmed pushes:
 * flag it when the run makes it a zombie (push-zombie.ts). Only when pushes
 * carry a receipt URL — without one no receipt can ever arrive, and every
 * subscription would be flagged. Never fails the push.
 */
async function checkZombie(subscriptionId: string): Promise<void> {
  if (!PUSH_RECEIPT_BASE_URL) return;
  try {
    await evaluateZombieSubscription(subscriptionId);
  } catch (err) {
    console.warn(`[PUSH] Zombie check failed for subscription ${subscriptionId}:`, err);
  }
}

/** The per-notification fields every FCM / APNs / Telegram row carries. */
function channelRecordBase(
  userId: string,
  payload: { title: string; notificationId?: string },
  category: NotifCategory,
) {
  return {
    userId,
    notificationId: payload.notificationId ?? null,
    category,
    title: payload.title,
  };
}

async function recordNativeOutcome(
  channel: "fcm" | "apns",
  outcome: ChannelSendOutcome | null,
  base: ReturnType<typeof channelRecordBase> & { queuedAt: Date },
): Promise<void> {
  if (!outcome) return;
  await recordChannelSend({ ...base, channel, outcome });
}

export type TestPushResult =
  | { status: "not_found" }
  | { status: "skipped"; reason: string; delivered: false }
  | { status: "sent"; delivered: boolean; deliveryId: string };

/**
 * "Send test" on one row of settings → Where you get alerts (N8): one push to
 * one of the caller's subscriptions.
 *
 * Deliberately NOT routed through sendPushNotification's gates: the noise
 * policy, category preferences, quiet hours, the agent-proposal cooldown and
 * the per-user ambient/interrupt rate buckets all exist to keep Klorn from
 * interrupting unasked — and this push IS the ask (the user pressed the
 * button, and a test muted by their own quiet hours would wrongly read as
 * "this device is broken"). It also never fans out to Telegram or native
 * devices. What still applies: the route's per-user rate limit
 * (routes/alert-endpoints.ts), ownership (userId-scoped lookup), the origin
 * allowlist, the SSRF endpoint check and the delivery log + eviction of
 * deliverToSubscription, so a dead endpoint found by a test is cleaned up
 * exactly as a real push would.
 */
export async function sendTestPushToSubscription(
  userId: string,
  subscriptionId: string,
  payload: { title: string; body: string; url: string },
): Promise<TestPushResult> {
  const sub = (await prisma.pushSubscription.findFirst({
    where: { id: subscriptionId, userId },
  })) as PushSubscriptionRow | null;
  if (!sub) return { status: "not_found" };
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return { status: "skipped", reason: "missing_vapid_keys", delivered: false };
  }
  if (!isAllowedPushOrigin(sub.origin)) {
    return { status: "skipped", reason: "origin_not_allowed", delivered: false };
  }
  const result = await deliverToSubscription(userId, sub, payload, "system");
  if (!result.attempted || !result.deliveryId) {
    return { status: "skipped", reason: "unsafe_endpoint", delivered: false };
  }
  return { status: "sent", delivered: result.delivered, deliveryId: result.deliveryId };
}

/** Get the public VAPID key for client-side subscription */
export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

function skipped(reason: string): PushSendSummary {
  return { status: "skipped", reason, subscriptions: 0, attempted: 0, accepted: 0, failed: 0 };
}

async function recordSkipped(
  userId: string,
  title: string,
  category: NotifCategory,
  skipReason: string,
): Promise<void> {
  await createSkippedPushDelivery({ userId, category, title, skipReason });
}

function pushReceiptUrl(deliveryId: string): string | null {
  if (!PUSH_RECEIPT_BASE_URL) return null;
  return `${PUSH_RECEIPT_BASE_URL.replace(/\/+$/, "")}/api/notifications/push/receipts/${deliveryId}`;
}

function laterUrl(): string | null {
  if (!PUSH_RECEIPT_BASE_URL) return null;
  return `${PUSH_RECEIPT_BASE_URL.replace(/\/+$/, "")}/api/notifications/push/later`;
}

interface WebMailActionFields {
  actions?: ReturnType<typeof mailPushWebActions>;
  replyUrl?: string;
  laterUrl?: string;
  laterToken?: string;
}

/**
 * The web push action buttons of a notification about one mail (decision N1).
 * Reply opens the reader with the composer focused (a same-origin path; the
 * service worker refuses anything else). Later posts the push-later token, a
 * capability for exactly this (user, email), to the API. Without a base URL
 * Later cannot be wired, so only Reply is offered. A push without a lane or an
 * email id gets {}: no buttons, exactly as a non-mail push always had.
 */
function webMailActionFields(
  userId: string,
  emailId: string | undefined,
  lane: MailPushLane | undefined,
  language: string | undefined,
): WebMailActionFields {
  if (!emailId || !lane) return {};
  const url = laterUrl();
  const actions = mailPushWebActions(lane, language ?? "en").filter(
    (a) => a.action !== "later" || url !== null,
  );
  if (actions.length === 0) return {};
  return {
    actions,
    ...(actions.some((a) => a.action === "reply") ? { replyUrl: mailPushReplyPath(emailId) } : {}),
    ...(url ? { laterUrl: url, laterToken: mintPushLaterToken(userId, emailId) } : {}),
  };
}

async function hasRecentAgentProposalPush(userId: string): Promise<boolean> {
  const since = new Date(Date.now() - AGENT_PROPOSAL_PUSH_COOLDOWN_HOURS * 60 * 60 * 1000);
  const recent = await prisma.pushDeliveryLog.findFirst({
    where: {
      userId,
      // Web push only, as before other channels wrote rows: an FCM row must
      // not start a cooldown that web push alone would not have.
      channel: "web",
      category: "agent_proposal",
      status: { in: ["PENDING", "ACCEPTED"] },
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  return !!recent;
}
