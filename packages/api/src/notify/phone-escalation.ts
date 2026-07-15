/**
 * Phone escalation v0 — ONE plain TTS call when a PUSH-tier notification
 * goes unacknowledged (GoAlert/PagerDuty-style escalation applied to a
 * personal email firewall).
 *
 * This is an opt-in DELIVERY channel for the PUSH tier, NOT a new tier.
 * The 4-tier vocabulary in tiers.ts (SILENT/QUEUE/PUSH/AUTO) is locked;
 * nothing here adds a "CALL" tier — it only re-delivers a PUSH that the
 * phone push channel demonstrably failed to land.
 *
 * Hard safety rails (all named constants below):
 *   - max 1 call per notification EVER (UNIQUE PhoneEscalation.notificationId)
 *   - per-user daily cap (PHONE_ESCALATION_DAILY_CAP, default 3)
 *   - 10-minute per-user cooldown between calls
 *   - quiet hours ALWAYS suppress calls — no urgency bypass in v0
 *   - fully disabled unless PHONE_ESCALATION_ENABLED=true AND the Twilio
 *     envs are set AND the user opted in AND the user has a phone on file
 *
 * Twilio client setup mirrors sms.ts (same env names, cached client,
 * config-warn-once, test reset seam). Calls are best-effort: failures warn
 * and mark the row FAILED, they never throw into the scheduler tick.
 *
 * Required env (same names as sms.ts):
 *   - TWILIO_ACCOUNT_SID
 *   - TWILIO_AUTH_TOKEN
 *   - TWILIO_FROM_NUMBER (E.164)
 * Plus PUBLIC_URL (or RENDER_EXTERNAL_URL) so Twilio can reach the
 * /api/phone/gather webhook.
 */

import { randomUUID } from "node:crypto";
import twilio from "twilio";
import { prisma } from "./db.js";
import { buildEscalationTwiml, publicBaseUrl, sanitizeTitleForSpeech } from "./phone-twiml.js";
import { isWithinQuietHours } from "./quiet-hours.js";
import { getPhoneNumber } from "./sms-phone.js";
import { normalizeTimeZone } from "./time-zone.js";

export { escapeXml, sanitizeTitleForSpeech } from "./phone-twiml.js";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";

// ─── Safety-rail constants ──────────────────────────────────────────────
/** Per-notification rail. Enforced by the UNIQUE index; documented here. */
export const MAX_CALLS_PER_NOTIFICATION = 1;
/** Default per-user daily call cap (override: PHONE_ESCALATION_DAILY_CAP). */
export const DEFAULT_DAILY_CALL_CAP = 3;
/** Minimum minutes between two calls to the same user. */
export const CALL_COOLDOWN_MINUTES = 10;
/** Minutes a PUSH may sit unacknowledged before we dial
 * (override: PHONE_ESCALATION_TIMEOUT_MINUTES). */
export const DEFAULT_ESCALATION_TIMEOUT_MINUTES = 5;
/** Never dial about pushes older than this — stale items are not emergencies. */
export const ESCALATION_LOOKBACK_MINUTES = 60;
/** Seconds Twilio lets the phone ring before giving up. */
const CALL_RING_TIMEOUT_SECONDS = 30;
/**
 * PushDeliveryLog categories that carry PUSH-tier interrupts. Only these may
 * escalate to a phone call; briefings/proposals/etc. never ring a phone.
 */
export const PUSH_TIER_CATEGORIES = ["email_urgent"] as const;

const MS_PER_MINUTE = 60_000;

export type PhoneEscalationSkipReason =
  | "feature_disabled"
  | "twilio_not_configured"
  | "no_public_url"
  | "not_opted_in"
  | "no_phone"
  | "quiet_hours"
  | "already_escalated"
  | "daily_cap_reached"
  | "cooldown_active"
  | "twilio_error";

export interface PlaceCallResult {
  placed: boolean;
  reason?: PhoneEscalationSkipReason;
}

export interface EscalationSweepResult {
  candidates: number;
  placed: number;
}

// ─── Env helpers (read at call time so caps are live-tunable) ───────────
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function phoneEscalationDailyCap(): number {
  return intEnv("PHONE_ESCALATION_DAILY_CAP", DEFAULT_DAILY_CALL_CAP);
}

export function escalationTimeoutMinutes(): number {
  return intEnv("PHONE_ESCALATION_TIMEOUT_MINUTES", DEFAULT_ESCALATION_TIMEOUT_MINUTES);
}

function isFeatureEnabled(): boolean {
  return process.env.PHONE_ESCALATION_ENABLED === "true";
}

