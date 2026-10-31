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
import { loadRelationshipSnapshot } from "./relationship-loader.js";
import { shadowBudgetAllows } from "./shadow-budget.js";

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
      email.dmarcPass ?? (email.authentication ? email.authentication.dmarc === "pass" : null),
    // Gmail walks every MIME part; other producers report attachments only.
    hasCalendarInvite:
      email.hasCalendarInvite ??
      email.attachments.some(
        (a) => a.mimeType === "text/calendar" || a.filename.toLowerCase().endsWith(".ics"),
      ),
  };
}

export type ShadowOutcome = "disabled" | "byok" | "budget" | "stored" | "stopped" | "failed";

export interface ShadowDeps {
  enabled(userId: string): boolean;
  usesOwnKey(userId: string): Promise<boolean>;
  budgetAllows(userId: string): Promise<boolean>;
  userContext(userId: string): Promise<{ userAddresses: string[]; timeZone: string | null }>;
  repliedAfter(userId: string, threadId: string, after: Date): Promise<boolean>;
  extract(input: FactsMailInput, options: ExtractFactsOptions): Promise<FactsExtraction>;
  relationship(
    userId: string,
    senderAddress: string,
    userAddresses: string[],
    senderAuthenticated: boolean | null,
  ): Promise<RelationshipSnapshot | null>;
  save(input: StoreFactsInput): Promise<void>;
  now(): Date;
}

const BUDGET_STOP_ERRORS = new Set(["DailyCostCapExceededError", "UserRateLimitedError"]);

function hasOwnKey(c: ProviderCredentials): boolean {
  return Boolean(c.openRouterApiKey || c.geminiApiKey || c.openAiApiKey || c.anthropicApiKey);
}

export const prismaShadowDeps: ShadowDeps = {
  enabled: isJudgeV3ShadowEnabled,
  usesOwnKey: async (userId) => hasOwnKey(await getUserLlmCredentials(userId)),
  budgetAllows: shadowBudgetAllows,
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
      where: { userId, threadId, sentAt: { gt: after } },
      select: { id: true },
    });
    return row !== null;
  },
  extract: extractFacts,
  relationship: (userId, senderAddress, userAddresses, senderAuthenticated) =>
    loadRelationshipSnapshot({ userId, senderAddress, userAddresses, senderAuthenticated }),
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

async function shadowOnce(
  userId: string,
  mail: ShadowMail,
  v2Tier: string | null,
  deps: ShadowDeps,
): Promise<ShadowOutcome> {
  if (!deps.enabled(userId)) return "disabled";
  if (await deps.usesOwnKey(userId)) return "byok";
  if (!(await deps.budgetAllows(userId))) return "budget";
  const { input, userAddresses } = await buildInput(userId, mail, deps);
  const extraction = await deps.extract(input, { userId });
  const relationship = await deps.relationship(
    userId,
    mail.from,
    userAddresses,
    mail.senderAuthenticated,
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

export async function runFactsShadow(
  userId: string,
  mail: ShadowMail,
  v2Tier: string | null,
  deps: ShadowDeps = prismaShadowDeps,
): Promise<ShadowOutcome> {
  try {
    return await shadowOnce(userId, mail, v2Tier, deps);
  } catch (err) {
    if (err instanceof Error && BUDGET_STOP_ERRORS.has(err.name)) return "stopped";
    // Ids only: never the mail, the prompt or the model answer.
    console.warn("[judge-v3] facts shadow failed:", err instanceof Error ? err.name : "unknown");
    captureError(err, {
      tags: { scope: "judge-v3-shadow" },
      extra: { userId, emailId: mail.emailId },
    });
    return "failed";
  }
}
