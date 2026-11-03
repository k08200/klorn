/**
 * The v3 facts shadow (docs/design/attention-engine-v3.md §5 "Shadow mode",
 * phase P2). Runs after the v2 judge on new mail when JUDGE_V3_SHADOW is on for
 * the user, and stores facts + relationship in AttentionFacts. It never changes
 * what the user sees and never throws: every outcome is a return value.
 *
 * Skipped for users on their own provider key (BYOK): an experiment the user
 * cannot see must not spend their key or send their mail to a provider they
 * did not choose. Stopped at the budget floor (shadow-budget.ts).
 */

import { db } from "../../db.js";
import { getUserLlmCredentials } from "../../llm/llm-credentials.js";
import type { GmailRawEmail } from "../../mail/gmail-fetch.js";
import { isAuthenticatedSender } from "../../mail/klorn-inbound-map.js";
import type { ProviderCredentials } from "../../providers/index.js";
import { captureError } from "../../sentry.js";
import {
  type ExtractFactsOptions,
  extractFacts,
  type FactsExtraction,
  type FactsMailInput,
} from "./facts-extractor.js";
import { type StoreFactsInput, saveAttentionFacts } from "./facts-store.js";
import { isJudgeV3ShadowEnabled } from "./flags.js";
import type { RelationshipSnapshot } from "./relationship.js";
import { loadRelationshipSnapshot, SENT_EVIDENCE_WHERE } from "./relationship-loader.js";
import { type BudgetVerdict, shadowBudgetVerdict, withShadowSlot } from "./shadow-budget.js";

export interface ShadowMail {
  emailId: string;
  threadId: string | null;
  from: string;
  to: string | null;
  cc: string | null;
  subject: string | null;
  snippet: string | null;
  body: string | null;
  labels: string[];
  receivedAt: Date;
  hasListUnsubscribe: boolean | null;
  listId: string | null;
  precedence: string | null;
  autoSubmitted: string | null;
  dateHeader: string | null;
  hasCalendarInvite: boolean | null;
  /** DMARC pass for the From domain: Gmail's verdict, or the Klorn mailbox's. */
  senderAuthenticated: boolean | null;
}

/** The shadow's view of a freshly ingested message (any provider). */
export function shadowMailFromRaw(emailId: string, email: GmailRawEmail): ShadowMail {
  return {
    emailId,
    threadId: email.threadId,
    from: email.from,
    to: email.to || null,
    cc: email.cc || null,
    subject: email.subject,
    snippet: email.snippet,
    body: email.body,
    labels: email.labels,
    receivedAt: email.receivedAt,
    hasListUnsubscribe: email.hasListUnsubscribe ?? null,
    listId: email.listId ?? null,
    precedence: email.precedence ?? null,
    autoSubmitted: email.autoSubmitted ?? null,
    dateHeader: email.dateHeader ?? null,
    senderAuthenticated:
      email.dmarcPass ??
      (email.authentication ? isAuthenticatedSender(email.authentication) : null),
    // Gmail walks every MIME part; other producers report named attachments
    // only, so without one the answer is unknown (null), not "no invite".
    hasCalendarInvite:
      email.hasCalendarInvite ??
      (email.attachments.some(
        (a) => a.mimeType === "text/calendar" || a.filename.toLowerCase().endsWith(".ics"),
      )
        ? true
        : null),
  };
}

export type ShadowOutcome =
  | "disabled"
  | "byok"
  | "busy"
  | Exclude<BudgetVerdict, "ok">
  | "stored"
  | "stopped"
  | "failed";

export interface ShadowDeps {
  enabled(userId: string): boolean;
  usesOwnKey(userId: string): Promise<boolean>;
  budget(userId: string): Promise<BudgetVerdict>;
  /** Runs fn when a shadow slot is free; null when busy (skip, never queue). */
  slot<T>(fn: () => Promise<T>): Promise<T | null>;
  userContext(userId: string): Promise<{ userAddresses: string[]; timeZone: string | null }>;
  repliedAfter(userId: string, threadId: string, after: Date): Promise<boolean>;
  extract(input: FactsMailInput, options: ExtractFactsOptions): Promise<FactsExtraction>;
  relationship(
    userId: string,
    senderAddress: string,
    userAddresses: string[],
    senderAuthenticated: boolean | null,
    excludeEmailId: string,
  ): Promise<RelationshipSnapshot | null>;
  save(input: StoreFactsInput): Promise<void>;
  now(): Date;
}

const BUDGET_STOP_ERRORS = new Set(["DailyCostCapExceededError", "UserRateLimitedError"]);
const PACER_BUSY_ERROR = "PacerBusyError";

function hasOwnKey(c: ProviderCredentials): boolean {
  return Boolean(c.openRouterApiKey || c.geminiApiKey || c.openAiApiKey || c.anthropicApiKey);
}

