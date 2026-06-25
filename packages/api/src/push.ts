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

import webPush from "web-push";
import { prisma } from "./db.js";
import { isSafePushEndpoint } from "./is-safe-push-endpoint.js";
import { notificationSuppressionReason } from "./notification-policy.js";
import { evaluateNotificationGate, type NotifCategory } from "./notification-prefs.js";
import {
  createPushDeliveryAttempt,
  createSkippedPushDelivery,
  markPushAccepted,
  markPushFailed,
} from "./push-delivery.js";
import { isAllowedPushOrigin } from "./push-origin-allowlist.js";
import { recordPushAttempt } from "./push-rate-limit.js";
import { sendTelegramForPush } from "./telegram-notify.js";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL = process.env.VAPID_EMAIL || "mailto:hello@klorn.ai";
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

export function shouldRetryPushError(statusCode: number | undefined): boolean {
  if (statusCode === undefined) return true; // network / no response
  if (statusCode >= 500 && statusCode < 600) return true;
  if (statusCode === 429) return true;
  return false;
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
 * on qualify — the briefing (author-controlled body), email_urgent (the
 * firewall judge / URGENT classifier already tiered it PUSH), and github_urgent
 * (the firewall judge tiered a GitHub thread PUSH). Everything else stays
 * subject to the noise + housekeeping filters.
 */
export function authoredSurface(category: NotifCategory): "briefing" | "firewall" | null {
  if (category === "daily_briefing") return "briefing";
  if (category === "email_urgent") return "firewall";
  if (category === "github_urgent") return "firewall";
  // email_candidate is an explicitly firewall-decided interrupt (candidate
  // materials), not inbound noise — author it as a firewall surface like the
  // other urgent surfaces, else the noise heuristic can suppress it.
  if (category === "email_candidate") return "firewall";
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
  },
  category: NotifCategory = "system",
): Promise<PushSendSummary> {
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
    notificationType: authoredSurface(category),
  });
  if (suppression) {
    console.log(`[PUSH] Suppressed (${suppression}) for ${userId}: "${payload.title}"`);
    await recordSkipped(userId, payload.title, category, `policy_${suppression}`);
    return skipped(`policy_${suppression}`);
  }

  // Respect per-user category preferences and quiet hours. Quiet hours get
  // their own skipReason so PushDeliveryLog can tell "user opted out of this
  // category" apart from "user is asleep". Either way the browser stays
  // silent while the upstream Notification row keeps the event in the bell.
  // (The VAPID check runs later, after the Telegram send, so a
  // Telegram-only self-host without VAPID keys still gets interrupts.)
  const gate = await evaluateNotificationGate(userId, category);
  if (!gate.allowed) {
    console.log(`[PUSH] Suppressed (${gate.reason}) for ${userId} (${category})`);
    await recordSkipped(userId, payload.title, category, gate.reason);
    return skipped(gate.reason);
  }

  if (category === "agent_proposal") {
    const cooldownHit = await hasRecentAgentProposalPush(userId);
    if (cooldownHit) {
      console.log(`[PUSH] Suppressed agent proposal cooldown for ${userId}: "${payload.title}"`);
      await recordSkipped(userId, payload.title, category, "agent_proposal_cooldown");
      return skipped("agent_proposal_cooldown");
    }
  }

  // Global per-user rate limit (Postgres-backed, survives deploys) — blocks
  // phone ring; DB notification is already persisted upstream so the bell
  // still surfaces this event.
  const rate = await recordPushAttempt(userId);
  if (!rate.allowed) {
    console.log(`[PUSH] Rate-limited for ${userId}: ${rate.reason} — "${payload.title}"`);
    await recordSkipped(
      userId,
      payload.title,
      category,
      `rate_limited:${rate.reason ?? "unknown"}`,
    );
    return skipped("rate_limited");
  }

  // Secondary channel: Telegram (best-effort). Runs AFTER the shared gates
  // above so it inherits exactly the same suppression decisions as web push,
  // and BEFORE the VAPID check so a Telegram-only self-hoster (no VAPID keys,
  // no browser subscriptions) still gets PUSH-tier interrupts. Contained:
  // sendTelegramForPush never throws by design, and the .catch is a second
  // belt so a bug there can never fail the web-push path.
  await sendTelegramForPush(userId, payload, category).catch(() => {});

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

  if (subscriptions.length === 0) {
    console.log(`[PUSH] No push subscriptions for user ${userId} — browser push skipped`);
    await recordSkipped(userId, payload.title, category, "no_subscriptions");
    return skipped("no_subscriptions");
  }
  console.log(
    `[PUSH] Sending to ${subscriptions.length} subscription(s) for ${userId}: "${payload.title}"`,
  );

  let accepted = 0;
  let failed = 0;
  let attempted = 0;
  for (const sub of subscriptions) {
    if (!isSafePushEndpoint(sub.endpoint)) {
      await recordSkipped(userId, payload.title, category, "unsafe_endpoint");
      continue;
    }
    attempted++;
    const deliveryId = await createPushDeliveryAttempt({
      userId,
      subscriptionId: sub.id,
      endpoint: sub.endpoint,
      notificationId: payload.notificationId ?? null,
      category,
      title: payload.title,
    });

    let lastStatusCode: number | undefined;
    let lastBody: string | undefined;
    let lastError: unknown;
    let delivered = false;
    const maxAttempts = 1 + PUSH_RETRY_DELAYS_MS.length;

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
      await markPushAccepted(deliveryId);
      accepted++;
    } else {
      failed++;
      await markPushFailed(deliveryId, { statusCode: lastStatusCode, body: lastBody });
      console.error(
        `[PUSH] Failed to send to subscription ${sub.id} after ${maxAttempts} attempts: status=${lastStatusCode}, body=${lastBody}, error=${lastError}`,
      );
      if (lastStatusCode === 410 || lastStatusCode === 404) {
        await prisma.pushSubscription.delete({
          where: { id: sub.id },
        });
        console.log(`[PUSH] Removed expired subscription ${sub.id}`);
      }
    }
  }
  console.log(`[PUSH] Sent ${accepted}/${attempted} push notifications successfully`);
  return {
    status: "sent",
    subscriptions: subscriptions.length,
    attempted,
    accepted,
    failed,
  };
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

async function hasRecentAgentProposalPush(userId: string): Promise<boolean> {
  const since = new Date(Date.now() - AGENT_PROPOSAL_PUSH_COOLDOWN_HOURS * 60 * 60 * 1000);
  const recent = await prisma.pushDeliveryLog.findFirst({
    where: {
      userId,
      category: "agent_proposal",
      status: { in: ["PENDING", "ACCEPTED"] },
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  return !!recent;
}