// ─── Twilio client (mirrors sms.ts) ─────────────────────────────────────
type TwilioClient = ReturnType<typeof twilio>;

let cachedClient: TwilioClient | null = null;
let configWarnedOnce = false;

function getClient(): TwilioClient | null {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    if (!configWarnedOnce) {
      console.warn(
        "[PHONE] Twilio not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER to enable escalation calls",
      );
      configWarnedOnce = true;
    }
    return null;
  }
  if (!cachedClient) {
    cachedClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }
  return cachedClient;
}

/** Test seam: drop the cached Twilio client and config-warn flag. */
export function _resetPhoneClientForTests(): void {
  cachedClient = null;
  configWarnedOnce = false;
}

// ─── Quiet-hours config shape (cast pattern shared with notification-prefs) ─
interface EscalationConfigRow {
  phoneEscalationEnabled?: boolean;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  timezone?: string | null;
}

function utcDayStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/**
 * Place the single escalation call for one notification. Walks every rail
 * in order and returns a result describing what happened — never throws.
 */
export async function placeEscalationCall(
  userId: string,
  input: { notificationId: string; title: string },
  now: Date = new Date(),
): Promise<PlaceCallResult> {
  if (!isFeatureEnabled()) return { placed: false, reason: "feature_disabled" };

  const client = getClient();
  if (!client) return { placed: false, reason: "twilio_not_configured" };

  const baseUrl = publicBaseUrl();
  if (!baseUrl) {
    console.warn("[PHONE] PUBLIC_URL/RENDER_EXTERNAL_URL not set — cannot host gather webhook");
    return { placed: false, reason: "no_public_url" };
  }

  const config = (await prisma.automationConfig.findUnique({
    where: { userId },
  })) as EscalationConfigRow | null;
  if (config?.phoneEscalationEnabled !== true) {
    return { placed: false, reason: "not_opted_in" };
  }

  const to = await getPhoneNumber(userId);
  if (!to) return { placed: false, reason: "no_phone" };

  // Quiet hours ALWAYS win. No urgency bypass in v0 — a 3 a.m. phone call
  // is exactly the failure mode an attention firewall exists to prevent.
  const timezone = normalizeTimeZone(config.timezone);
  const quietConfig = {
    quietHoursStart: config.quietHoursStart ?? null,
    quietHoursEnd: config.quietHoursEnd ?? null,
  };
  if (isWithinQuietHours(now, quietConfig, timezone)) {
    return { placed: false, reason: "quiet_hours" };
  }

  // Rail 1: max one call per notification, ever (app check; the UNIQUE
  // index below is the race-proof backstop).
  const existing = await prisma.phoneEscalation.findUnique({
    where: { notificationId: input.notificationId },
    select: { id: true },
  });
  if (existing) return { placed: false, reason: "already_escalated" };

  // Rail 2: daily cap. Every row counts — a FAILED dial still cost money
  // and attention, so it burns budget too.
  const todayCount = await prisma.phoneEscalation.count({
    where: { userId, createdAt: { gte: utcDayStart(now) } },
  });
  if (todayCount >= phoneEscalationDailyCap()) {
    return { placed: false, reason: "daily_cap_reached" };
  }

  // Rail 3: per-user cooldown.
  const cooldownStart = new Date(now.getTime() - CALL_COOLDOWN_MINUTES * MS_PER_MINUTE);
  const recent = await prisma.phoneEscalation.findFirst({
    where: { userId, createdAt: { gte: cooldownStart } },
    select: { id: true },
  });
  if (recent) return { placed: false, reason: "cooldown_active" };

  const spokenTitle = sanitizeTitleForSpeech(input.title);
  const gatherToken = randomUUID();

  // Claim the row BEFORE dialing: two racing ticks hit the unique index,
  // not Twilio — at worst we get a dangling PLACED row, never a double dial.
  let escalationId: string;
  try {
    const row = await prisma.phoneEscalation.create({
      data: {
        userId,
        notificationId: input.notificationId,
        gatherToken,
        title: spokenTitle,
      },
      select: { id: true },
    });
    escalationId = row.id;
  } catch {
    // Unique-constraint race: someone else already claimed this notification.
    return { placed: false, reason: "already_escalated" };
  }

  const gatherUrl = `${baseUrl}/api/phone/gather?token=${gatherToken}`;
  const statusUrl = `${baseUrl}/api/phone/status?token=${gatherToken}`;

  try {
    const call = await client.calls.create({
      from: TWILIO_FROM_NUMBER,
      to,
      twiml: buildEscalationTwiml(spokenTitle, gatherUrl),
      statusCallback: statusUrl,
      statusCallbackEvent: ["completed"],
      timeout: CALL_RING_TIMEOUT_SECONDS,
    });
    await prisma.phoneEscalation.update({
      where: { id: escalationId },
      data: { twilioCallSid: call.sid ?? null },
    });
    console.log(
      `[PHONE] Escalation call placed for user ${userId} (notification ${input.notificationId})`,
    );
    return { placed: true };
  } catch (err) {
    // Best-effort, mirroring sms.ts: warn (not Sentry) so a flaky number
    // can't flood the error stream; the FAILED row still burns daily budget.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[PHONE] Twilio call failed for user ${userId}: ${message}`);
    await prisma.phoneEscalation
      .update({ where: { id: escalationId }, data: { status: "FAILED" } })
      .catch(() => {});
    return { placed: false, reason: "twilio_error" };
  }
}