export const prismaShadowDeps: ShadowDeps = {
  enabled: isJudgeV3ShadowEnabled,
  usesOwnKey: async (userId) => hasOwnKey(await getUserLlmCredentials(userId)),
  budget: (userId) => shadowBudgetVerdict(userId),
  slot: withShadowSlot,
  async userContext(userId) {
    const [user, linked, automation] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { email: true } }),
      db.linkedInboxAccount.findMany({ where: { userId }, select: { email: true } }),
      db.automationConfig.findUnique({ where: { userId }, select: { timezone: true } }),
    ]);
    const addresses = [user?.email, ...linked.map((l) => l.email)].filter(
      (a): a is string => typeof a === "string" && a.includes("@"),
    );
    return { userAddresses: [...new Set(addresses)], timeZone: automation?.timezone ?? null };
  },
  async repliedAfter(userId, threadId, after) {
    const row = await db.sentMessage.findFirst({
      // Klorn's own auto-replies are not the user answering (#1591).
      where: { userId, threadId, sentAt: { gt: after }, ...SENT_EVIDENCE_WHERE },
      select: { id: true },
    });
    return row !== null;
  },
  extract: extractFacts,
  relationship: (userId, senderAddress, userAddresses, senderAuthenticated, excludeEmailId) =>
    loadRelationshipSnapshot({
      userId,
      senderAddress,
      userAddresses,
      senderAuthenticated,
      excludeEmailId,
    }),
  save: (input) => saveAttentionFacts(input),
  now: () => new Date(),
};

async function buildInput(userId: string, mail: ShadowMail, deps: ShadowDeps) {
  const ctx = await deps.userContext(userId);
  const userRepliedAfter = mail.threadId
    ? await deps.repliedAfter(userId, mail.threadId, mail.receivedAt)
    : null;
  const input: FactsMailInput = {
    from: mail.from,
    to: mail.to,
    cc: mail.cc,
    userAddresses: ctx.userAddresses,
    subject: mail.subject,
    snippet: mail.snippet,
    body: mail.body,
    labels: mail.labels,
    hasListUnsubscribe: mail.hasListUnsubscribe,
    listId: mail.listId,
    precedence: mail.precedence,
    autoSubmitted: mail.autoSubmitted,
    hasCalendarInvite: mail.hasCalendarInvite,
    userRepliedAfter,
    senderAuthenticated: mail.senderAuthenticated,
    dateHeader: mail.dateHeader,
    receivedAt: mail.receivedAt,
    userTimeZone: ctx.timeZone,
  };
  return { input, userAddresses: ctx.userAddresses };
}

async function extractAndStore(
  userId: string,
  mail: ShadowMail,
  v2Tier: string | null,
  deps: ShadowDeps,
): Promise<"stored"> {
  const { input, userAddresses } = await buildInput(userId, mail, deps);
  // noWait: the model call claims a pacer slot at once or throws PacerBusyError;
  // it never queues behind (or in front of) the judge.
  const extraction = await deps.extract(input, { userId, noWait: true });
  const relationship = await deps.relationship(
    userId,
    mail.from,
    userAddresses,
    mail.senderAuthenticated,
    mail.emailId,
  );
  await deps.save({
    userId,
    source: "EMAIL",
    sourceId: mail.emailId,
    extraction,
    relationship,
    v2Tier,
    extractedAt: deps.now(),
  });
  return "stored";
}

async function shadowOnce(
  userId: string,
  mail: ShadowMail,
  v2Tier: string | null,
  deps: ShadowDeps,
): Promise<ShadowOutcome> {
  if (!deps.enabled(userId)) return "disabled";
  if (await deps.usesOwnKey(userId)) return "byok";
  // Slot first: a mail that would be "busy" costs no budget queries.
  const outcome = await deps.slot(async (): Promise<ShadowOutcome> => {
    const budget = await deps.budget(userId);
    if (budget !== "ok") return budget;
    return extractAndStore(userId, mail, v2Tier, deps);
  });
  return outcome ?? "busy";
}

const outcomeCounts = new Map<ShadowOutcome, number>();
const OUTCOME_LOG_EVERY = 100;
let outcomesSinceLog = 0;

/** Outcomes since boot, so skipped mail is visible (the report only sees stored rows). */
export function shadowOutcomeCounts(): Record<string, number> {
  return Object.fromEntries(outcomeCounts);
}

function countOutcome(outcome: ShadowOutcome): ShadowOutcome {
  if (outcome === "disabled") return outcome;
  outcomeCounts.set(outcome, (outcomeCounts.get(outcome) ?? 0) + 1);
  if (++outcomesSinceLog >= OUTCOME_LOG_EVERY) {
    outcomesSinceLog = 0;
    console.log(
      "[judge-v3] facts shadow outcomes since boot:",
      JSON.stringify(shadowOutcomeCounts()),
    );
  }
  return outcome;
}

export async function runFactsShadow(
  userId: string,
  mail: ShadowMail,
  v2Tier: string | null,
  deps: ShadowDeps = prismaShadowDeps,
): Promise<ShadowOutcome> {
  try {
    return countOutcome(await shadowOnce(userId, mail, v2Tier, deps));
  } catch (err) {
    if (err instanceof Error && err.name === PACER_BUSY_ERROR) return countOutcome("pacer_busy");
    if (err instanceof Error && BUDGET_STOP_ERRORS.has(err.name)) return countOutcome("stopped");
    // Name and ids only: a DB or provider message can echo values.
    const name = err instanceof Error ? err.name : "unknown";
    console.warn("[judge-v3] facts shadow failed:", name);
    captureError(new Error(`judge-v3 facts shadow failed: ${name}`), {
      tags: { scope: "judge-v3-shadow" },
      extra: { userId, emailId: mail.emailId },
    });
    return countOutcome("failed");
  }
}
