/**
 * LLM-based email triage.
 *
 * Replaces the keyword-only classifier that missed investor follow-ups and
 * over-indexed on subject lines. A single batched LLM call labels up to 15
 * emails at once so cost stays within a cent per classification pass.
 *
 * Fallbacks to a keyword heuristic when the LLM call fails so the agent
 * never silently stops classifying.
 */

import { createCompletion, MODEL } from "./openai.js";
import { captureError } from "./sentry.js";

export type EmailPriority = "high" | "medium" | "low";
export type EmailCategory =
  | "investor"
  | "customer"
  | "meeting"
  | "internal"
  | "system"
  | "automated"
  | "conversation"
  | "other";

export interface ClassifiableEmail {
  id?: string | null;
  from: string;
  subject: string;
  snippet?: string | null;
}

export interface ClassifiedLabel {
  priority: EmailPriority;
  category: EmailCategory;
  needsReply: boolean;
  reason?: string;
}

const PRIORITY_ORDER: Record<EmailPriority, number> = { high: 0, medium: 1, low: 2 };

const SYSTEM_SENDER_PATTERNS = [
  /no[-_]?reply@/i,
  /noreply@/i,
  /mailer-daemon@/i,
  /postmaster@/i,
  /notifications?@/i,
  /alerts?@/i,
  /security@/i,
  /billing@/i,
  /receipts?@/i,
  /newsletter@/i,
];

/** Cheap deterministic classifier for obvious cases so we skip the LLM call. */
function fastClassify(email: ClassifiableEmail): ClassifiedLabel | null {
  const from = email.from || "";
  const subject = (email.subject || "").toLowerCase();

  if (SYSTEM_SENDER_PATTERNS.some((p) => p.test(from))) {
    const isSecurity = /security|verify|sign[- ]?in|unusual activity|알림/i.test(
      `${from} ${email.subject}`,
    );
    return {
      priority: isSecurity ? "medium" : "low",
      category: isSecurity ? "system" : "automated",
      needsReply: false,
      reason: "automated sender",
    };
  }

  if (subject.includes("unsubscribe") || subject.startsWith("[newsletter]")) {
    return {
      priority: "low",
      category: "automated",
      needsReply: false,
      reason: "newsletter markers",
    };
  }

  return null;
}

interface LlmResponse {
  labels: Array<{
    index: number;
    priority?: EmailPriority;
    category?: EmailCategory;
    needsReply?: boolean;
    reason?: string;
  }>;
}

function buildPrompt(emails: ClassifiableEmail[]): string {
  const lines = emails.map((e, i) => {
    const snippet = (e.snippet ?? "").replace(/\s+/g, " ").slice(0, 200);
    return `[${i}] from: ${e.from}\n    subject: ${e.subject}\n    snippet: ${snippet}`;
  });

  return `You classify a work inbox. For each email below, output priority, category, and whether a reply is needed.

Categories (pick the single best fit):
- investor: VC, angel, accelerator, LP
- customer: paying user, prospect, lead
- meeting: calendar invite, scheduling thread
- internal: teammate, operator, employee, or contractor on the user's team
- system: security alerts, billing receipts, account notifications (no reply expected)
- automated: newsletters, marketing, digests
- conversation: ongoing thread that doesn't fit above
- other: everything else

Priority:
- high: investor or customer asking a question, meeting today/tomorrow, urgent keywords with a real person
- medium: response expected this week, meetings later, internal asks
- low: informational, automated, no action required

Respond with JSON only, shape: {"labels":[{"index":0,"priority":"high","category":"investor","needsReply":true,"reason":"short phrase"}]}
Include every index exactly once.

Emails:
${lines.join("\n")}`;
}

async function classifyBatchWithLlm(
  emails: ClassifiableEmail[],
  userId?: string,
): Promise<ClassifiedLabel[] | null> {
  try {
    const response = await createCompletion(
      {
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a strict JSON classifier. Respond with valid JSON only — no prose, no code fences.",
          },
          { role: "user", content: buildPrompt(emails) },
        ],
        response_format: { type: "json_object" },
      },
      userId ? { userId } : {},
    );

    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw) as LlmResponse;
    if (!Array.isArray(parsed.labels)) return null;

    const byIndex = new Map(parsed.labels.map((l) => [l.index, l]));
    return emails.map((_, i) => {
      const l = byIndex.get(i);
      return {
        priority: l?.priority ?? "low",
        category: l?.category ?? "other",
        needsReply: l?.needsReply ?? false,
        reason: l?.reason,
      };
    });
  } catch (err) {
    captureError(err, { tags: { scope: "email-classifier.llm" } });
    return null;
  }
}

/** Keyword fallback — coarse but always available when the LLM path fails. */
function keywordFallback(email: ClassifiableEmail): ClassifiedLabel {
  const from = email.from.toLowerCase();
  const subject = email.subject.toLowerCase();

  if (
    /urgent|긴급|asap|action required|중요/.test(subject) ||
    /investor|vc|capital|ventures|fund/.test(from)
  ) {
    return { priority: "high", category: "investor", needsReply: true, reason: "keyword" };
  }
  if (/invoice|payment|청구|결제/.test(subject)) {
    return { priority: "medium", category: "system", needsReply: false, reason: "keyword" };
  }
  if (/meeting|미팅|invite|calendar/.test(subject)) {
    return { priority: "medium", category: "meeting", needsReply: false, reason: "keyword" };
  }
  if (/^re:|회신/.test(subject)) {
    return { priority: "medium", category: "conversation", needsReply: true, reason: "keyword" };
  }
  return { priority: "low", category: "other", needsReply: false, reason: "keyword" };
}

/**
 * Classify a batch of emails. Ordering of the returned array matches input.
 * Emails that match a deterministic fast-path rule skip the LLM call.
 */
export async function classifyEmailBatch(
  emails: ClassifiableEmail[],
  userId?: string,
): Promise<ClassifiedLabel[]> {
  if (emails.length === 0) return [];

  const results: (ClassifiedLabel | null)[] = emails.map((e) => fastClassify(e));
  const llmIndexes = results.map((r, i) => (r === null ? i : -1)).filter((i) => i !== -1);

  if (llmIndexes.length > 0) {
    const llmInputs = llmIndexes.map((i) => emails[i]);
    const llmResults = await classifyBatchWithLlm(llmInputs, userId);

    llmIndexes.forEach((inboxIdx, batchIdx) => {
      results[inboxIdx] = llmResults?.[batchIdx] ?? keywordFallback(emails[inboxIdx]);
    });
  }

  return results.map((r, i) => r ?? keywordFallback(emails[i]));
}

/** Sort classified emails by priority, stable within tiers. */
export function sortByPriority<T extends { priority: EmailPriority }>(items: T[]): T[] {
  return [...items].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}