/** Skip reasons that apply to the whole user, not just one notification. */
const USER_LEVEL_STOP_REASONS: ReadonlySet<PhoneEscalationSkipReason> = new Set([
  "feature_disabled",
  "twilio_not_configured",
  "no_public_url",
  "not_opted_in",
  "no_phone",
  "quiet_hours",
  "daily_cap_reached",
  "cooldown_active",
]);

/**
 * Escalation trigger: find PUSH-tier notifications whose browser push was
 * ACCEPTED ≥ ESCALATION_TIMEOUT_MINUTES ago with no service-worker receipt
 * (receivedAt/clickedAt both null on every delivery row), still unread in
 * the bell, and not yet escalated — then place ONE call for the oldest.
 */
export async function escalateUnackedPush(
  userId: string,
  now: Date = new Date(),
): Promise<EscalationSweepResult> {
  if (!isFeatureEnabled()) return { candidates: 0, placed: 0 };

  const cutoff = new Date(now.getTime() - escalationTimeoutMinutes() * MS_PER_MINUTE);
  const oldest = new Date(now.getTime() - ESCALATION_LOOKBACK_MINUTES * MS_PER_MINUTE);

  const unackedLogs = (await prisma.pushDeliveryLog.findMany({
    where: {
      userId,
      status: "ACCEPTED",
      receivedAt: null,
      clickedAt: null,
      notificationId: { not: null },
      category: { in: [...PUSH_TIER_CATEGORIES] },
      createdAt: { lt: cutoff, gte: oldest },
    },
    orderBy: { createdAt: "asc" },
    select: { notificationId: true },
  })) as Array<{ notificationId: string | null }>;

  const candidateIds = [
    ...new Set(
      unackedLogs
        .map((log) => log.notificationId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  if (candidateIds.length === 0) return { candidates: 0, placed: 0 };

  // A notification fanned out to several devices has several delivery rows.
  // If ANY row was received/clicked, the user saw it — never dial for it.
  const receiptedLogs = (await prisma.pushDeliveryLog.findMany({
    where: {
      userId,
      notificationId: { in: candidateIds },
      OR: [{ receivedAt: { not: null } }, { clickedAt: { not: null } }],
    },
    select: { notificationId: true },
  })) as Array<{ notificationId: string | null }>;
  const receiptedIds = new Set(receiptedLogs.map((log) => log.notificationId));

  const unreceiptedIds = candidateIds.filter((id) => !receiptedIds.has(id));
  if (unreceiptedIds.length === 0) return { candidates: 0, placed: 0 };

  // Reading the notification in the bell UI also counts as acknowledgement.
  const unreadNotifications = (await prisma.notification.findMany({
    where: { id: { in: unreceiptedIds }, isRead: false },
    select: { id: true, title: true },
  })) as Array<{ id: string; title: string }>;

  const byId = new Map(unreadNotifications.map((n) => [n.id, n]));
  const ordered = unreceiptedIds
    .map((id) => byId.get(id))
    .filter((n): n is { id: string; title: string } => !!n);

  let placed = 0;
  for (const notification of ordered) {
    const result = await placeEscalationCall(
      userId,
      { notificationId: notification.id, title: notification.title },
      now,
    );
    if (result.placed) {
      placed += 1;
      // v0: at most ONE call per sweep. The cooldown would block the rest
      // anyway; breaking here just skips the pointless DB churn.
      break;
    }
    if (result.reason && USER_LEVEL_STOP_REASONS.has(result.reason)) break;
  }

  return { candidates: ordered.length, placed };
}
