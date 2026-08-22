/**
 * Email reply routes — AI-generated reply drafts and Gmail draft creation
 * (with optional original attachment + brief packaging).
 *
 * Split out of routes/email.ts so the reply-draft domain lives in one place.
 * Registered by emailRoutes() against the same `/api/email` prefix so client
 * paths stay byte-identical.
 */

import type { ReplyOptionsResponseWire, ReplyOptionTone } from "@klorn/contract";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { requireEntitled } from "../billing/entitlement-guard.js";
import { prisma } from "../db.js";
import { recordContactEngagement } from "../learning/contact-engagement.js";
import { buildReplyToneHint } from "../learning/reply-tone.js";
import { buildVoicePromptHint } from "../learning/voice-profile-extractor.js";
import { describeLlmFailure } from "../llm/describe-failure.js";
import { getUserLlmCredentials } from "../llm/llm-credentials.js";
import { createCompletion, DRAFT_MODEL } from "../llm/openai.js";
import { extractEmailAddress } from "../mail/email-address.js";
import {
  buildAttachmentCandidateProfile,
  listEmailAttachments,
} from "../mail/email-attachments.js";
import { updateCandidateIntake } from "../mail/email-candidate-intake.js";
import { type GmailDraftAttachment, resolveMailClient } from "../mail/gmail.js";
import { formatCalendarFacts, getMeetingContext } from "../mail/meeting-context.js";
import { mailActionsFor } from "../mail/providers/dispatch.js";
import { buildReplySystemPrompt } from "../mail/reply-prompt.js";
import { senderDossierFacts } from "../mail/sender-dossier.js";
import { cachedThreadBrief, threadBriefFacts } from "../mail/thread-brief.js";
import { captureError } from "../sentry.js";
import { wrapUntrusted } from "../untrusted.js";
import { parseJsonArray, safeAttachmentFilename } from "./email.js";
import { buildEmailAttachmentBrief } from "./email-attachments.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

async function fetchOriginalAttachmentsForDraft(input: {
  userId: string;
  emailId: string;
  gmailMessageId: string;
  attachmentIds: string[];
  linkedInboxAccountId?: string | null;
}): Promise<GmailDraftAttachment[]> {
  const uniqueIds = Array.from(new Set(input.attachmentIds)).slice(0, 10);
  if (uniqueIds.length === 0) return [];

  const rows = await prisma.emailAttachment.findMany({
    where: {
      userId: input.userId,
      emailId: input.emailId,
      id: { in: uniqueIds },
    },
    select: {
      gmailAttachmentId: true,
      filename: true,
      mimeType: true,
      size: true,
    },
  });
  if (rows.length === 0) return [];

  const totalSize = rows.reduce((sum, row) => sum + (row.size ?? 0), 0);
  if (totalSize > 18_000_000) {
    throw new Error("The attachments are too large to include in a Gmail draft.");
  }

  // The source message may live on a linked secondary inbox (#757) — fetch
  // its attachments from THAT account, not always the primary.
  const auth = await resolveMailClient(input.userId, input.linkedInboxAccountId);
  if (!auth) throw new Error("Gmail not connected.");

  const { google } = await import("googleapis");
  const gmail = google.gmail({ version: "v1", auth });
  const attachments: GmailDraftAttachment[] = [];

  for (const row of rows) {
    const res = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId: input.gmailMessageId,
      id: row.gmailAttachmentId,
    });
    const data = res.data.data;
    if (!data) continue;
    attachments.push({
      filename: safeAttachmentFilename(row.filename),
      mimeType: row.mimeType || "application/octet-stream",
      content: Buffer.from(data, "base64url"),
    });
  }

  return attachments;
}

function extractReplyAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] || raw).replace(/^["']|["']$/g, "").trim();
}

/**
 * Calendar grounding for meeting emails: parse the proposed slot, verify it
 * against the user's calendars, and hand the drafts the verified facts so
 * "yes, 4 PM works" is a checked claim, not a guess. Fails open — drafting
 * must never break because the calendar is unreachable.
 */
/** Cached-only relationship context for the draft prompt — never an LLM call. */
async function senderContextFor(
  uid: string,
  from: string | null | undefined,
): Promise<string | null> {
  const sender = extractEmailAddress(from ?? "");
  if (!sender) return null;
  try {
    return await senderDossierFacts(uid, sender);
  } catch (err) {
    console.warn("[EMAIL] sender dossier unavailable:", err);
    return null;
  }
}

/**
 * Thread reasoning for the draft prompt. Cached-only by default: drafting is
 * already one LLM call on a 10/min route, and a thread read on top would
 * double it. The reading pane's brief fetch is what warms this cache, so by
 * the time the user clicks "AI 답장" on a mail they opened, it is hot.
 */
async function threadBriefFor(uid: string, threadId: string | null): Promise<string | null> {
  try {
    const brief = await cachedThreadBrief(uid, threadId);
    return threadBriefFacts(brief) || null;
  } catch (err) {
    console.warn("[EMAIL] thread brief unavailable:", err);
    return null;
  }
}

async function calendarFactsFor(
  uid: string,
  dbEmail: {
    id: string;
    category: string | null;
    summary: string | null;
    keyPoints: unknown;
    body: string | null;
    receivedAt: Date;
    from?: string | null;
  },
): Promise<string | null> {
  try {
    const context = await getMeetingContext(uid, {
      id: dbEmail.id,
      category: dbEmail.category,
      summary: dbEmail.summary,
      keyPoints: parseJsonArray(dbEmail.keyPoints),
      body: dbEmail.body,
      receivedAt: dbEmail.receivedAt,
      from: dbEmail.from,
    });
    return context ? formatCalendarFacts(context) : null;
  } catch (err) {
    console.warn(`[EMAIL] calendar facts unavailable for ${dbEmail.id}:`, err);
    return null;
  }
}

async function generateReplyDraft(input: {
  userId: string;
  from: string;
  subject: string;
  body: string | null;
  summary: string | null;
  actionItems: string[];
  candidateProfile: ReturnType<typeof buildAttachmentCandidateProfile>;
  intent?: string;
  calendarFacts?: string | null;
  senderContext?: string | null;
  /** Thread reasoning: why they wrote NOW, what is owed either way. */
  threadBrief?: string | null;
}): Promise<string> {
  const [credentials, voiceHint, toneHint] = await Promise.all([
    getUserLlmCredentials(input.userId),
    buildVoicePromptHint(input.userId),
    buildReplyToneHint(input.userId),
  ]);
  const candidateContext = input.candidateProfile
    ? `Candidate profile:
Summary: ${input.candidateProfile.summary}
Next action: ${input.candidateProfile.nextAction}
Missing fields: ${input.candidateProfile.missingFields.join(", ") || "none"}
Manual review files: ${
        input.candidateProfile.manualReviewFiles
          .map((file) => `${file.filename} (${file.reason})`)
          .join(", ") || "none"
      }
Evidence files: ${
        input.candidateProfile.evidenceFiles
          .map((file) =>
            [file.filename, file.category, file.analysisStatus, file.reviewReason]
              .filter(Boolean)
              .join(" / "),
          )
          .join(", ") || "none"
      }`
    : "Candidate profile: none";

  const response = await createCompletion(
    {
      model: DRAFT_MODEL,
      temperature: 0.25,
      messages: [
        {
          role: "system",
          content: buildReplySystemPrompt({ voiceHint, toneHint }),
        },
        {
          role: "user",
          content: `User intent: ${wrapUntrusted(input.intent || "Draft a helpful reply.", "reply:intent")}
From: ${wrapUntrusted(input.from, "email:from")}
Subject: ${wrapUntrusted(input.subject, "email:subject")}
Klorn summary: ${wrapUntrusted(input.summary || "", "email:summary")}
Action items: ${wrapUntrusted(input.actionItems.join("; "), "email:actions")}
${wrapUntrusted(candidateContext, "email:candidate")}
${input.calendarFacts ? `\n${input.calendarFacts}\n` : ""}${input.senderContext ? `\n${input.senderContext}\n` : ""}${input.threadBrief ? `\nThread context (why this arrived now — answer THIS, not just the last message):\n${input.threadBrief}\n` : ""}
Email body:
${wrapUntrusted((input.body || "").slice(0, 3000), "email:body")}`,
        },
      ],
    },
    { credentials, userId: input.userId },
  );
  return response.choices[0]?.message?.content?.trim() || "";
}

// Fixed tone presets for /reply-options. The order is wire contract: clients
// (desktop PushCard) bind keys 1/2/3 positionally, so accept/decline/info must
// never be reordered. The "Accept"/"decline" wording also steers the draft LLM
// via the existing intent channel — no new prompt surface.
const REPLY_OPTION_PRESETS: ReadonlyArray<{ tone: ReplyOptionTone; intent: string }> = [
  {
    tone: "accept",
    intent: "Accept or agree to the sender's request. Keep it short and positive.",
  },
  {
    tone: "decline",
    intent: "Politely decline or defer the sender's request without over-apologizing.",
  },
  {
    tone: "info",
    intent:
      "Ask one concise clarifying question or request the missing information needed to proceed.",
  },
];

// ─── Routes ──────────────────────────────────────────────────────────────

export async function registerEmailRepliesRoutes(app: FastifyInstance) {
  // POST /api/email/:id/reply-draft
  // Tighter than the global 100/min limit: every call here is an LLM
  // completion, so the global limit alone allows ~$1/min of forced spend.
  app.post(
    "/:id/reply-draft",
    {
      // Pro-only compose: generating a reply draft is the paid "writes your
      // replies" value, so gate it even though the parent email routes are now
      // open to the free tier. requireAuth first sets userId for requireEntitled.
      preHandler: [requireAuth, requireEntitled],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const uid = getUserId(request);
      const { intent } = (request.body as { intent?: string }) || {};

      const dbEmail = await prisma.emailMessage.findFirst({
        where: { userId: uid, OR: [{ id }, { gmailId: id }] },
      });
      if (!dbEmail) return reply.code(404).send({ error: "Email not found" });

      const actionItems = parseJsonArray(dbEmail.actionItems);
      const attachments = await listEmailAttachments([dbEmail.id], uid);
      const candidateProfile = buildAttachmentCandidateProfile(attachments);
      const calendarFacts = await calendarFactsFor(uid, dbEmail);
      const senderContext = await senderContextFor(uid, dbEmail.from);
      const threadBrief = await threadBriefFor(uid, dbEmail.threadId);

      // The draft is one LLM call. Without this catch a provider outage / quota
      // lockout surfaced as a bare 500 and a generic "Could not draft a reply"
      // with nothing in the logs — the failure was invisible. Capture the real
      // cause and return a 503 the client can show as "temporarily unavailable".
      let body: string;
      try {
        body = await generateReplyDraft({
          userId: uid,
          from: dbEmail.from,
          subject: dbEmail.subject,
          body: dbEmail.body,
          summary: dbEmail.summary,
          actionItems,
          candidateProfile,
          intent,
          calendarFacts,
          senderContext,
          threadBrief,
        });
      } catch (err) {
        // A per-user quota trip (quota-limiter self-throttling) is the user
        // going fast, not a provider outage: return the standard 429 +
        // Retry-After back-off signal and keep Sentry quiet — an alert here
        // is pure noise. Name check (not instanceof) matches the
        // autonomous-agent precedent and survives the LLM layer being mocked
        // in tests.
        // A daily-budget trip is a different fact from an outage, and the
        // generic "temporarily unavailable" sent the user in circles retrying
        // something that cannot succeed until tomorrow (founder, 2026-08-10).
        if (err instanceof Error && err.name === "DailyCostCapExceededError") {
          return reply.code(429).send({ error: err.message });
        }
        if (err instanceof Error && err.name === "AllProvidersExhaustedError") {
          // Every model in the fallback chain refused. Still 503 (it is
          // transient), but say which layer failed so a key/quota problem is
          // not mistaken for a Klorn bug.
          captureError(err, {
            tags: { scope: "reply-draft.providers-exhausted" },
            extra: { userId: uid, emailId: dbEmail.id },
          });
          return reply.code(503).send({
            error: "The AI model provider is unavailable right now. Please try again shortly.",
          });
        }
        if (err instanceof Error && err.name === "UserRateLimitedError") {
          const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs ?? 1_000;
          reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
          return reply.code(429).send({ error: err.message });
        }
        captureError(err, {
          tags: { scope: "reply-draft" },
          extra: { userId: uid, emailId: dbEmail.id, model: DRAFT_MODEL },
        });
        // Name the failure class AND its HTTP status. `err.name` alone read
        // "Error" for every provider fault — the OpenAI SDK never assigns one —
        // so naming the class bought nothing: a dead key and a code fault
        // printed the same word for a day (2026-08-10). Class + status is safe
        // to surface: no bodies, no keys, no prompts.
        const reason = describeLlmFailure(err);
        return reply.code(503).send({
          error: `Reply drafting is temporarily unavailable (${reason}). Please try again shortly.`,
        });
      }

      return {
        to: extractReplyAddress(dbEmail.from),
        subject: dbEmail.subject.startsWith("Re:") ? dbEmail.subject : `Re: ${dbEmail.subject}`,
        body,
        candidateProfile,
      };
    },
  );

  // POST /api/email/:id/reply-options
  // Three tone-differentiated drafts (accept / decline / info) for
  // one-keystroke reply surfaces. Every call is 3 concurrent LLM completions,
  // so 3/min keeps the worst-case spend (9 LLM calls/min) inside /reply-draft's
  // 10/min budget — a higher route limit would quietly raise the per-user LLM
  // ceiling. All-or-nothing: a partial set would silently remap the client's
  // fixed 1/2/3 key bindings.
  app.post(
    "/:id/reply-options",
    {
      preHandler: [requireAuth, requireEntitled],
      config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const uid = getUserId(request);

      const dbEmail = await prisma.emailMessage.findFirst({
        where: { userId: uid, OR: [{ id }, { gmailId: id }] },
      });
      if (!dbEmail) return reply.code(404).send({ error: "Email not found" });

      const actionItems = parseJsonArray(dbEmail.actionItems);
      const attachments = await listEmailAttachments([dbEmail.id], uid);
      const candidateProfile = buildAttachmentCandidateProfile(attachments);
      // Computed once, shared by all three presets (the meeting-context cache
      // makes this a single parse per email regardless).
      const calendarFacts = await calendarFactsFor(uid, dbEmail);
      const senderContext = await senderContextFor(uid, dbEmail.from);
      const threadBrief = await threadBriefFor(uid, dbEmail.threadId);

      let bodies: string[];
      try {
        bodies = await Promise.all(
          REPLY_OPTION_PRESETS.map((preset) =>
            generateReplyDraft({
              userId: uid,
              from: dbEmail.from,
              subject: dbEmail.subject,
              body: dbEmail.body,
              summary: dbEmail.summary,
              actionItems,
              candidateProfile,
              intent: preset.intent,
              calendarFacts,
              senderContext,
              threadBrief,
            }),
          ),
        );
      } catch (err) {
        // A per-user quota trip (quota-limiter, thrown inside createCompletion)
        // is self-throttling, not a provider outage: give the client a real
        // back-off signal and keep Sentry quiet — an alert here is pure noise.
        // Name check (not instanceof) matches the autonomous-agent precedent
        // and survives the LLM layer being mocked in tests.
        // A daily-budget trip is a different fact from an outage, and the
        // generic "temporarily unavailable" sent the user in circles retrying
        // something that cannot succeed until tomorrow (founder, 2026-08-10).
        if (err instanceof Error && err.name === "DailyCostCapExceededError") {
          return reply.code(429).send({ error: err.message });
        }
        if (err instanceof Error && err.name === "AllProvidersExhaustedError") {
          // Every model in the fallback chain refused. Still 503 (it is
          // transient), but say which layer failed so a key/quota problem is
          // not mistaken for a Klorn bug.
          captureError(err, {
            tags: { scope: "reply-draft.providers-exhausted" },
            extra: { userId: uid, emailId: dbEmail.id },
          });
          return reply.code(503).send({
            error: "The AI model provider is unavailable right now. Please try again shortly.",
          });
        }
        if (err instanceof Error && err.name === "UserRateLimitedError") {
          const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs ?? 1_000;
          reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
          return reply.code(429).send({ error: err.message });
        }
        captureError(err, {
          tags: { scope: "reply-options" },
          extra: { userId: uid, emailId: dbEmail.id, model: DRAFT_MODEL },
        });
        // Name the failure class AND its HTTP status. `err.name` alone read
        // "Error" for every provider fault — the OpenAI SDK never assigns one —
        // so naming the class bought nothing: a dead key and a code fault
        // printed the same word for a day (2026-08-10). Class + status is safe
        // to surface: no bodies, no keys, no prompts.
        const reason = describeLlmFailure(err);
        return reply.code(503).send({
          error: `Reply drafting is temporarily unavailable (${reason}). Please try again shortly.`,
        });
      }

      const response: ReplyOptionsResponseWire = {
        to: extractReplyAddress(dbEmail.from),
        subject: dbEmail.subject.startsWith("Re:") ? dbEmail.subject : `Re: ${dbEmail.subject}`,
        options: REPLY_OPTION_PRESETS.map((preset, i) => ({
          tone: preset.tone,
          body: bodies[i],
        })),
      };
      return response;
    },
  );

  // POST /api/email/:id/gmail-draft
  // Pro-only: writing a draft into Gmail is a compose (email_write) action.
  app.post(
    "/:id/gmail-draft",
    { preHandler: [requireAuth, requireEntitled] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const uid = getUserId(request);
      const { to, subject, body, attachmentIds, includeBriefAttachment } = request.body as {
        to?: string;
        subject?: string;
        body?: string;
        attachmentIds?: string[];
        includeBriefAttachment?: boolean;
      };
      if (!to || !subject || !body) {
        return reply.code(400).send({ error: "Missing required fields: to, subject, body" });
      }

      const dbEmail = await prisma.emailMessage.findFirst({
        where: { userId: uid, OR: [{ id }, { gmailId: id }] },
        select: {
          id: true,
          gmailId: true,
          threadId: true,
          from: true,
          subject: true,
          summary: true,
          receivedAt: true,
          linkedInboxAccountId: true,
        },
      });
      if (!dbEmail) return reply.code(404).send({ error: "Email not found" });

      let attachments: GmailDraftAttachment[] = [];
      try {
        attachments = await fetchOriginalAttachmentsForDraft({
          userId: uid,
          emailId: dbEmail.id,
          gmailMessageId: dbEmail.gmailId,
          attachmentIds: Array.isArray(attachmentIds) ? attachmentIds : [],
          linkedInboxAccountId: dbEmail.linkedInboxAccountId,
        });
        if (includeBriefAttachment) {
          const analyzedAttachments = await listEmailAttachments([dbEmail.id], uid);
          const candidateProfile = buildAttachmentCandidateProfile(analyzedAttachments);
          const brief = buildEmailAttachmentBrief({
            subject: dbEmail.subject,
            from: dbEmail.from,
            receivedAt: dbEmail.receivedAt,
            summary: dbEmail.summary,
            attachments: analyzedAttachments,
            candidateProfile,
          });
          attachments.unshift({
            filename: "klorn-attachment-brief.txt",
            mimeType: "text/plain; charset=utf-8",
            content: Buffer.from(brief, "utf-8"),
          });
        }
      } catch (err) {
        return reply
          .code(409)
          .send({ error: err instanceof Error ? err.message : "Attachment fetch failed" });
      }

      const actions = await mailActionsFor(uid, dbEmail.linkedInboxAccountId);
      const result = await actions.createDraft(
        uid,
        to,
        subject,
        body,
        dbEmail.threadId,
        attachments,
        dbEmail.linkedInboxAccountId,
      );
      if ("unsupported" in result) return reply.code(501).send({ error: result.error });
      if ("error" in result) return reply.code(409).send(result);
      await updateCandidateIntake({
        userId: uid,
        emailId: dbEmail.id,
        status: "CONTACTED",
      }).catch((err) => {
        // Best-effort status write — the draft already succeeded, so don't fail
        // the request. But log a signal instead of swallowing: a systemic
        // failure here silently stops candidate intake tracking.
        console.warn("[email-replies] failed to update candidate intake status:", err);
        captureError(err, {
          tags: { scope: "email-replies.intake-status" },
          extra: { userId: uid, emailId: dbEmail.id },
        });
      });
      return { ...result, attachedCount: attachments.length };
    },
  );

  // POST /api/email/:id/reply
  // One-call threaded reply: send `body` to the original sender in the same Gmail
  // thread (threadId + In-Reply-To/References), no draft step. Pro-only compose;
  // rate-limited like /send since each call is a real Gmail send.
  app.post(
    "/:id/reply",
    {
      preHandler: [requireAuth, requireEntitled],
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const uid = getUserId(request);
      const { body } = (request.body as { body?: string }) || {};
      if (!body || !body.trim()) {
        return reply.code(400).send({ error: "Missing required field: body" });
      }

      const dbEmail = await prisma.emailMessage.findFirst({
        where: { userId: uid, OR: [{ id }, { gmailId: id }] },
        select: {
          id: true,
          gmailId: true,
          threadId: true,
          from: true,
          subject: true,
          linkedInboxAccountId: true,
        },
      });
      if (!dbEmail) return reply.code(404).send({ error: "Email not found" });

      const to = extractReplyAddress(dbEmail.from);
      const subject = dbEmail.subject.startsWith("Re:")
        ? dbEmail.subject
        : `Re: ${dbEmail.subject}`;

      // RFC822 Message-ID isn't stored — fetch it live so In-Reply-To/References
      // are correct. References = original chain + original Message-ID (RFC 5322).
      // A message from a linked secondary inbox lives on THAT account (#757).
      const actions = await mailActionsFor(uid, dbEmail.linkedInboxAccountId);
      const { messageId, references } = await actions.getReplyHeaders(
        uid,
        dbEmail.gmailId,
        dbEmail.linkedInboxAccountId,
      );
      const referencesChain = [references, messageId].filter(Boolean).join(" ") || undefined;

      const result = await actions.sendEmail(uid, to, subject, body, [], {
        threadId: dbEmail.threadId,
        linkedInboxAccountId: dbEmail.linkedInboxAccountId,
        inReplyTo: messageId,
        references: referencesChain,
      });
      if ("unsupported" in result) return reply.code(501).send({ error: result.error });
      if ("error" in result) return reply.code(409).send(result);

      // Manual reply = genuine engagement with this sender (an importance-graph
      // edge). Only user-initiated routes record this — never the auto-reply path.
      await recordContactEngagement(uid, to, "outbound");

      // threaded=false means we sent by threadId only (no RFC Message-ID found);
      // surfaced so a client can tell strict-threaded from best-effort.
      return { ...result, to, threaded: Boolean(messageId) };
    },
  );
}
