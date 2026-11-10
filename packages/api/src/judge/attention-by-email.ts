/**
 * Done ("처리 완료") and Later ("나중에") keyed by the EmailMessage id.
 *
 * The mail list (GET /api/email) and the reader hold email ids; only OPEN items
 * inside the firewall's newest-200 window carry an attention id to a client. So
 * a client acting on older mail — or on mail from a list rather than the board —
 * had no id to send to /:id/dismiss or /:id/snooze. This resolves the caller's
 * own email row first, then that email's attention item, and reuses the
 * existing dismissAttentionItem / snoozeAttentionItem, so the mutation and its
 * learning side effects (feedback, contact engagement) are exactly the
 * id-keyed routes'.
 *
 * Behaviour, by what the email's attention item is:
 *   - the email is not the caller's (or does not exist): not_found. The lookup is
 *     by id AND userId, with no inbox constraint, so mail from the primary inbox
 *     and from any linked inbox resolve alike, and a foreign id resolves to
 *     nothing (it is never told apart from an unknown id).
 *   - OPEN or SNOOZED: Done dismisses it; Later (re-)snoozes it to the new time.
 *     A SNOOZED item is still "not done", so Done on it is real work, and Later
 *     on it moves the wake-up time like a second /:id/snooze would.
 *   - DISMISSED or RESOLVED: nothing changes; `alreadyClear: true`. Done twice
 *     (two devices) is idempotent and records the learning signal once, and a
 *     stale Later never pulls a finished item back into SNOOZED.
 *   - no attention item (the judge has not reached the mail yet): nothing is
 *     created; `alreadyClear: true, itemId: null`. Creating an item here would
 *     invent a classification the judge never made. The consequence, stated:
 *     if the judge later classifies that mail it surfaces as a fresh OPEN item.
 *
 * An email has at most one attention item: (userId, source, sourceId) is unique.
 */

import { prisma } from "../db.js";
import { dismissAttentionItem } from "./attention-dismiss.js";
import { snoozeAttentionItem } from "./attention-snooze.js";

export type EmailAttentionActionResult =
  | { ok: true; itemId: string; alreadyClear: false }
  | { ok: true; itemId: string | null; alreadyClear: true }
  | { ok: false; reason: "not_found" };

/** Statuses a Done / Later still acts on. */
const ACTIONABLE_STATUSES: ReadonlySet<string> = new Set(["OPEN", "SNOOZED"]);

type Resolved =
  | { kind: "not_found" }
  | { kind: "no_item" }
  | { kind: "item"; id: string; status: string };

async function resolveEmailAttention(userId: string, emailId: string): Promise<Resolved> {
  // Ownership first: the caller's own row, whichever inbox it arrived in.
  const email = await prisma.emailMessage.findFirst({
    where: { id: emailId, userId },
    select: { id: true },
  });
  if (!email) return { kind: "not_found" };
  const item = await prisma.attentionItem.findFirst({
    where: { userId, source: "EMAIL", sourceId: email.id },
    select: { id: true, status: true },
  });
  if (!item) return { kind: "no_item" };
  return { kind: "item", id: item.id, status: String(item.status) };
}

async function actOnEmailAttention(
  userId: string,
  emailId: string,
  act: (itemId: string) => Promise<{ ok: true } | { ok: false; reason: "not_found" }>,
): Promise<EmailAttentionActionResult> {
  const resolved = await resolveEmailAttention(userId, emailId);
  if (resolved.kind === "not_found") return { ok: false, reason: "not_found" };
  if (resolved.kind === "no_item") return { ok: true, itemId: null, alreadyClear: true };
  if (!ACTIONABLE_STATUSES.has(resolved.status)) {
    return { ok: true, itemId: resolved.id, alreadyClear: true };
  }
  const result = await act(resolved.id);
  // The item was deleted between the lookup and the write.
  if (!result.ok) return { ok: false, reason: "not_found" };
  return { ok: true, itemId: resolved.id, alreadyClear: false };
}

/** Done: dismiss the open attention item of the caller's email `emailId`. */
export function dismissEmailAttention(
  userId: string,
  emailId: string,
): Promise<EmailAttentionActionResult> {
  return actOnEmailAttention(userId, emailId, (itemId) => dismissAttentionItem(userId, itemId));
}

/** Later: snooze the open attention item of the caller's email `emailId` until `snoozeUntil`. */
export function snoozeEmailAttention(
  userId: string,
  emailId: string,
  snoozeUntil: Date,
): Promise<EmailAttentionActionResult> {
  return actOnEmailAttention(userId, emailId, (itemId) =>
    snoozeAttentionItem(userId, itemId, snoozeUntil),
  );
}
