/**
 * Feedback ledger inspection API.
 *
 * Exposes raw feedback inspection, derived policy candidates, and user
 * preferences that decide which learned candidates become prompt guidance.
 */
import type { FeedbackSignal, FeedbackSource } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import { getFeedbackPolicyCandidates } from "../policy-extraction.js";

const ALLOWED_SOURCES = new Set<FeedbackSource>([
  "PENDING_ACTION",
  "ATTENTION_ITEM",
  "NOTIFICATION",
  "DRAFT",
]);
const ALLOWED_SIGNALS = new Set<FeedbackSignal>([
  "APPROVED",
  "REJECTED",
  "EDITED",
  "IGNORED",
  "SNOOZED",
  "DISMISSED",
  "FAILED",
]);

const preferenceBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidateId", "kind", "toolName", "action"],
  properties: {
    candidateId: { type: "string", minLength: 1, maxLength: 240 },
    kind: { type: "string", minLength: 1, maxLength: 80 },
    toolName: { type: "string", minLength: 1, maxLength: 120 },
    recipient: { anyOf: [{ type: "string", maxLength: 240 }, { type: "null" }] },
    action: { type: "string", enum: ["ACTIVE", "IGNORED"] },
    note: { anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }] },
  },
} as const;

export function feedbackRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // GET /api/feedback — recent events for inspection
  app.get("/", async (request) => {
    const userId = getUserId(request);
    const { source, signal, recipient, toolName, limit } = request.query as {
      source?: string;
      signal?: string;
      recipient?: string;
      toolName?: string;
      limit?: string;
    };

    const where: {
      userId: string;
      source?: FeedbackSource;
      signal?: FeedbackSignal;
      recipient?: string;
      toolName?: string;
    } = { userId };

    if (source && ALLOWED_SOURCES.has(source as FeedbackSource))
      where.source = source as FeedbackSource;
    if (signal && ALLOWED_SIGNALS.has(signal as FeedbackSignal))
      where.signal = signal as FeedbackSignal;
    if (recipient) where.recipient = recipient;
    if (toolName) where.toolName = toolName;

    const parsed = limit ? Number.parseInt(limit, 10) : 100;
    const take = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 100;

    const events = await prisma.feedbackEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
    });
    return { events };
  });

  // GET /api/feedback/summary — quick rollups so the UI doesn't have to
  // re-derive them client-side every render
  app.get("/summary", async (request) => {
    const userId = getUserId(request);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const grouped = await prisma.feedbackEvent.groupBy({
      by: ["signal"],
      where: { userId, createdAt: { gte: since } },
      _count: { signal: true },
    });

    const counts: Record<string, number> = {};
    for (const row of grouped) counts[row.signal] = row._count.signal;
    return { since: since.toISOString(), counts };
  });

  // GET /api/feedback/policy-candidates — conservative read-only patterns
  // extracted from recent feedback. These are not active policies yet.
  app.get("/policy-candidates", async (request) => {
    const userId = getUserId(request);
    const { days, limit, minEvents } = request.query as {
      days?: string;
      limit?: string;
      minEvents?: string;
    };

    const result = await getFeedbackPolicyCandidates(userId, {
      days: parseOptionalInteger(days),
      limit: parseOptionalInteger(limit),
      minEvents: parseOptionalInteger(minEvents),
    });
    const prefs = await getPolicyPreferences(userId);
    return {
      ...result,
      candidates: result.candidates.map((candidate) => {
        const pref = prefs.get(candidate.id);
        return {
          ...candidate,
          active: pref?.action === "ACTIVE",
          ignored: pref?.action === "IGNORED",
        };
      }),
    };
  });

  app.post("/policy-preferences", { schema: { body: preferenceBodySchema } }, async (request) => {
    const userId = getUserId(request);
    const body = request.body as {
      candidateId: string;
      kind: string;
      toolName: string;
      recipient?: string | null;
      action: "ACTIVE" | "IGNORED";
      note?: string | null;
    };

    const model = (
      prisma as unknown as {
        feedbackPolicyPreference?: { upsert: (args: unknown) => Promise<unknown> };
      }
    ).feedbackPolicyPreference;
    if (!model) throw new Error("FeedbackPolicyPreference model is not available");

    const preference = await model.upsert({
      where: { userId_candidateId: { userId, candidateId: body.candidateId } },
      create: {
        userId,
        candidateId: body.candidateId,
        kind: body.kind,
        toolName: body.toolName,
        recipient: body.recipient ?? null,
        action: body.action,
        note: body.note ?? null,
      },
      update: {
        kind: body.kind,
        toolName: body.toolName,
        recipient: body.recipient ?? null,
        action: body.action,
        note: body.note ?? null,
      },
    });

    return { preference };
  });
}

async function getPolicyPreferences(userId: string): Promise<Map<string, { action: string }>> {
  const model = (
    prisma as unknown as {
      feedbackPolicyPreference?: { findMany: (args: unknown) => Promise<unknown> };
    }
  ).feedbackPolicyPreference;
  if (!model) return new Map();
  const rows = (await model.findMany({
    where: { userId },
    select: { candidateId: true, action: true },
  })) as Array<{ candidateId: string; action: string }>;
  return new Map(rows.map((row) => [row.candidateId, { action: row.action }]));
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
