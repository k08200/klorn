/**
 * Keyword-fallback policy — SINGLE SOURCE OF TRUTH for the deterministic
 * patterns the firewall uses with no LLM in the loop.
 *
 * Third piece of the deterministic core: tier-policy.ts is the relation rule,
 * sender-policy.ts is the entity knowledge, and this is the no-LLM content/
 * sender pattern vocabulary — the marketing fast-path, the urgency guard's
 * word list, and the keyword feature scorer used when the LLM is unavailable.
 *
 * Every regex and score level here was calibrated against the founder's
 * 50-email ground truth (2026-05-28; marketing 0.1/0.95 boundary fix caught by
 * eval/judge-eval-set.json). They live together so the patterns are one
 * editable, reviewable surface instead of literals scattered through the judge.
 */

import type { ClassifiableEmail } from "./email-classifier.js";
import type { TierFeatures } from "./tier-policy.js";

/**
 * Fast-path SILENT markers: subjects the founder has confirmed they always
 * want silenced. Narrow on purpose — previously the fast-path fired on any
 * "automated" classification, which over-claimed Vercel notifications /
 * own-product waitlist signups / Google account confirms as SILENT.
 */
export const MARKETING_SUBJECT_RE =
  /unsubscribe|view (this email )?in (your )?browser|\[광고\]|\[알림\]|\(광고\)|수신거부|무료\s*체험|할인\s*쿠폰/i;

/**
 * Promotional / marketing detector — the firewall's SILENT fast-path signal:
 * Gmail's calibrated CATEGORY_PROMOTIONS label OR an explicit marketing subject
 * marker (광고 / view-in-browser / unsubscribe). Single source of truth so the
 * judge's fast-path (poc-judge.ts) and the Gmail auto-mark-read path
 * (email-firewall.ts) can never disagree about what counts as "promotional".
 */
export function isClearMarketing(email: {
  labels?: string[] | null;
  subject?: string | null;
}): boolean {
  const labels = email.labels ?? [];
  const subject = email.subject ?? "";
  return labels.includes("CATEGORY_PROMOTIONS") || MARKETING_SUBJECT_RE.test(subject);
}

/**
 * Time-pressure vocabulary, shared by the keyword fallback and the sender-prior
 * urgency guard (poc-judge.ts:canShortCircuit). Case-insensitive — callers pass
 * raw subject/snippet.
 */
export const URGENT_WORDS_RE = /urgent|asap|긴급|중요|action required|today|tomorrow|deadline|due/i;

// Pattern vocabulary read by the keyword scorer. Each matches a different field
// (noted), so they stay separate rather than merged into one alternation.
/** Narrow marketing signal (from + subject) → the founder permanently silences. */
const MARKETING_RE =
  /newsletter|digest|marketing|promo|\[광고\]|\[알림\]|\(광고\)|unsubscribe|수신거부/;
/** Broader system-notification signal (from) → still QUEUE, not SILENT. */
const SYSTEM_NOTIFICATION_RE =
  /no[-_]?reply@|noreply@|donotreply@|notifications?@|@updates\.|@email\.|@notifications\./;

/** No-reply / do-not-reply machine sender (from). */
const NO_REPLY_RE = /no[-_]?reply@|donotreply@/;

/**
 * No-reply sender check — a machine address that never carries an interpersonal
 * promise. Deliberately narrower than SYSTEM_NOTIFICATION_RE: notifications@
 * (GitHub/Jira/Linear) and marketing subdomains DO relay human commitments
 * ("Sarah will review the PR Friday"), so callers that gate commitment mining
 * must not treat them as automated.
 */
export function isNoReplySender(from: string): boolean {
  return NO_REPLY_RE.test(from);
}

/** Investor signal (from) → high trust, low reversibility. */
const INVESTOR_RE = /investor|vc|capital|ventures|partner@|fund/;
/** Meeting / scheduling signal (subject + snippet). */
const MEETING_RE = /meeting|invite|calendar|zoom|reschedule|미팅|일정/;
/** Direct-question signal (subject + snippet) → harder to reverse. */
const QUESTION_RE = /\?|could you|can you|would you|please/;

/**
 * Feature score levels for the keyword scorer, calibrated against the founder's
 * 50-email ground truth. Marketing's 0.1 urgency / 0.95 reversibility (not the
 * 0.2/0.9 defaults) clear tierFromFeatures' SILENT branch, which uses strict
 * inequalities (urgency < 0.2 AND reversibility > 0.9) — with the defaults a
 * clear newsletter sat exactly on both boundaries and could never go SILENT.
 */
export const KEYWORD_SCORES = {
  senderTrust: { marketing: 0.05, systemNotification: 0.4, investor: 0.85, default: 0.45 },
  urgency: { urgentWord: 0.85, meeting: 0.55, marketing: 0.1, default: 0.2 },
  reversibility: { sensitive: 0.3, marketing: 0.95, default: 0.9 },
  confidence: { patternMatched: 0.7, default: 0.55 },
} as const;

/** Cheap content check: does this email carry any time-pressure signal? */
export function looksUrgent(email: ClassifiableEmail): boolean {
  const hay = `${email.subject || ""} ${email.snippet || ""}`;
  return URGENT_WORDS_RE.test(hay);
}

/**
 * Coarse keyword-only feature scorer for when the LLM is unavailable.
 *
 * Separates two automated-sender signals the founder treats differently:
 *  - "marketing"    = newsletter / digest / promo / "광고" → SILENT bucket
 *  - "notification" = no-reply / notifications@ / updates.* → still QUEUE
 * The old `isAutomated` mashed both together and forced everything to SILENT.
 */
export function keywordFeatures(email: ClassifiableEmail): TierFeatures {
  const from = (email.from || "").toLowerCase();
  const subject = (email.subject || "").toLowerCase();
  const snippet = (email.snippet || "").toLowerCase();
  const hay = `${subject} ${snippet}`;
  const fromAndSubject = `${from} ${subject}`;

  const isMarketing = MARKETING_RE.test(fromAndSubject);
  const isSystemNotification = SYSTEM_NOTIFICATION_RE.test(from);
  const isInvestor = INVESTOR_RE.test(from);
  const isUrgentWord = URGENT_WORDS_RE.test(hay);
  const isMeeting = MEETING_RE.test(hay);
  const isQuestion = QUESTION_RE.test(hay);

  const s = KEYWORD_SCORES;

  // senderTrust: marketing → SILENT-eligible; system notice → QUEUE-visible;
  // investor → high; default → queue-by-default (tierFromFeatures rule 5).
  let senderTrust: number = s.senderTrust.default;
  if (isMarketing) senderTrust = s.senderTrust.marketing;
  else if (isSystemNotification) senderTrust = s.senderTrust.systemNotification;
  else if (isInvestor) senderTrust = s.senderTrust.investor;

  let urgency: number = s.urgency.default;
  if (isUrgentWord) urgency = s.urgency.urgentWord;
  else if (isMeeting) urgency = s.urgency.meeting;
  else if (isMarketing) urgency = s.urgency.marketing;

  // Replies to a human are hard to undo; archives are trivial.
  let reversibility: number = s.reversibility.default;
  if (isQuestion || isInvestor) reversibility = s.reversibility.sensitive;
  else if (isMarketing) reversibility = s.reversibility.marketing;

  // Higher confidence when a pattern matched; lower otherwise so the rule
  // defaults to QUEUE for unfamiliar cases.
  const confidence =
    isMarketing || isSystemNotification || isInvestor
      ? s.confidence.patternMatched
      : s.confidence.default;

  return { confidence, senderTrust, reversibility, urgency };
}
