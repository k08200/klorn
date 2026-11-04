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

import { boundedFromValue, extractEmailAddress } from "../mail/email-address.js";
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
// Korean deadline patterns added 2026-07-17 (#654 leak #5): the founder's real
// buried-urgent mail read "오늘 6시까지 회신 필요" — zero matches in the old
// vocabulary. Mirrors of the English terms already present (today/tomorrow/
// deadline/reply-needed); bare "까지" is deliberately excluded — it appears in
// ordinary Korean prose and would let the keyword FALLBACK path score random
// mail urgency 0.85 (a false-PUSH risk during provider outages).
export const URGENT_WORDS_RE =
  /urgent|asap|긴급|중요|action required|today|tomorrow|deadline|due|오늘|내일|마감|시급|회신\s*(필요|부탁|요망)|답장\s*부탁/i;

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
  /no[-_]?reply@|noreply@|donotreply@|notifications?@|@updates\.|@email\.|@notifications\./i;

/** No-reply / do-not-reply machine sender (from). Case-insensitive: real
 * automated senders write "No-Reply@" / "DoNotReply@" as often as lowercase —
 * a case-sensitive match let a mixed-case appointment notice through the
 * commitment-mining gate (founder screen 2026-07-22). */
const NO_REPLY_RE = /no[-_]?reply@|donotreply@/i;

/**
 * No-reply sender check — a machine address that never carries an interpersonal
 * promise. Narrower than SYSTEM_NOTIFICATION_RE (notifications@, updates
 * subdomains). Commitment mining used to gate on this narrow check alone so
 * project-tool relays ("Sarah will review the PR Friday" via GitHub) kept
 * flowing; the founder reversed that on 2026-07-22 after automated notices
 * kept landing on the ledger — commitment ingestion now gates the broader
 * {@link isAutomatedSender}. This narrow check remains for callers that only
 * care about "is this literally a no-reply address".
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
  return TRANSACTIONAL_SENDER_RE.test(boundedFromValue(from));
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
  // Bounded AFTER extraction: with no angle-addr the whole header is the
  // "address", and TRANSACTIONAL_SENDER_RE backtracks on a long run of role
  // tokens ('.ship' x 20k: 2.3 s per call, several calls per email).
  const addr = boundedFromValue(extractEmailAddress(from));
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

/** The keyword scorer's marketing signal on from + subject (newsletter, digest,
 * promo, 광고, 수신거부). Narrower than {@link isClearMarketing}'s subject markers
 * plus Gmail category; both stay, they feed different decisions. */
export function isKeywordMarketing(email: {
  from?: string | null;
  subject?: string | null;
}): boolean {
  return MARKETING_RE.test(
    `${(email.from || "").toLowerCase()} ${(email.subject || "").toLowerCase()}`,
  );
}

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

  const isMarketing = isKeywordMarketing(email);
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

// ─── Ontology v2 deterministic signals (tier-policy.ts TierSignals) ─────────

/// Scheduling wording, broader than MEETING_RE (which feeds the v1 keyword
/// features and must not drift): "invit" covers invite AND invitation; no
/// bare "schedule" — "scheduled maintenance" notices are INFO, not MEETING.
/// No bare "calendar"/"zoom"/"schedule"/"일정": marketing copy ("editorial
/// calendar", "zoom in on savings", "배송 일정") false-positives into a lane
/// that NOTIFIES. Korean scheduling intent needs the coordination verb.
/// No bare "meeting"/"미팅"/"회의" either (eval misses 2026-08-20): meeting
/// NOTES ("summary of decisions from the meeting") and asks that merely
/// mention one ("partner meeting moved up — send the deck") are not
/// schedulable; the noun counts only next to MEETING_CONTEXT_RE below.
const SCHEDULING_RE = /reschedul|일정 (조율|변경|조정|협의)/;
/// "invit" alone: a real ask only from a person — see isNonPersonalInvite.
const INVITE_RE = /invit/;
const MEETING_NOUN_RE = /meeting|미팅|회의/;
/// Forward-looking coordination wording that turns a meeting mention into
/// scheduling intent: proposing/confirming a time, asking availability.
const MEETING_CONTEXT_RE =
  /schedul|confirm|calendar|availab|what time|works for|시간|잡아|잡을|조율|가능/;
/// A join link in the body is scheduling intent even with a chatty subject.
const MEET_LINK_RE = /meet\.google\.com\/|zoom\.us\/j\/|teams\.microsoft\.com\/l\/meetup-join/;

/// A calendar system's invite subject: "Invitation: Board sync @ Tue Oct 27…",
/// "Updated invitation: …". Counts even from an automated sender.
const CALENDAR_INVITE_SUBJECT_RE =
  /^(?:(?:re|fwd?):\s*)?(?:updated |new )?invitation:[^@]{1,200}@/i;
/// Gmail tabs that never hold a meeting someone is asking you to attend.
const BULK_CATEGORY_LABELS = new Set(["CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS"]);
/// System accounts that send "X invited you to <workspace>" — broader than
/// isAutomatedSender, which also drives the PUSH floor and stays as is.
const INVITE_SYSTEM_SENDER_RE = /(?:^|[<\s])(?:notify|invitations?)@/i;

/** A calendar system's invitation subject ("Invitation: … @ …"), any sender. */
export function isCalendarInviteSubject(subject: string | null | undefined): boolean {
  return CALENDAR_INVITE_SUBJECT_RE.test((subject || "").trim());
}

/** True when invite wording is most likely not a meeting ask:
 *  bulk mail, a social/promotions tab, or a system account. In prod
 *  (2026-10-05..18) 28 of 30 MEETING items were LinkedIn connection
 *  invitations and referral promos, and MEETING notifies. */
function isNonPersonalInvite(email: {
  from?: string | null;
  labels?: string[] | null;
  hasListUnsubscribe?: boolean | null;
}): boolean {
  if (email.hasListUnsubscribe) return true;
  if (email.labels?.some((l) => BULK_CATEGORY_LABELS.has(l))) return true;
  const from = email.from || "";
  return isAutomatedSender(from) || INVITE_SYSTEM_SENDER_RE.test(boundedFromValue(from));
}

/** v2 MEETING signal: invite/reschedule wording from a person (or a calendar
 *  invite subject), a meeting noun in a time-coordination context, or an
 *  embedded meeting link. */
export function detectSchedulingIntent(email: {
  from?: string | null;
  subject?: string | null;
  snippet?: string | null;
  body?: string | null;
  labels?: string[] | null;
  hasListUnsubscribe?: boolean | null;
}): boolean {
  if (isCalendarInviteSubject(email.subject)) return true;
  const head = `${email.subject || ""} ${email.snippet || ""}`.toLowerCase();
  if (SCHEDULING_RE.test(head)) return true;
  if (INVITE_RE.test(head) && !isNonPersonalInvite(email)) return true;
  if (MEETING_NOUN_RE.test(head) && MEETING_CONTEXT_RE.test(head)) return true;
  return MEET_LINK_RE.test((email.body || "").slice(0, 4000).toLowerCase());
}

/**
 * v2 INFO signal: an automated transactional sender (receipts, alerts,
 * confirmations). Bulk marketing (List-Unsubscribe) is excluded — that is
 * SILENT's territory, and the two must not compete for the same mail.
 */
export function detectTransactionalNotice(email: {
  from?: string | null;
  hasListUnsubscribe?: boolean | null;
}): boolean {
  if (email.hasListUnsubscribe) return false;
  return isAutomatedSender(email.from || "");
}
