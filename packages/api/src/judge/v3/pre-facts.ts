/**
 * Deterministic pre-facts for facts v1 (docs/design/attention-engine-v3.md
 * §3(1): "Deterministic pre-facts win when certain"). No DB, no LLM: the same
 * input always gives the same answer, so replay and the keyword fallback can
 * call this directly.
 *
 * Detectors are reused from keyword-policy.ts, the single source of truth for
 * the no-LLM vocabulary. This file only decides which of them are strong
 * enough to fix a fact field outright (`certain`); everything else is left
 * for the model, with the detector results passed along as `signals`.
 */

import { parseAddress, splitAddressList } from "../../mail/email-address.js";
import {
  detectSchedulingIntent,
  isAutomatedSender,
  isCalendarInviteSubject,
  isClearMarketing,
  isNoReplySender,
  isTransactionalSender,
} from "../keyword-policy.js";
import type { FactField, FactsV1 } from "./facts-schema.js";

export interface PreFactsInput {
  from: string;
  /** Raw To header value. */
  to: string | null;
  /** Raw Cc header value. */
  cc: string | null;
  /** Every address the user receives at (account + linked inboxes), any case. */
  userAddresses: readonly string[];
  subject: string | null;
  snippet: string | null;
  body: string | null;
  /** Provider labels; Gmail labelIds including CATEGORY_* and SPAM. */
  labels: readonly string[] | null;
  hasListUnsubscribe: boolean | null;
  listId: string | null;
  precedence: string | null;
  autoSubmitted: string | null;
  /** A text/calendar part or .ics attachment is present. */
  hasCalendarInvite: boolean | null;
  /** The user sent a message in this thread after this mail (null = unknown). */
  userRepliedAfter: boolean | null;
}

export interface PreFactSignals {
  automatedSender: boolean;
  noReplySender: boolean;
  transactionalSender: boolean;
  clearMarketing: boolean;
  listMail: boolean;
  autoSubmitted: boolean;
  spam: boolean;
  gmailCategory: string | null;
  calendarInvite: boolean;
  schedulingIntent: boolean;
  userInTo: boolean | null;
  userInCc: boolean | null;
  /** To + Cc recipients other than the user (null when the user is unknown). */
  otherRecipients: number | null;
}

export interface PreFacts {
  facts: Partial<FactsV1>;
  /** Fields fixed by deterministic evidence; the model's value is discarded. */
  certain: FactField[];
  signals: PreFactSignals;
}

/** Up to this many other people on To still counts as written to the user. */
export const DIRECT_MAX_OTHER_RECIPIENTS = 5;
/** Up to this many other people still counts as a personal Cc. */
export const CC_MAX_OTHER_RECIPIENTS = 10;

const BULK_PRECEDENCE = new Set(["bulk", "list", "junk"]);
const GMAIL_CATEGORIES = [
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
  "CATEGORY_UPDATES",
  "CATEGORY_PERSONAL",
] as const;

function addressesOf(header: string | null): string[] {
  if (!header) return [];
  return splitAddressList(header)
    .map((entry) => parseAddress(entry).toLowerCase())
    .filter((a) => a !== "");
}

function recipientSignals(input: PreFactsInput) {
  const mine = new Set(input.userAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean));
  if (mine.size === 0) return { userInTo: null, userInCc: null, otherRecipients: null };
  const to = addressesOf(input.to);
  const cc = addressesOf(input.cc);
  const others = new Set([...to, ...cc].filter((a) => !mine.has(a)));
  return {
    userInTo: to.some((a) => mine.has(a)),
    userInCc: cc.some((a) => mine.has(a)),
    otherRecipients: others.size,
  };
}

export function collectPreFactSignals(input: PreFactsInput): PreFactSignals {
  const labels = input.labels ?? [];
  const from = input.from ?? "";
  const precedence = (input.precedence ?? "").trim().toLowerCase();
  const autoSubmitted = (input.autoSubmitted ?? "").trim().toLowerCase();
  const subject = (input.subject ?? "").trim();
  return {
    automatedSender: isAutomatedSender(from),
    noReplySender: isNoReplySender(from),
    transactionalSender: isTransactionalSender(from),
    clearMarketing: isClearMarketing({ labels: [...labels], subject }),
    listMail:
      input.hasListUnsubscribe === true ||
      Boolean(input.listId?.trim()) ||
      BULK_PRECEDENCE.has(precedence),
    autoSubmitted: autoSubmitted !== "" && autoSubmitted !== "no",
    spam: labels.includes("SPAM"),
    gmailCategory: GMAIL_CATEGORIES.find((c) => labels.includes(c)) ?? null,
    calendarInvite: input.hasCalendarInvite === true || isCalendarInviteSubject(subject),
    schedulingIntent: detectSchedulingIntent({
      from,
      subject: input.subject,
      snippet: input.snippet,
      body: input.body,
      labels: [...labels],
      hasListUnsubscribe: input.hasListUnsubscribe,
    }),
    ...recipientSignals(input),
  };
}

function addressedToOf(s: PreFactSignals): FactsV1["addressedTo"] | undefined {
  const bulkCategory =
    s.gmailCategory === "CATEGORY_PROMOTIONS" || s.gmailCategory === "CATEGORY_SOCIAL";
  if (s.spam || s.listMail || bulkCategory) return "bulk";
  if (s.gmailCategory === "CATEGORY_FORUMS") return "group";
  if (s.otherRecipients === null) return undefined;
  if (s.userInTo) return s.otherRecipients <= DIRECT_MAX_OTHER_RECIPIENTS ? "me_direct" : "group";
  if (s.userInCc) return s.otherRecipients <= CC_MAX_OTHER_RECIPIENTS ? "me_cc" : "group";
  // Not on To/Cc: Bcc, an alias we don't know, or a list without headers.
  return undefined;
}

function kindOf(s: PreFactSignals, bulk: boolean): FactsV1["kind"] | undefined {
  if (s.spam || s.gmailCategory === "CATEGORY_PROMOTIONS" || s.clearMarketing) return "promotion";
  if (s.gmailCategory === "CATEGORY_SOCIAL") return "notification";
  if (s.calendarInvite && !bulk) return "meeting";
  return undefined;
}

function threadTurnOf(
  s: PreFactSignals,
  bulk: boolean,
  userRepliedAfter: boolean | null,
): FactsV1["threadTurn"] | undefined {
  if (bulk || s.noReplySender) return "none";
  if (userRepliedAfter === true) return "theirs";
  return undefined;
}

export function deterministicPreFacts(input: PreFactsInput): PreFacts {
  const signals = collectPreFactSignals(input);
  const facts: Partial<FactsV1> = {};
  const certain: FactField[] = [];
  const fix = <K extends FactField>(field: K, value: FactsV1[K] | undefined) => {
    if (value === undefined) return;
    facts[field] = value;
    certain.push(field);
  };

  const addressedTo = addressedToOf(signals);
  const bulk = addressedTo === "bulk";
  fix("addressedTo", addressedTo);
  fix("kind", kindOf(signals, bulk));
  fix("threadTurn", threadTurnOf(signals, bulk, input.userRepliedAfter));
  if (signals.calendarInvite && !bulk) {
    fix("event", { proposedTimes: [], hasInvite: true, conflict: null });
  }
  // Gmail spam is never a genuine request to the user.
  if (signals.spam) fix("asks", []);

  return { facts, certain, signals };
}
