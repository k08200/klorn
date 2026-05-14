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
  deleteCommitment as deleteCommitmentService,
  getCommitment,
  listCommitments,
  updateCommitment,
} from "../commitments.js";

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
    return { commitments };
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
}
