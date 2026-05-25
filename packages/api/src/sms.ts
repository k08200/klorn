/**
 * Twilio SMS client — admin-only outbound notifications.
 *
 * Gated three ways:
 *   1. Admin gate: ADMIN_EMAILS env or User.role === ADMIN. Non-admins
 *      silently no-op so an accidental call site can't text everyone.
 *   2. Phone gate: user must have stored an E.164 number via
 *      setPhoneNumber(). No phone = no SMS.
 *   3. Daily cap: SMS_DAILY_CAP_PER_USER (default 10). Hard wall — SMS is
 *      dollars-per-message and a stuck loop is too expensive to allow.
 *
 * Twilio failures are best-effort. They warn but do not throw and do not
 * report to Sentry on every failed send (a flapping number would spam the
 * error stream). Caller treats SMS as a courtesy on top of web push, never
 * as a primary delivery channel.
 *
 * Required env:
 *   - TWILIO_ACCOUNT_SID
 *   - TWILIO_AUTH_TOKEN
 *   - TWILIO_FROM_NUMBER (E.164)
 * All optional — if any is missing the module logs once and no-ops.
 */

import twilio from "twilio";
import { prisma } from "./db.js";
import { checkAndRecordSmsSend } from "./sms-limiter.js";
import { getPhoneNumber } from "./sms-phone.js";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";

/** Twilio segments are 160 chars (GSM-7) / 70 chars (UCS-2). Cap at 320 for ≤2 segments. */
const SMS_BODY_MAX_CHARS = 320;

export type SmsReason =
  | "not_admin"
  | "no_phone"
  | "rate_limited"
  | "twilio_not_configured"
  | "twilio_error"
  | "empty_body";

export interface SmsResult {
  sent: boolean;
  reason?: SmsReason;
}

type TwilioClient = ReturnType<typeof twilio>;

let cachedClient: TwilioClient | null = null;
let configWarnedOnce = false;

function getClient(): TwilioClient | null {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    if (!configWarnedOnce) {
      console.warn(
        "[SMS] Twilio not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER to enable outbound SMS",
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
export function _resetSmsClientForTests(): void {
  cachedClient = null;
  configWarnedOnce = false;
}

/**
 * Admin gate. A user is admin if they have role=ADMIN OR their email matches
 * ADMIN_EMAILS. Failures (DB unreachable, etc.) fail closed — non-admin.
 */
async function isAdminUser(userId: string): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, email: true },
    });
    if (!user) return false;
    if (user.role === "ADMIN") return true;
    const adminEmails = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const email = user.email?.trim().toLowerCase();
    return Boolean(email && adminEmails.includes(email));
  } catch {
    return false;
  }
}

function truncateBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= SMS_BODY_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, SMS_BODY_MAX_CHARS - 1)}…`;
}

/**
 * Send an SMS to a user. Returns a result describing what happened — never
 * throws. Callers should treat a `{ sent: false }` as a non-event (web push
 * is the primary channel; SMS is a courtesy escalation).
 */
export async function sendSms(userId: string, body: string): Promise<SmsResult> {
  if (!body || !body.trim()) return { sent: false, reason: "empty_body" };

  // 1. Admin gate
  if (!(await isAdminUser(userId))) {
    return { sent: false, reason: "not_admin" };
  }

  // 2. Phone gate
  const to = await getPhoneNumber(userId);
  if (!to) return { sent: false, reason: "no_phone" };

  // 3. Daily cap. Silent skip with warn so a runaway loop doesn't burn $.
  if (!checkAndRecordSmsSend(userId)) {
    console.warn(`[SMS] Daily cap reached for user ${userId} — skipping`);
    return { sent: false, reason: "rate_limited" };
  }

  // 4. Twilio config gate. If unconfigured, no-op (return false) — cap was
  //    already incremented, so a misconfigured prod can't pretend to send.
  const client = getClient();
  if (!client) return { sent: false, reason: "twilio_not_configured" };

  const truncated = truncateBody(body);

  try {
    await client.messages.create({
      from: TWILIO_FROM_NUMBER,
      to,
      body: truncated,
    });
    console.log(`[SMS] sent to user ${userId}`);
    return { sent: true };
  } catch (err) {
    // Best-effort. Warn (not error) and don't capture to Sentry — a single
    // bad phone number would otherwise flood the error stream.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[SMS] Twilio send failed for user ${userId}: ${message}`);
    return { sent: false, reason: "twilio_error" };
  }
}
