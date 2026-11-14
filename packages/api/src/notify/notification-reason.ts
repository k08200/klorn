/**
 * Why a mail rang (NC1, contract NotificationReason): one rule for the
 * notification center row and every channel's push content
 * (mail-push-content.ts reasonLine).
 *
 *   verified  only for a user under attention-engine policy v3
 *             (isJudgeV3PolicyEnabled), whose item stores structured reasons
 *             with verbatim evidence (judge/v3/reasons.ts). The evidence is
 *             re-checked here, on every read, as a substring of the mail's
 *             subject or body with judge/v3/evidence.ts verifyEvidence — the
 *             same normalisation, minimum weight and word-boundary rule the
 *             facts extractor applies. A quote that fails the check is never
 *             shown.
 *   otherwise AttentionItem.tierReason resolved for the reader (a stored key
 *             becomes copy in their language), verified false. The schema
 *             documents it as free text that may be model-written and is NOT
 *             a trust signal: clients present it as Klorn's call.
 *
 * Text and quote are plain text (tags, controls and bidi marks stripped).
 */

import type { NotificationReason } from "@klorn/contract";
import { prisma } from "../db.js";
import { resolveTierReason, TIER_REASON_MAX_CHARS } from "../judge/tier-reason-strings.js";
import { buildEvidenceHaystack, verifyEvidence } from "../judge/v3/evidence.js";
import { FACTS_BODY_CAP } from "../judge/v3/facts-prompt.js";
import { MAX_EVIDENCE_CHARS } from "../judge/v3/facts-schema.js";
import { toV3ItemRow, V3_ITEM_SELECT, type V3ItemRow, v3ItemWire } from "../judge/v3/item-wire.js";
import { plainLine } from "./mail-push-content.js";

/** The item columns a reason is built from. */
export interface ReasonItemRow extends V3ItemRow {
  tierReason: string | null;
}

/** Prisma select for ReasonItemRow. */
export const REASON_ITEM_SELECT = { tierReason: true, ...V3_ITEM_SELECT } as const;

/**
 * How much of a stored body is searched: the facts extractor quotes from the
 * first FACTS_BODY_CAP * 2 characters it scans, so a quote it produced lies
 * inside this prefix.
 */
const BODY_SEARCH_CHARS = FACTS_BODY_CAP * 2;

/**
 * At most this many bodies are read per batch (each up to the 50k stored
 * cap). A mail past it keeps its quote unverified: the short reason shows.
 */
export const MAX_BODY_READS = 50;

/**
 * Under policy v3: the stored quote of the first reason that has one — the
 * deciding reason, or the one a hold put first. Re-parsed and cleaned by
 * v3ItemWire, so a manual override, an agent's lane or a policy version this
 * server does not know yields none.
 */
export function reasonEvidence(
  item: ReasonItemRow,
  opts: { subject: string | null; now: Date },
): string | null {
  const wire = v3ItemWire(toV3ItemRow(item), { rank: null, subject: opts.subject, now: opts.now });
  return wire.reasons.find((r) => r.evidence)?.evidence ?? null;
}

export interface ReasonMailText {
  subject: string | null;
  body: string | null;
}

/** The reason for one mail. Pure. */
export function notificationReason(input: {
  tierReason: string | null;
  evidence: string | null;
  mail: ReasonMailText | null;
  language: string;
}): NotificationReason | null {
  const text = plainLine(
    resolveTierReason(input.tierReason, input.language),
    TIER_REASON_MAX_CHARS,
  );
  const quote = verifiedQuote(input.evidence, input.mail);
  if (quote) return { text: text || quote.quote, verified: true, ...quote };
  return text ? { text, verified: false } : null;
}

/**
 * The quote as shown, only when THAT text verifies: cleaning (tags, controls,
 * format characters) runs first, so a quote is never shown that is not in the
 * mail as the user would read it.
 */
function verifiedQuote(
  evidence: string | null,
  mail: ReasonMailText | null,
): { quote: string; quoteIn: "subject" | "body" } | null {
  if (!evidence || !mail) return null;
  const quote = plainLine(evidence, MAX_EVIDENCE_CHARS);
  if (!quote) return null;
  const body = mail.body ? mail.body.slice(0, BODY_SEARCH_CHARS) : null;
  if (!verifyEvidence(quote, buildEvidenceHaystack(mail.subject, body))) return null;
  const inSubject = verifyEvidence(quote, buildEvidenceHaystack(mail.subject, null));
  return { quote, quoteIn: inSubject ? "subject" : "body" };
}

/** A mail to explain. `body` / `snippet` when the caller already holds them. */
export interface MailForReason {
  /** EmailMessage.id */
  id: string;
  subject: string | null;
  body?: string | null;
  snippet?: string | null;
}

/**
 * Reasons for a batch of the user's mails, keyed by EmailMessage.id (null:
 * nothing to say). `items` are the user's items keyed by their mail id. At
 * most one query: the bodies of the mails whose quote is not already proven
 * by the subject and whose body the caller did not pass, scoped to the user.
 */
export async function reasonsForMail(
  userId: string,
  mails: readonly MailForReason[],
  items: ReadonlyMap<string, ReasonItemRow>,
  opts: { language: string; now: Date; policyUser: boolean },
): Promise<Map<string, NotificationReason | null>> {
  const evidenceOf = new Map<string, string>();
  if (opts.policyUser) {
    for (const mail of mails) {
      const item = items.get(mail.id);
      const evidence = item ? reasonEvidence(item, { subject: mail.subject, now: opts.now }) : null;
      if (evidence) evidenceOf.set(mail.id, evidence);
    }
  }
  const bodies = await loadBodies(userId, mails, evidenceOf);
  const reasons = new Map<string, NotificationReason | null>();
  for (const mail of mails) {
    const item = items.get(mail.id);
    if (!item) {
      reasons.set(mail.id, null);
      continue;
    }
    reasons.set(
      mail.id,
      notificationReason({
        tierReason: item.tierReason,
        evidence: evidenceOf.get(mail.id) ?? null,
        mail: { subject: mail.subject, body: bodyText(mail, bodies) },
        language: opts.language,
      }),
    );
  }
  return reasons;
}

/** The body as the facts extractor saw it: the body, else the snippet. */
function bodyText(
  mail: MailForReason,
  loaded: ReadonlyMap<string, { body: string | null; snippet: string | null }>,
): string | null {
  const row = mail.body !== undefined ? mail : (loaded.get(mail.id) ?? null);
  if (!row) return null;
  return row.body?.trim() ? row.body : (row.snippet ?? null);
}

async function loadBodies(
  userId: string,
  mails: readonly MailForReason[],
  evidenceOf: ReadonlyMap<string, string>,
): Promise<Map<string, { body: string | null; snippet: string | null }>> {
  const ids = mails
    .filter((m) => m.body === undefined && evidenceOf.has(m.id))
    .filter((m) => {
      const evidence = evidenceOf.get(m.id) ?? "";
      return !verifyEvidence(evidence, buildEvidenceHaystack(m.subject, null));
    })
    .slice(0, MAX_BODY_READS)
    .map((m) => m.id);
  if (ids.length === 0) return new Map();
  const rows = await prisma.emailMessage.findMany({
    where: { userId, id: { in: ids } },
    select: { id: true, body: true, snippet: true },
  });
  return new Map(rows.map((r) => [r.id, { body: r.body, snippet: r.snippet }]));
}
