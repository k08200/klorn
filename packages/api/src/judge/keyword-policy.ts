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

import { extractEmailAddress } from "../mail/email-address.js";
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

// Account/security vocabularies — single source. Two consumers key off these
// and must never diverge: the routine-confirmation urgency cap
// (poc-judge.ts:applyRoutineConfirmationCap, founder decision 2026-06-30) and
// the CI-noise SILENT floor's security carve-out (ci-noise.ts, #793).
/** A change that already happened to the account (subject + snippet). */
export const ACCOUNT_CONFIRMATION_RE =
  /\b(new sign[-\s]?in|signed in|sign[-\s]?in (from|on|detected|notice)|phone(\s+number)?\s+(was\s+)?added|number added as|device\s+(was\s+)?added|new device added|passkey added|password\s+(was\s+)?(reset|changed|updated)|two[-\s]?factor|2fa|recovery (email|phone)\s+added|verification method (was\s+)?added)\b/i;
/** An explicit ask to act on something suspicious/unauthorized (also scans body). */
export const ACCOUNT_ALERT_ACTION_RE =
  /\b(action required|verify|confirm it was you|wasn'?t you|was this you|unauthorized|unusual|suspicious|we blocked|blocked a sign|secure your account|if you did(n'?t| not))\b/i;

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

/**
 * Automated logistics/transactional sender (shipping, order, delivery notices).
 * Matches the local-part ROLE — ship-confirm@, order-update@, orders@,
 * shipment@, delivery@, dispatch@, tracking@ — so order/shipping CONFIRMATIONS
 * from a real (non no-reply) address never become fake dated ledger commitments.
 * The `(?:^|[._+-])` anchor keeps the token a standalone role word, so people /
 * teams that merely contain it (shipley@, leadership@, jordan@, notifications@)
 * are NOT matched. Scoped to logistics roles only — billing/invoice/receipt are
 * excluded because a person may legitimately promise "I'll send the invoice".
 */
const TRANSACTIONAL_SENDER_RE =
  /(?:^|[._+-])(?:ship(?:ping|ment|ments)?|order(?:s|update|status|confirm)?|deliver(?:y|ies)|dispatch|tracking|courier|parcel|fulfil(?:l)?ment)(?:[._+-][^@]*)?@/i;

/** True for an automated shipping/order/delivery sender (see regex above). */
export function isTransactionalSender(from: string): boolean {
  return TRANSACTIONAL_SENDER_RE.test(from);
}

/**
 * Machine-generated sender that must never INTERRUPT the user (PUSH). Broad on
 * purpose — the union of the system-notification signal (no-reply@ / noreply@ /
 * donotreply@ / notifications@ / updates.* / email.* / notifications.*
 * subdomains) and the transactional logistics roles. Used ONLY by the judge's
 * PUSH floor (poc-judge.ts): a match lands QUEUE — a glance — never PUSH.
 *
 * Deliberately BROADER than {@link isNoReplySender}, which stays narrow so
 * commitment mining still reads human promises relayed via notifications@
 * ("Sarah will review Friday"). The two answer different questions:
 * isNoReplySender = "can this carry a commitment?"; isAutomatedSender =
 * "should this ever interrupt?".
 *
 * The founder's own ground truth agrees: every automated sender in
 * eval/judge-eval-set.json is labeled QUEUE or AUTO, never PUSH — so this floor
 * only ever corrects a live misclassification (a failed deploy, a security
 * confirmation the LLM over-scored as urgent), never the eval gate. The
 * CI/monitoring→SILENT refinement is tracked separately.
 */
export function isAutomatedSender(from: string): boolean {
  if (!from) return false;
  // Normalize "Name <addr>" → bare addr-spec so the role-anchored transactional
  // regex (which expects the role at the start of the local-part) matches a
  // display-name header too; SYSTEM_NOTIFICATION_RE matches either form.
  const addr = extractEmailAddress(from);
  return SYSTEM_NOTIFICATION_RE.test(addr) || TRANSACTIONAL_SENDER_RE.test(addr);
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

  // Marketing is checked FIRST: a promo blast with an urgent word ("URGENT:
  // sale today!") must not borrow the urgentWord urgency and clear the PUSH gate
  // in the fallback — marketing never interrupts.
  let urgency: number = s.urgency.default;
  if (isMarketing) urgency = s.urgency.marketing;
  else if (isUrgentWord) urgency = s.urgency.urgentWord;
  else if (isMeeting) urgency = s.urgency.meeting;

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
