/**
 * SMS phone-number storage — backed by Memory(type=CONTEXT, key=phone_number_e164).
 *
 * Kept off the User table for now: SMS is admin-MVP only, opt-in by the
 * handful of dogfood admins. Memory is already the place we stash per-user
 * context that doesn't need a column, and skipping a Prisma migration keeps
 * this PR ship-from-an-agent safe (see project_eve_db_ops_runbook.md).
 *
 * Validation is intentionally minimal: E.164 only (+CC then 7-15 digits).
 * Twilio rejects malformed numbers at send time anyway — this just blocks
 * obvious garbage from ever reaching the DB.
 */

import { prisma } from "../db.js";
import { remember } from "../learning/memory.js";

const PHONE_KEY = "phone_number_e164";
const PHONE_TYPE = "CONTEXT";

/** E.164: leading +, country code starting 1-9, total 8-16 digits. */
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export class InvalidPhoneNumberError extends Error {
  constructor(value: string) {
    super(`Invalid phone number: "${value}" — expected E.164 format (e.g. +821012345678)`);
    this.name = "InvalidPhoneNumberError";
  }
}

/** Returns true if the string matches the E.164 format we accept. */
export function isValidE164(phone: string): boolean {
  return E164_REGEX.test(phone);
}

/**
 * Persist a phone number for the user. Throws InvalidPhoneNumberError if the
 * format is wrong so callers (HTTP route, settings UI) can surface a clear
 * 400 instead of silently storing junk.
 */
export async function setPhoneNumber(userId: string, phoneE164: string): Promise<void> {
  const trimmed = phoneE164.trim();
  if (!isValidE164(trimmed)) {
    throw new InvalidPhoneNumberError(phoneE164);
  }
  await remember(userId, PHONE_TYPE, PHONE_KEY, trimmed, "sms_settings");
}

/** Returns the user's stored E.164 phone number, or null if none set. */
export async function getPhoneNumber(userId: string): Promise<string | null> {
  const row = await prisma.memory.findUnique({
    where: {
      userId_type_key: {
        userId,
        type: PHONE_TYPE,
        key: PHONE_KEY,
      },
    },
    select: { content: true },
  });
  if (!row) return null;
  const value = row.content?.trim();
  if (!value || !isValidE164(value)) return null;
  return value;
}
