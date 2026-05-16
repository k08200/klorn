/**
 * Commitment ledger API.
 *
 * Lets the user see and triage every commitment Jigeum has detected. Reads come
 * straight from the canonical `Commitment` table — `AttentionItem` is just
 * the projection layer for "what's relevant right now," not the source.
 */
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import {
  buildPath,
  getOrBuildPath,
  materializeAllSteps,
  materializeStepAsTask,
} from "../commitment-path.js";
import {
  deleteCommitment as deleteCommitmentService,
  getCommitment,
  listCommitments,
  updateCommitment,
} from "../commitments.js";
import { prisma } from "../db.js";
import { recordFeedback } from "../feedback.js";
import { getTrustScoresBulk, updateTrustScore } from "../trust-score.js";

const ALLOWED_STATUSES = new Set(["OPEN", "DONE", "DISMISSED", "SNOOZED"]);

export async function commitmentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // GET /api/commitments — list, optionally filtered by status
  app.get("/", async (request) => {
    const userId = getUserId(request);
    const { status, limit } = request.query as { status?: string; limit?: string };
    const filterStatus =
      status && ALLOWED_STATUSES.has(status)
        ? (status as "OPEN" | "DONE" | "DISMISSED" | "SNOOZED")
        : undefined;
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    const commitments = await listCommitments(userId, {
      status: filterStatus,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });

    // Enrich COUNTERPARTY commitments with trust badges
    const counterpartyEmails = [
      ...new Set(
        commitments
          .filter((c) => (c as unknown as Record<string, unknown>).owner === "COUNTERPARTY")
          .map((c) => (c as unknown as Record<string, unknown>).counterpartyEmail)
          .filter((e): e is string => typeof e === "string" && e.length > 0),
      ),
    ];
    const trustMap = new Map<string, string>();
    if (counterpartyEmails.length > 0) {
      const scores = await getTrustScoresBulk(userId, counterpartyEmails);
      for (const [email, result] of scores) {
        trustMap.set(email, result.badge);
      }
    }
    const enriched = commitments.map((c) => {
      const row = c as unknown as Record<string, unknown>;
      const email = typeof row.counterpartyEmail === "string" ? row.counterpartyEmail : null;
      return { ...row, trustBadge: email ? (trustMap.get(email) ?? null) : null };
    });

    return { commitments: enriched };
  });

  // GET /api/commitments/:id
  app.get("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const commitment = await getCommitment(id);
    if (!commitment) return reply.code(404).send({ error: "Commitment not found" });
    if (commitment.userId !== userId) return reply.code(403).send({ error: "Forbidden" });
    return commitment;
  });

  // PATCH /api/commitments/:id — status / title / due updates
  app.patch("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const existing = await getCommitment(id);
    if (!existing) return reply.code(404).send({ error: "Commitment not found" });
    if (existing.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

    const body = request.body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (body.description === null || typeof body.description === "string")
      patch.description = body.description;
    if (typeof body.status === "string" && ALLOWED_STATUSES.has(body.status))
      patch.status = body.status;
    if (body.dueAt === null) patch.dueAt = null;
    else if (typeof body.dueAt === "string") {
      const parsed = new Date(body.dueAt);
      if (Number.isFinite(parsed.getTime())) patch.dueAt = parsed;
    }

    const updated = await updateCommitment(id, patch);

    // When a commitment is dismissed, write a FeedbackEvent so the feedback-adaptor
    // can learn to suppress similar attention items. Fire-and-forget.
    if (patch.status === "DISMISSED" && existing.status !== "DISMISSED") {
      prisma.attentionItem
        .findFirst({
          where: { source: "COMMITMENT", sourceId: id },
          select: { id: true },
        })
        .then((ai) => {
          if (!ai) return;
          return recordFeedback({
            userId,
            source: "ATTENTION_ITEM",
            sourceId: ai.id,
            signal: "DISMISSED",
            evidence: "User dismissed commitment from inbox",
          });
        })
        .catch(() => {});
    }

    // When a COUNTERPARTY commitment is marked DONE, record the outcome for
    // trust scoring. We fire-and-forget so the response is never delayed.
    if (
      patch.status === "DONE" &&
      existing.status !== "DONE" &&
      (existing as unknown as Record<string, unknown>).owner === "COUNTERPARTY"
    ) {
      const row = existing as unknown as {
        counterpartyEmail?: string | null;
        counterpartyName?: string | null;
        dueAt?: Date | null;
      };
      if (row.counterpartyEmail) {
        const wasOnTime = row.dueAt ? new Date() <= row.dueAt : true;
        const daysLate =
          wasOnTime || !row.dueAt
            ? 0
            : Math.ceil((Date.now() - row.dueAt.getTime()) / (24 * 60 * 60 * 1000));
        updateTrustScore(
          userId,
          row.counterpartyEmail,
          row.counterpartyName ?? null,
          wasOnTime,
          daysLate,
        ).catch(() => {});
      }
    }

    return updated;
  });

  // DELETE /api/commitments/:id — drop both the ledger row and its queue mirror
  app.delete("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const existing = await getCommitment(id);
    if (!existing) return reply.code(404).send({ error: "Commitment not found" });
    if (existing.userId !== userId) return reply.code(403).send({ error: "Forbidden" });
    await deleteCommitmentService(id);
    return reply.code(204).send();
  });

  // ─── Commitment Fulfillment Paths ─────────────────────────────────────────

  // GET /api/commitments/:id/path — get or build the fulfillment plan
  app.get("/:id/path", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const existing = await getCommitment(id);
    if (!existing) return reply.code(404).send({ error: "Commitment not found" });
    if (existing.userId !== userId) return reply.code(403).send({ error: "Forbidden" });
    const path = await getOrBuildPath(userId, id);
    return { success: true, path };
  });

  // POST /api/commitments/:id/path/rebuild — force a fresh plan from LLM
  app.post("/:id/path/rebuild", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const existing = await getCommitment(id);
    if (!existing) return reply.code(404).send({ error: "Commitment not found" });
    if (existing.userId !== userId) return reply.code(403).send({ error: "Forbidden" });
    const path = await buildPath(userId, id);
    return { success: true, path };
  });

  // POST /api/commitments/:id/path/steps/:index/materialize — create task for one step
  app.post("/:id/path/steps/:index/materialize", async (request, reply) => {
    const userId = getUserId(request);
    const { id, index } = request.params as { id: string; index: string };
    const existing = await getCommitment(id);
    if (!existing) return reply.code(404).send({ error: "Commitment not found" });
    if (existing.userId !== userId) return reply.code(403).send({ error: "Forbidden" });
    const stepIndex = Number.parseInt(index, 10);
    if (!Number.isFinite(stepIndex) || stepIndex < 0)
      return reply.code(400).send({ error: "Invalid step index" });
    const result = await materializeStepAsTask(userId, id, stepIndex);
    return { success: true, ...result };
  });

  // POST /api/commitments/:id/path/materialize-all — create tasks for all steps
  app.post("/:id/path/materialize-all", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const existing = await getCommitment(id);
    if (!existing) return reply.code(404).send({ error: "Commitment not found" });
    if (existing.userId !== userId) return reply.code(403).send({ error: "Forbidden" });
    const result = await materializeAllSteps(userId, id);
    return { success: true, ...result };
  });
}
