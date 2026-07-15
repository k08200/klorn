/**
 * Email priority + reply classification (keyword-based, fast path).
 *
 * Pure functions extracted from email-sync.ts (M3 god-file decomposition).
 * No DB, no Gmail, no LLM — these are the deterministic keyword heuristics the
 * firewall judge falls back to and the persist path uses to stamp priority.
 * Keep it dependency-light: it must NOT import email-sync.ts (would cycle).
 */

import { extractEmailAddress } from "./email-address.js";

// ─── Priority Classification (keyword-based, fast) ────────────────────────

export interface PriorityClassification {
  priority: "URGENT" | "NORMAL" | "LOW";
  reason: string;
  signals: string[];
}

export interface NeedsReplyClassification {
  needsReply: boolean;
  reason: string;
  confidence: number;
}

function senderLooksLikeInvestor(from: string): boolean {
  return (
    from.includes(".vc") ||
    from.includes(" vc") ||
    from.includes("capital") ||
    from.includes("ventures") ||
    from.includes("investor") ||
    from.includes("fund") ||
    from.includes("partners")
  );
}

function subjectLooksInvestorCritical(subject: string): boolean {
  return (
    subject.includes("term sheet") ||
    subject.includes("safe") ||
    subject.includes("seed") ||
    subject.includes("series a") ||
    subject.includes("투자") ||
    subject.includes("텀시트")
  );
}

function subjectHasDeadline(subject: string): boolean {
  return (
    subject.includes("urgent") ||
    subject.includes("긴급") ||
    subject.includes("asap") ||
    subject.includes("action required") ||
    subject.includes("response required") ||
    subject.includes("response needed") ||
    subject.includes("today") ||
    subject.includes("tomorrow") ||
    subject.includes("by eod") ||
    subject.includes("eod") ||
    subject.includes("오늘까지") ||
    subject.includes("내일까지") ||
    subject.includes("즉시") ||
    subject.includes("급함") ||
    subject.includes("빠른 회신") ||
    subject.includes("빠른 답변") ||
    subject.includes("중요") ||
    subject.includes("deadline") ||
    subject.includes("expir")
  );
}

// Exported for unit testing — heuristic-only, runs before LLM summarization.
// Order matters: check LOW signals first to short-circuit promotional traffic
// before any URGENT keyword check (so a marketing subject like "긴급 할인!"
// stays LOW instead of getting flagged as URGENT).
export function classifyPriorityDetailed(
  from: string,
  subject: string,
  labels: string[] = [],
): PriorityClassification {
  const f = from.toLowerCase();
  const s = subject.toLowerCase();

  // Gmail category labels — promotions/social/forums are always LOW
  if (
    labels.includes("CATEGORY_PROMOTIONS") ||
    labels.includes("CATEGORY_SOCIAL") ||
    labels.includes("CATEGORY_FORUMS") ||
    labels.includes("SPAM") ||
    labels.includes("TRASH")
  ) {
    return { priority: "LOW", reason: "gmail_low_priority_label", signals: labels };
  }

  // Low priority signals (automated/newsletter/ads). Updated 2026-05-19:
  // add invoice@ / billing@ / receipts@ / bounce(s)@ / do-not-reply / 알림@
  // — these all routinely escaped the gate before and got upgraded to
  // NORMAL on the LLM pass.
  if (
    f.includes("noreply") ||
    f.includes("no-reply") ||
    f.includes("donotreply") ||
    f.includes("do-not-reply") ||
    f.includes("do_not_reply") ||
    f.includes("newsletter") ||
    f.includes("marketing") ||
    f.includes("digest") ||
    f.includes("notification") ||
    f.includes("promo") ||
    f.includes("info@") ||
    f.includes("news@") ||
    f.includes("updates@") ||
    f.includes("support@") ||
    f.includes("hello@") ||
    f.includes("team@") ||
    f.includes("mailer-daemon") ||
    f.includes("postmaster") ||
    f.includes("bounce@") ||
    f.includes("bounces@") ||
    f.includes("invoice@") ||
    f.includes("receipts@") ||
    f.includes("receipt@") ||
    f.includes("billing@") ||
    s.includes("unsubscribe") ||
    s.includes("수신거부") ||
    s.includes("광고") ||
    s.includes("[ad]") ||
    s.includes("[광고]") ||
    s.includes("할인") ||
    s.includes("coupon") ||
    s.includes("sale") ||
    s.includes("offer") ||
    s.includes("deal") ||
    s.includes("promotion") ||
    s.includes("welcome to") ||
    s.includes("verify your") ||
    s.includes("confirm your")
  ) {
    return {
      priority: "LOW",
      reason: "automated_or_promotional_signal",
      signals: [f, s].filter(Boolean),
    };
  }

  if (senderLooksLikeInvestor(f) && (subjectLooksInvestorCritical(s) || subjectHasDeadline(s))) {
    return {
      priority: "URGENT",
      reason: "investor_deadline_or_fundraising_signal",
      signals: [from, subject],
    };
  }

  // Urgent signals — explicit deadlines or time pressure
  if (subjectHasDeadline(s)) {
    return { priority: "URGENT", reason: "deadline_or_time_pressure", signals: [subject] };
  }

  // Medium signals → NORMAL
  if (
    s.includes("invoice") ||
    s.includes("payment") ||
    s.includes("계약") ||
    s.includes("meeting") ||
    s.includes("미팅") ||
    s.includes("회의") ||
    s.includes("re:") ||
    s.includes("회신") ||
    s.includes("답장") ||
    s.includes("문의")
  ) {
    return { priority: "NORMAL", reason: "reply_or_business_context", signals: [subject] };
  }

  return { priority: "NORMAL", reason: "default", signals: [] };
}

