/**
 * Email API — Gmail integration with DB persistence, AI summarization,
 * thread grouping, search, and auto-reply rules.
 *
 * v2: All reads go through local DB (synced from Gmail).
 * Falls back to demo data when Gmail isn't connected.
 */

import type { EmailMessage, FeedbackSignal, Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import {
  analyzePendingEmailAttachments,
  buildAttachmentCandidateProfile,
  listCandidateProfilesByEmail,
  listEmailAttachments,
  summarizeEmailAttachmentsByEmail,
} from "../email-attachments.js";
import {
  listCandidateIntakesByEmail,
  syncCandidateIntakeForEmail,
  syncRecentCandidateIntakes,
} from "../email-candidate-intake.js";
import type { FeedbackRecord } from "../email-label-feedback.js";
import {
  getEmailThreads,
  reconcileEmails,
  summarizeUnsummarizedEmails,
  syncEmails,
} from "../email-sync.js";
import { toggleReadGmail } from "../gmail.js";
import { senderEmail } from "../notification-format.js";
import { captureError } from "../sentry.js";
import { getTrustScore, getTrustScoresBulk, type TrustScoreResult } from "../trust-score.js";
import { registerEmailAttachmentsRoutes } from "./email-attachments.js";
import { registerEmailBulkRoutes } from "./email-bulk.js";
import { registerEmailCandidatesRoutes } from "./email-candidates.js";
import { registerEmailFeedbackRoutes } from "./email-feedback.js";
import { registerEmailMutationsRoutes } from "./email-mutations.js";
import { registerEmailRepliesRoutes } from "./email-replies.js";
import { registerEmailRulesRoutes } from "./email-rules.js";

/**
 * Slice of TrustScoreResult that we ship to the inbox UI. Keeping this
 * compact (no avgDelayDays / lateCount) so list payloads stay small —
 * details live in /contacts/:id when the user wants the full picture.
 */
function trustToWire(t: TrustScoreResult | undefined | null) {
  if (!t) return null;
  return {
    badge: t.badge,
    label: t.label,
    onTimeRate: t.onTimeRate,
    totalCount: t.totalCount,
  };
}

// ─── Demo Data ────────────────────────────────────────────────────────────

const DEMO_EMAILS = [
  {
    id: "demo-1",
    gmailId: "demo-1",
    threadId: "thread-1",
    from: "investor@vc.com",
    to: "me@startup.com",
    subject: "Follow-up: Series A Discussion",
    snippet: "Hi, I wanted to follow up on our conversation last week about the Series A round...",
    body: "Hi,\n\nI wanted to follow up on our conversation last week about the Series A round. We're very interested in leading the round and would love to schedule a call this week to discuss terms.\n\nBest,\nInvestor",
    date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    labels: ["INBOX", "IMPORTANT"],
    isRead: false,
    isStarred: false,
    priority: "URGENT" as const,
    category: "business",
    summary: "Series A investor follow-up meeting request",
    keyPoints: ["Interested in leading the Series A", "Requested a call this week"],
    actionItems: ["Schedule a call with the investor"],
    sentiment: "positive",
    receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "demo-2",
    gmailId: "demo-2",
    threadId: "thread-2",
    from: "team@notion.so",
    to: "me@startup.com",
    subject: "Your weekly Notion digest",
    snippet:
      "Here's what happened in your workspace this week: 12 pages updated, 3 new databases...",
    body: "Here's what happened in your workspace this week:\n- 12 pages updated\n- 3 new databases created\n- 5 new members joined",
    date: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    labels: ["INBOX"],
    isRead: true,
    isStarred: false,
    priority: "LOW" as const,
    category: "automated",
    summary: "Weekly Notion activity summary",
    keyPoints: ["12 pages updated", "3 databases created"],
    actionItems: [],
    sentiment: "neutral",
    receivedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "demo-3",
    gmailId: "demo-3",
    threadId: "thread-3",
    from: "partner@company.co",
    to: "me@startup.com",
    subject: "Partnership Proposal — Q2 Collaboration",
    snippet:
      "We'd love to explore a partnership opportunity with your team for the upcoming quarter...",
    body: "We'd love to explore a partnership opportunity with your team for the upcoming quarter. Our proposal includes co-marketing, API integration, and revenue sharing.",
    date: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    labels: ["INBOX"],
    isRead: false,
    isStarred: false,
    priority: "NORMAL" as const,
    category: "business",
    summary: "Q2 partnership proposal with co-marketing and API integration",
    keyPoints: ["Co-marketing proposal", "API integration", "Revenue sharing"],
    actionItems: ["Review the partnership proposal and reply"],
    sentiment: "positive",
    receivedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "demo-4",
    gmailId: "demo-4",
    threadId: "thread-4",
    from: "noreply@github.com",
    to: "me@startup.com",
    subject: "[Klorn] New pull request #42: Add calendar integration",
    snippet: "k08200 opened a new pull request in Klorn/probeai: Add calendar integration...",
    body: "k08200 opened a new pull request:\n\nAdd calendar integration\n\nThis PR adds Google Calendar sync and event management.",
    date: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    labels: ["INBOX", "CATEGORY_UPDATES"],
    isRead: true,
    isStarred: false,
    priority: "NORMAL" as const,
    category: "engineering",
    summary: "Calendar integration PR #42 opened",
    keyPoints: ["Adds Google Calendar sync", "Adds event management"],
    actionItems: ["Review the pull request"],
    sentiment: "neutral",
    receivedAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "demo-5",
    gmailId: "demo-5",
    threadId: "thread-5",
    from: "accounting@service.com",
    to: "me@startup.com",
    subject: "Invoice #INV-2026-0089 — March Services",
    snippet: "Please find attached the invoice for March 2026 services. Total: $2,450.00...",
    body: "Please find attached the invoice for March 2026 services.\n\nTotal: $2,450.00\nDue Date: April 15, 2026\n\nPayment instructions enclosed.",
    date: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    labels: ["INBOX"],
    isRead: false,
    isStarred: false,
    priority: "NORMAL" as const,
    category: "billing",
    summary: "March services invoice for $2,450 due April 15",
    keyPoints: ["$2,450 invoice", "Payment due April 15"],
    actionItems: ["Process invoice payment"],
    sentiment: "neutral",
    receivedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  },
];

/** Parse email From header */
function _parseFromHeader(from: string): { name: string; email: string } | null {
  if (!from) return null;
  const match = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return {
      name: match[1].replace(/^["']|["']$/g, "").trim(),
      email: match[2].trim().toLowerCase(),
    };
  }
  const emailOnly = from.trim().toLowerCase();
  if (emailOnly.includes("@")) {
    return { name: emailOnly.split("@")[0], email: emailOnly };
  }
  return null;
}

const SKIP_PATTERNS = [
  /noreply@/i,
  /no-reply@/i,
  /donotreply@/i,
  /notifications?@/i,
  /mailer-daemon@/i,
  /newsletter@/i,
];

// Reply-needed feedback constants and types are exported so the feedback
// sub-routes (registered via registerEmailFeedbackRoutes) can share them
// with the rest of routes/email.ts. The serializer that reads them lives
// next to the shape definitions for the same reason.
export type ReplyNeededChoice =
  | "needed"
  | "today"
  | "waiting_on_me"
  | "waiting_on_them"
  | "not_needed"
  | "later"
  | "done";

export const REPLY_NEEDED_TOOL = "reply_needed";
export const REPLY_NEEDED_CHOICES = new Set<ReplyNeededChoice>([
  "needed",
  "today",
  "waiting_on_me",
  "waiting_on_them",
  "not_needed",
  "later",
  "done",
]);
export const REPLY_SIGNAL_BY_CHOICE: Record<ReplyNeededChoice, FeedbackSignal> = {
  needed: "APPROVED",
  today: "APPROVED",
  waiting_on_me: "APPROVED",
  waiting_on_them: "SNOOZED",
  not_needed: "REJECTED",
  later: "SNOOZED",
  done: "DISMISSED",
};
export const REPLY_CHOICE_BY_SIGNAL: Partial<Record<FeedbackSignal, ReplyNeededChoice>> = {
  APPROVED: "needed",
  REJECTED: "not_needed",
  SNOOZED: "later",
  DISMISSED: "done",
};

export function serializeFeedback(row: FeedbackRecord) {
  return {
    id: row.id,
    emailId: row.emailId,
    originalPriority: row.originalPriority,
    correctedPriority: row.correctedPriority,
    reason: row.reason,
    signals: row.signals,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Accepts either a legacy JSON-stringified array (`'["a","b"]'`) or an
 * already-parsed JSONB value from Prisma. After the migration to JSONB
 * (#329, #330 chain) the columns return parsed values directly; this
 * shim keeps callers stable while we walk through fields one PR at a
 * time. Always returns a plain `string[]`.
 */
export function parseJsonArray(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Same shape-tolerant helper for object-typed JSON columns. Accepts a
 * JSON string (legacy TEXT column) or an already-parsed JSONB object.
 */
export function parseJsonRecord(value: unknown): Record<string, string | number | boolean | null> {
  if (value == null) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, string | number | boolean | null>;
  }
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, string | number | boolean | null>;
  } catch {
    return {};
  }
}

export function looksReplyNeeded(input: {
  needsReply?: boolean | null;
  priority?: string | null;
  category?: string | null;
  actionItems?: string[] | null;
  from?: string | null;
}): boolean {
  if (typeof input.needsReply === "boolean") return input.needsReply;
  if (input.from && SKIP_PATTERNS.some((pattern) => pattern.test(input.from ?? ""))) return false;
  const actionItems = input.actionItems ?? [];
  if (actionItems.length === 0) return false;
  if (input.category && ["automated", "newsletter", "system"].includes(input.category)) {
    return false;
  }
  return input.priority === "URGENT" || actionItems.length > 0;
}

type EmailQueueKey =
  | "all"
  | "reply-needed"
  | "urgent"
  | "unread"
  | "attachments"
  | "candidates"
  | "finance"
  | "legal"
  | "sales"
  | "support"
  | "automated";

function normalizeEmailQueue(value: unknown): EmailQueueKey {
  const queue = typeof value === "string" ? value : "all";
  if (
    queue === "reply-needed" ||
    queue === "urgent" ||
    queue === "unread" ||
    queue === "attachments" ||
    queue === "candidates" ||
    queue === "finance" ||
    queue === "legal" ||
    queue === "sales" ||
    queue === "support" ||
    queue === "automated"
  ) {
    return queue;
  }
  return "all";
}

function demoEmailMatchesQueue(email: (typeof DEMO_EMAILS)[number], queue: EmailQueueKey): boolean {
  if (queue === "unread") return !email.isRead;
  if (queue === "urgent") return email.priority === "URGENT";
  if (queue === "reply-needed") {
    return looksReplyNeeded({
      priority: email.priority,
      category: email.category,
      actionItems: email.actionItems,
      from: email.from,
    });
  }
  if (queue === "finance") return email.category === "billing";
  if (queue === "sales") return email.category === "business";
  if (queue === "automated") return email.category === "automated";
  if (queue === "legal")
    return /계약|서명|법무|규제|contract|legal|signature|compliance/i.test(
      `${email.subject} ${email.summary ?? ""} ${email.snippet ?? ""}`,
    );
  if (queue === "support")
    return /support|help|ticket|문의|지원|고객/i.test(
      `${email.subject} ${email.summary ?? ""} ${email.snippet ?? ""}`,
    );
  if (queue === "attachments" || queue === "candidates") return false;
  return true;
}

function buildQueueWhere(userId: string, queue: EmailQueueKey): Prisma.EmailMessageWhereInput {
  const where: Prisma.EmailMessageWhereInput = { userId };
  if (queue === "unread") where.isRead = false;
  if (queue === "urgent") where.priority = "URGENT";
  if (queue === "reply-needed") where.needsReply = true;
  if (queue === "finance") where.category = "billing";
  if (queue === "sales") where.category = "business";
  if (queue === "automated") where.category = "automated";
  if (queue === "attachments") where.attachments = { some: {} };
  if (queue === "candidates") {
    where.attachments = {
      some: {
        OR: [
          { category: { in: ["resume", "profile", "portfolio", "audition"] } },
          { filename: { contains: "resume", mode: "insensitive" } },
          { filename: { contains: "cv", mode: "insensitive" } },
          { filename: { contains: "profile", mode: "insensitive" } },
          { filename: { contains: "portfolio", mode: "insensitive" } },
          { filename: { contains: "audition", mode: "insensitive" } },
          { filename: { contains: "casting", mode: "insensitive" } },
          { filename: { contains: "showreel", mode: "insensitive" } },
          { filename: { contains: "reel", mode: "insensitive" } },
          { filename: { contains: "headshot", mode: "insensitive" } },
          { filename: { contains: "comp card", mode: "insensitive" } },
          { filename: { contains: "comp-card", mode: "insensitive" } },
          { filename: { contains: "self tape", mode: "insensitive" } },
          { filename: { contains: "self-tape", mode: "insensitive" } },
          { filename: { contains: "actor", mode: "insensitive" } },
          { filename: { contains: "model", mode: "insensitive" } },
          { filename: { contains: "이력서" } },
          { filename: { contains: "프로필" } },
          { filename: { contains: "오디션" } },
          { filename: { contains: "캐스팅" } },
          { filename: { contains: "포트폴리오" } },
          { filename: { contains: "배우" } },
          { filename: { contains: "모델" } },
          { filename: { contains: "지원서" } },
          { filename: { contains: "상반신" } },
          { filename: { contains: "전신" } },
        ],
      },
    };
  }
  if (queue === "legal") {
    where.OR = [
      { subject: { contains: "contract", mode: "insensitive" } },
      { subject: { contains: "legal", mode: "insensitive" } },
      { subject: { contains: "계약" } },
      { subject: { contains: "법무" } },
      { summary: { contains: "contract", mode: "insensitive" } },
      { summary: { contains: "legal", mode: "insensitive" } },
      { summary: { contains: "계약" } },
      { summary: { contains: "법무" } },
    ];
  }
  if (queue === "support") {
    where.OR = [
      { subject: { contains: "support", mode: "insensitive" } },
      { subject: { contains: "help", mode: "insensitive" } },
      { subject: { contains: "ticket", mode: "insensitive" } },
      { subject: { contains: "문의" } },
      { summary: { contains: "support", mode: "insensitive" } },
      { summary: { contains: "문의" } },
    ];
  }
  return where;
}

function serializeQueueEmail(email: EmailMessage) {
  const actionItems = parseJsonArray(email.actionItems);
  return {
    id: email.id,
    from: email.from,
    subject: email.subject,
    date: email.receivedAt.toISOString(),
    isRead: email.isRead,
    priority: email.priority,
    needsReply: looksReplyNeeded({
      needsReply: email.needsReply,
      priority: email.priority,
      category: email.category,
      actionItems,
      from: email.from,
    }),
  };
}

export function replyNeededSourceId(emailId: string): string {
  return `email:${emailId}:reply_needed`;
}

/**
 * OR conditions for a free-text inbox search.
 *
 * Typed as `Prisma.EmailMessageWhereInput[]` ON PURPOSE: the inbox route builds
 * its `where` as `Record<string, any>`, which let an invalid filter ship — a
 * String `contains`/`mode` filter on the JSONB `extractedFields` column, which
 * is not a valid Prisma Json filter and made the whole search query throw a
 * validation error (every `?search=` request 500'd). Keeping this builder typed
 * means the compiler now rejects any such filter at build time. Attachment text
 * is already searchable via filename / summary / contentText.
 */
export function emailSearchOr(search: string): Prisma.EmailMessageWhereInput[] {
  const ci = { contains: search, mode: "insensitive" as const };
  return [
    { subject: ci },
    { from: ci },
    { snippet: ci },
    { body: ci },
    { summary: ci },
    {
      attachments: {
        some: {
          OR: [{ filename: ci }, { summary: ci }, { contentText: ci }],
        },
      },
    },
  ];
}

export function serializeReplyFeedback(row: {
  id: string;
  signal: string;
  evidence: string | null;
  createdAt: Date;
}) {
  const parsedEvidence = parseJsonRecord(row.evidence);
  const evidenceChoice = parsedEvidence?.choice;
  const choice =
    typeof evidenceChoice === "string" &&
    REPLY_NEEDED_CHOICES.has(evidenceChoice as ReplyNeededChoice)
      ? (evidenceChoice as ReplyNeededChoice)
      : REPLY_CHOICE_BY_SIGNAL[row.signal as FeedbackSignal];
  return {
    id: row.id,
    choice,
    signal: row.signal,
    evidence: row.evidence,
    createdAt: row.createdAt.toISOString(),
  };
}

export function safeAttachmentFilename(filename: string): string {
  const trimmed = filename.replace(/[\r\n"]/g, "_").trim();
  return trimmed || "attachment";
}

export async function emailRoutes(app: FastifyInstance) {
  // Every email route is private user mail. Gate the whole plugin (including
  // the sub-route groups registered below, which share this encapsulation
  // context) so revoked/kicked tokens are rejected — bare getUserId() only
  // verifies the JWT signature and skips the device-kick + password-reset
  // epoch checks that requireAuth enforces. Registered before the routes so it
  // applies to all of them. (Sub-files keep their own per-route requireAuth for
  // standalone test registration; the double-run is idempotent.)
  app.addHook("preHandler", requireAuth);

  // Sub-route groups live in sibling files and register against the same
  // FastifyInstance + prefix so client paths stay byte-identical.
  await registerEmailRulesRoutes(app);
  await registerEmailFeedbackRoutes(app);
  await registerEmailCandidatesRoutes(app);
  await registerEmailAttachmentsRoutes(app);
  await registerEmailRepliesRoutes(app);
  await registerEmailMutationsRoutes(app);
  await registerEmailBulkRoutes(app);

  // ─── Sync & List Emails ───────────────────────────────────────────────
  // GET /api/email?filter=unread|urgent|reply-needed|attachments|candidates&search=keyword&category=billing&page=1
  app.get("/", async (request) => {
    const { filter, search, category, page } = request.query as {
      filter?: string;
      search?: string;
      category?: string;
      page?: string;
    };
    const uid = getUserId(request);
    const pageNum = parseInt(page || "1", 10);
    // Heavy-email users (~200/day) clicking "Load more" 10 times to see one
    // morning's intake was the #1 dogfood friction. 50 keeps the first
    // payload under ~25 KB once joined with attachment summaries and trust
    // scores; the cap stays as a Gmail throttle guardrail.
    const pageSize = 50;

    // Check if Gmail is connected
    const token = await prisma.userToken.findFirst({ where: { userId: uid, provider: "google" } });

    if (!token) {
      // Demo mode
      let emails = [...DEMO_EMAILS];
      if (filter === "unread") emails = emails.filter((e) => !e.isRead);
      if (filter === "urgent") emails = emails.filter((e) => e.priority === "URGENT");
      if (filter === "reply-needed") {
        emails = emails.filter((e) =>
          looksReplyNeeded({
            priority: e.priority,
            category: e.category,
            actionItems: e.actionItems,
            from: e.from,
          }),
        );
      }
      if (filter === "attachments" || filter === "candidates") emails = [];
      if (search) {
        const s = search.toLowerCase();
        emails = emails.filter(
          (e) =>
            e.subject.toLowerCase().includes(s) ||
            e.from.toLowerCase().includes(s) ||
            e.snippet.toLowerCase().includes(s),
        );
      }
      if (category) emails = emails.filter((e) => e.category === category);
      return {
        emails: emails.map((e) => ({
          ...e,
          senderEmail: senderEmail(e.from) || null,
          trust: null,
          needsReply: looksReplyNeeded({
            priority: e.priority,
            category: e.category,
            actionItems: e.actionItems,
            from: e.from,
          }),
          attachmentCount: 0,
          attachmentCandidateCount: 0,
          attachmentPendingCount: 0,
          attachmentFallbackCount: 0,
          attachmentUnsupportedCount: 0,
          attachmentCategories: [],
          attachments: [],
          candidateProfilePreview: null,
        })),
        source: "demo",
        total: emails.length,
        unread: emails.filter((e) => !e.isRead).length,
        page: 1,
      };
    }

    // Build query (reads from DB only — sync via POST /api/email/sync)
    // biome-ignore lint/suspicious/noExplicitAny: dynamic Prisma where clause
    const where: Record<string, any> = { userId: uid };
    if (filter === "unread") where.isRead = false;
    if (filter === "urgent") where.priority = "URGENT";
    if (filter === "reply-needed") {
      where.needsReply = true;
    }
    if (filter === "attachments") {
      where.attachments = { some: {} };
    }
    if (filter === "candidates") {
      where.attachments = {
        some: {
          OR: [
            { category: { in: ["resume", "profile", "portfolio", "audition"] } },
            { filename: { contains: "resume", mode: "insensitive" } },
            { filename: { contains: "cv", mode: "insensitive" } },
            { filename: { contains: "profile", mode: "insensitive" } },
            { filename: { contains: "portfolio", mode: "insensitive" } },
            { filename: { contains: "audition", mode: "insensitive" } },
            { filename: { contains: "casting", mode: "insensitive" } },
            { filename: { contains: "showreel", mode: "insensitive" } },
            { filename: { contains: "reel", mode: "insensitive" } },
            { filename: { contains: "headshot", mode: "insensitive" } },
            { filename: { contains: "comp card", mode: "insensitive" } },
            { filename: { contains: "comp-card", mode: "insensitive" } },
            { filename: { contains: "self tape", mode: "insensitive" } },
            { filename: { contains: "self-tape", mode: "insensitive" } },
            { filename: { contains: "actor", mode: "insensitive" } },
            { filename: { contains: "model", mode: "insensitive" } },
            { filename: { contains: "이력서" } },
            { filename: { contains: "프로필" } },
            { filename: { contains: "오디션" } },
            { filename: { contains: "캐스팅" } },
            { filename: { contains: "포트폴리오" } },
            { filename: { contains: "배우" } },
            { filename: { contains: "모델" } },
            { filename: { contains: "지원서" } },
            { filename: { contains: "상반신" } },
            { filename: { contains: "전신" } },
          ],
        },
      };
    }
    if (category) where.category = category;
    if (search) {
      where.OR = emailSearchOr(search);
    }

    const [emails, total, unreadCount] = await Promise.all([
      prisma.emailMessage.findMany({
        where,
        orderBy: { receivedAt: "desc" },
        skip: (pageNum - 1) * pageSize,
        take: pageSize,
      }),
      prisma.emailMessage.count({ where }),
      prisma.emailMessage.count({ where: { userId: uid, isRead: false } }),
    ]);

    // Map to API format
    const emailIds = emails.map((email) => email.id);
    const attachmentSummaries = await summarizeEmailAttachmentsByEmail(emailIds);
    const candidateProfiles = await listCandidateProfilesByEmail(emailIds);
    const candidateIntakes = await listCandidateIntakesByEmail(emailIds);
    for (const emailId of emailIds) {
      if (candidateProfiles[emailId] && !candidateIntakes[emailId]) {
        const intake = await syncCandidateIntakeForEmail({ userId: uid, emailId });
        if (intake) candidateIntakes[emailId] = intake;
      }
    }
    // Bulk-fetch Trust Scores for every unique sender on this page so the
    // inbox row can render a dot without an N+1 query per email.
    const senderAddresses = Array.from(
      new Set(emails.map((e) => senderEmail(e.from)).filter(Boolean)),
    );
    const trustMap = await getTrustScoresBulk(uid, senderAddresses);
    const mapped = emails.map((e) => {
      const actionItems = parseJsonArray(e.actionItems);
      const candidateProfile = candidateProfiles[e.id] ?? null;
      const candidateIntake = candidateIntakes[e.id] ?? null;
      const addr = senderEmail(e.from);
      return {
        id: e.id,
        gmailId: e.gmailId,
        threadId: e.threadId,
        from: e.from,
        senderEmail: addr || null,
        trust: trustToWire(addr ? trustMap.get(addr) : null),
        to: e.to,
        subject: e.subject,
        snippet: e.snippet,
        date: e.receivedAt.toISOString(),
        labels: e.labels,
        isRead: e.isRead,
        isStarred: e.isStarred,
        priority: e.priority,
        category: e.category,
        summary: e.summary,
        keyPoints: parseJsonArray(e.keyPoints),
        actionItems,
        sentiment: e.sentiment,
        needsReply: looksReplyNeeded({
          needsReply: e.needsReply,
          priority: e.priority,
          category: e.category,
          actionItems,
          from: e.from,
        }),
        attachmentCount: attachmentSummaries[e.id]?.attachmentCount ?? 0,
        attachmentCandidateCount: attachmentSummaries[e.id]?.candidateAttachmentCount ?? 0,
        attachmentPendingCount: attachmentSummaries[e.id]?.pendingAttachmentCount ?? 0,
        attachmentFallbackCount: attachmentSummaries[e.id]?.fallbackAttachmentCount ?? 0,
        attachmentUnsupportedCount: attachmentSummaries[e.id]?.unsupportedAttachmentCount ?? 0,
        attachmentCategories: attachmentSummaries[e.id]?.categories ?? [],
        candidateProfilePreview: candidateProfile
          ? {
              name: candidateProfile.name,
              role: candidateProfile.role,
              contact: candidateProfile.contact,
              summary: candidateProfile.summary,
              missingFields: candidateProfile.missingFields,
              confidence: candidateProfile.confidence,
              evidenceCount: candidateProfile.evidenceFiles.length,
              intakeStatus: candidateIntake?.status ?? null,
            }
          : null,
        candidateIntake,
      };
    });

    return { emails: mapped, source: "gmail", total, unread: unreadCount, page: pageNum };
  });

  // ─── Thread View ──────────────────────────────────────────────────────
  // GET /api/email/threads?search=keyword&priority=URGENT&unread=true&page=1
  app.get("/threads", async (request) => {
    const { search, priority, unread, category, page } = request.query as {
      search?: string;
      priority?: string;
      unread?: string;
      category?: string;
      page?: string;
    };
    const uid = getUserId(request);

    const token = await prisma.userToken.findFirst({ where: { userId: uid, provider: "google" } });
    if (!token) {
      // Demo thread view
      const threads = DEMO_EMAILS.map((e) => ({
        threadId: e.threadId,
        subject: e.subject,
        participants: [e.from],
        messageCount: 1,
        lastMessage: {
          id: e.id,
          from: e.from,
          snippet: e.snippet,
          receivedAt: e.receivedAt,
          isRead: e.isRead,
        },
        hasUnread: !e.isRead,
        latestPriority: e.priority,
        summary: e.summary,
      }));
      return { threads, total: threads.length, source: "demo" };
    }

    const pageNum = parseInt(page || "1", 10);
    // Match the /api/email pageSize bump (heavy-user friction). Threads
    // are heavier per row but a single page still fits in the same envelope.
    const pageSize = 50;
    const result = await getEmailThreads(uid, {
      search,
      priority,
      unreadOnly: unread === "true",
      category,
      skip: (pageNum - 1) * pageSize,
      take: pageSize,
    });

    return { ...result, source: "gmail", page: pageNum };
  });

  // ─── Thread Detail ────────────────────────────────────────────────────
  // GET /api/email/thread/:threadId
  app.get("/thread/:threadId", async (request) => {
    const { threadId } = request.params as { threadId: string };
    const uid = getUserId(request);

    const messages = await prisma.emailMessage.findMany({
      where: { userId: uid, threadId },
      orderBy: { receivedAt: "asc" },
    });

    if (messages.length === 0) {
      return { error: "Thread not found" };
    }
    const attachments = await listEmailAttachments(messages.map((message) => message.id));
    const attachmentsByEmail = new Map<string, typeof attachments>();
    for (const attachment of attachments) {
      const list = attachmentsByEmail.get(attachment.emailId) ?? [];
      list.push(attachment);
      attachmentsByEmail.set(attachment.emailId, list);
    }

    return {
      threadId,
      subject: messages[0].subject,
      messageCount: messages.length,
      messages: messages.map((m) => ({
        id: m.id,
        gmailId: m.gmailId,
        from: m.from,
        to: m.to,
        cc: m.cc,
        subject: m.subject,
        body: m.body,
        snippet: m.snippet,
        date: m.receivedAt.toISOString(),
        isRead: m.isRead,
        priority: m.priority,
        summary: m.summary,
        keyPoints: parseJsonArray(m.keyPoints),
        actionItems: parseJsonArray(m.actionItems),
        attachments: attachmentsByEmail.get(m.id) ?? [],
      })),
    };
  });

  // ─── Triage Continuation ──────────────────────────────────────────────
  // GET /api/email/:id/next?queue=unread
  app.get("/:id/next", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { queue } = request.query as { queue?: string };
    const queueKey = normalizeEmailQueue(queue);
    const uid = getUserId(request);

    if (id.startsWith("demo-")) {
      const currentIndex = DEMO_EMAILS.findIndex((email) => email.id === id);
      if (currentIndex === -1) return reply.code(404).send({ error: "Email not found" });
      const next = DEMO_EMAILS.slice(currentIndex + 1).find((email) =>
        demoEmailMatchesQueue(email, queueKey),
      );
      return {
        queue: queueKey,
        next: next
          ? {
              id: next.id,
              from: next.from,
              subject: next.subject,
              date: next.receivedAt,
              isRead: next.isRead,
              priority: next.priority,
              needsReply: looksReplyNeeded({
                priority: next.priority,
                category: next.category,
                actionItems: next.actionItems,
                from: next.from,
              }),
            }
          : null,
      };
    }

    const current = await prisma.emailMessage.findFirst({
      where: { userId: uid, OR: [{ id }, { gmailId: id }] },
    });
    if (!current) return reply.code(404).send({ error: "Email not found" });

    const next = await prisma.emailMessage.findFirst({
      where: {
        AND: [
          buildQueueWhere(uid, queueKey),
          {
            OR: [
              { receivedAt: { lt: current.receivedAt } },
              { receivedAt: current.receivedAt, id: { lt: current.id } },
            ],
          },
        ],
      },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    });

    return { queue: queueKey, next: next ? serializeQueueEmail(next) : null };
  });

  // ─── Single Email Detail ──────────────────────────────────────────────
  // GET /api/email/:id
  app.get("/:id", async (request) => {
    const { id } = request.params as { id: string };
    const { markRead } = request.query as { markRead?: string };
    const uid = getUserId(request);

    // Check DB first
    const dbEmail = await prisma.emailMessage.findFirst({
      where: { userId: uid, OR: [{ id }, { gmailId: id }] },
    });

    if (dbEmail) {
      // Mark-as-read is explicit. Many users rely on unread as a work queue.
      if (markRead === "true" && !dbEmail.isRead) {
        toggleReadGmail(uid, dbEmail.gmailId, true).catch((err) =>
          console.warn(`[EMAIL] toggleReadGmail failed for ${dbEmail.gmailId}`, err),
        );
        await prisma.emailMessage.update({ where: { id: dbEmail.id }, data: { isRead: true } });
      }
      const actionItems = parseJsonArray(dbEmail.actionItems);
      const attachments = await listEmailAttachments([dbEmail.id]);
      const candidateProfile = buildAttachmentCandidateProfile(attachments);
      const candidateIntake = candidateProfile
        ? await syncCandidateIntakeForEmail({ userId: uid, emailId: dbEmail.id })
        : null;
      const addr = senderEmail(dbEmail.from);
      const trust = addr ? await getTrustScore(uid, addr) : null;
      return {
        id: dbEmail.id,
        gmailId: dbEmail.gmailId,
        threadId: dbEmail.threadId,
        from: dbEmail.from,
        senderEmail: addr || null,
        trust: trustToWire(trust),
        to: dbEmail.to,
        cc: dbEmail.cc,
        subject: dbEmail.subject,
        snippet: dbEmail.snippet,
        body: dbEmail.body,
        date: dbEmail.receivedAt.toISOString(),
        labels: dbEmail.labels,
        isRead: markRead === "true" ? true : dbEmail.isRead,
        isStarred: dbEmail.isStarred,
        priority: dbEmail.priority,
        category: dbEmail.category,
        summary: dbEmail.summary,
        keyPoints: parseJsonArray(dbEmail.keyPoints),
        actionItems,
        sentiment: dbEmail.sentiment,
        needsReplyReason: dbEmail.needsReplyReason,
        needsReplyConfidence: dbEmail.needsReplyConfidence,
        needsReply: looksReplyNeeded({
          needsReply: dbEmail.needsReply,
          priority: dbEmail.priority,
          category: dbEmail.category,
          actionItems,
          from: dbEmail.from,
        }),
        attachmentCount: attachments.length,
        attachments,
        candidateProfile,
        candidateIntake,
      };
    }

    // Demo fallback
    if (id.startsWith("demo-")) {
      const email = DEMO_EMAILS.find((e) => e.id === id);
      if (email) {
        return {
          ...email,
          body: email.body,
          needsReply: looksReplyNeeded({
            priority: email.priority,
            category: email.category,
            actionItems: email.actionItems,
            from: email.from,
          }),
        };
      }
    }

    return { error: "Email not found" };
  });

  // ─── Force Sync ───────────────────────────────────────────────────────
  // POST /api/email/sync
  app.post("/sync", async (request) => {
    const uid = getUserId(request);
    const { query, maxResults } = (request.body as { query?: string; maxResults?: number }) || {};

    try {
      const result = await syncEmails(uid, maxResults || 30, query);

      // Reconcile (remove archived/deleted, refresh read-status) makes one Gmail
      // call per stored email, which used to block this response by tens of
      // seconds on a large mailbox. New mail is already persisted by syncEmails
      // above, so the user sees it immediately; reconcile converges in the
      // background and on the next scheduler tick. Fire-and-forget, but never
      // swallowed — log a signal so a broken reconcile is visible.
      reconcileEmails(uid).catch((err) => {
        console.error(`[EMAIL-SYNC] Background reconcile failed for user ${uid}:`, err);
        captureError(err, { tags: { scope: "email.sync.reconcile" }, extra: { userId: uid } });
      });

      // Trigger AI summarization (non-blocking, but never silent — the manual
      // /sync path must match the scheduler's console+Sentry discipline).
      summarizeUnsummarizedEmails(uid, result.newCount).catch((err) => {
        console.warn(`[EMAIL-SYNC] background summarize failed for user ${uid}`, err);
        captureError(err, { tags: { scope: "email.sync.summarize" }, extra: { userId: uid } });
      });
      analyzePendingEmailAttachments(uid, Math.max(10, result.newCount * 3))
        .then(() => syncRecentCandidateIntakes(uid, Math.max(10, result.newCount)))
        .catch((err) => {
          console.warn(
            `[EMAIL-SYNC] background attachment/intake analysis failed for user ${uid}`,
            err,
          );
          captureError(err, { tags: { scope: "email.sync.attachments" }, extra: { userId: uid } });
        });

      return result;
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Sync failed" };
    }
  });

  // ─── Reconcile (remove stale emails from DB) ──────────────────────────
  // POST /api/email/reconcile
  app.post("/reconcile", async (request) => {
    const uid = getUserId(request);
    try {
      const result = await reconcileEmails(uid);
      return result;
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Reconcile failed" };
    }
  });

  // ─── AI Summarize ─────────────────────────────────────────────────────
  // POST /api/email/summarize
  app.post("/summarize", async (request) => {
    const uid = getUserId(request);
    const { limit } = (request.body as { limit?: number }) || {};

    const count = await summarizeUnsummarizedEmails(uid, limit || 10);
    return { summarized: count };
  });

  // ─── Email Stats ──────────────────────────────────────────────────────
  app.get("/stats/summary", async (request) => {
    const uid = getUserId(request);

    const token = await prisma.userToken.findFirst({ where: { userId: uid, provider: "google" } });
    if (!token) {
      return {
        total: DEMO_EMAILS.length,
        unread: DEMO_EMAILS.filter((e) => !e.isRead).length,
        urgent: DEMO_EMAILS.filter((e) => e.priority === "URGENT").length,
        today: DEMO_EMAILS.filter(
          (e) => new Date(e.date).toDateString() === new Date().toDateString(),
        ).length,
        categories: { business: 2, automated: 1, engineering: 1, billing: 1 },
        source: "demo",
      };
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [statsRows] = await prisma.$queryRaw<
      [{ total: bigint; unread: bigint; urgent: bigint; today: bigint }]
    >`
      SELECT
        COUNT(*)                                                  AS total,
        COUNT(*) FILTER (WHERE "isRead" = false)                  AS unread,
        COUNT(*) FILTER (WHERE priority = 'URGENT')               AS urgent,
        COUNT(*) FILTER (WHERE "receivedAt" >= ${todayStart})     AS today
      FROM "EmailMessage"
      WHERE "userId" = ${uid}
    `;
    const total = Number(statsRows.total);
    const unread = Number(statsRows.unread);
    const urgent = Number(statsRows.urgent);
    const today = Number(statsRows.today);

    // Category breakdown
    const categories = await prisma.emailMessage.groupBy({
      by: ["category"],
      where: { userId: uid, category: { not: null } },
      _count: true,
    });

    const categoryMap: Record<string, number> = {};
    for (const c of categories) {
      if (c.category) categoryMap[c.category] = c._count;
    }

    return { total, unread, urgent, today, categories: categoryMap, source: "gmail" };
  });

  // ─── Email Action Items → Tasks ───────────────────────────────────────────

  // POST /api/email/:id/create-tasks
  // Convert the AI-extracted actionItems from an email into Task rows.
  // Body: { indices?: number[] } — if omitted, creates tasks for all items.
  app.post("/:id/create-tasks", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = getUserId(request);
    const body = (request.body ?? {}) as { indices?: number[] };

    const email = await prisma.emailMessage.findFirst({
      where: { userId, OR: [{ id }, { gmailId: id }] },
      select: { id: true, subject: true, actionItems: true, receivedAt: true },
    });
    if (!email) return reply.code(404).send({ error: "Email not found" });

    const allItems = parseJsonArray(email.actionItems);
    if (allItems.length === 0)
      return reply.code(400).send({ error: "This email has no extracted action items" });

    const toCreate =
      Array.isArray(body.indices) && body.indices.length > 0
        ? body.indices
            .filter((i) => typeof i === "number" && i >= 0 && i < allItems.length)
            .map((i) => allItems[i])
            .filter(Boolean)
        : allItems;

    if (toCreate.length === 0)
      return reply.code(400).send({ error: "No valid action item indices provided" });

    const created = await Promise.all(
      toCreate.map((item) =>
        prisma.task.create({
          data: {
            userId,
            title: String(item).slice(0, 250),
            status: "TODO",
            priority: "MEDIUM",
          },
          select: { id: true, title: true },
        }),
      ),
    );

    return { success: true, tasks: created, source: { emailId: email.id, subject: email.subject } };
  });
}