export function classifyPriority(
  from: string,
  subject: string,
  labels: string[] = [],
): "URGENT" | "NORMAL" | "LOW" {
  return classifyPriorityDetailed(from, subject, labels).priority;
}

export function classifyNeedsReplyFromSignals(input: {
  from: string;
  subject: string;
  labels?: string[];
  category?: string | null;
  actionItems?: string[];
  priority?: "URGENT" | "NORMAL" | "LOW";
  /**
   * Email of the inbox owner. When the message is sent by the owner to
   * themselves (a frequent dogfood pattern — test mails, drafts, todos sent
   * to self), it should never be flagged as needing a reply.
   */
  userEmail?: string | null;
}): NeedsReplyClassification {
  const from = input.from.toLowerCase();
  const subject = input.subject.toLowerCase();
  const labels = input.labels ?? [];
  const actionItems = input.actionItems ?? [];
  const category = input.category ?? null;

  if (input.userEmail) {
    const senderAddr = extractEmailAddress(input.from);
    if (senderAddr && senderAddr === input.userEmail.trim().toLowerCase()) {
      return { needsReply: false, reason: "self_sent", confidence: 0.95 };
    }
  }

  if (
    labels.includes("CATEGORY_PROMOTIONS") ||
    labels.includes("CATEGORY_SOCIAL") ||
    labels.includes("SPAM") ||
    labels.includes("TRASH") ||
    category === "automated" ||
    category === "newsletter" ||
    category === "system" ||
    from.includes("noreply") ||
    from.includes("no-reply") ||
    from.includes("donotreply") ||
    from.includes("newsletter") ||
    from.includes("notification") ||
    from.includes("mailer-daemon")
  ) {
    return { needsReply: false, reason: "automated_or_low_value_sender", confidence: 0.9 };
  }

  if (actionItems.length > 0) {
    return { needsReply: true, reason: "action_items_present", confidence: 0.85 };
  }

  if (
    subject.includes("reply") ||
    subject.includes("response") ||
    subject.includes("답장") ||
    subject.includes("회신") ||
    subject.includes("확인 부탁") ||
    subject.includes("가능") ||
    subject.includes("문의")
  ) {
    return { needsReply: true, reason: "reply_language_in_subject", confidence: 0.7 };
  }

  if (
    input.priority === "URGENT" &&
    category &&
    ["business", "meeting", "conversation"].includes(category)
  ) {
    return { needsReply: true, reason: "urgent_human_context", confidence: 0.65 };
  }

  return { needsReply: false, reason: "no_reply_signal", confidence: 0.55 };
}
