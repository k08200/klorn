/**
 * Built-in Klorn Playbooks API.
 *
 * These routes are read-only in v0. They expose the canonical playbook
 * registry and context-aware recommendations inferred from the Work Graph.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import {
  activatePlaybook,
  buildPlaybookRecommendations,
  deactivatePlaybook,
  listActivePlaybookIds,
  listKlornPlaybooks,
} from "../playbooks.js";

const playbookIdParamSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1 },
  },
} as const;

export function playbookRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/", async (request) => {
    const userId = getUserId(request);
    const activeIds = await listActivePlaybookIds(userId);
    return { playbooks: listKlornPlaybooks(activeIds) };
  });

  app.get("/activations", async (request) => {
    const userId = getUserId(request);
    return { activePlaybookIds: [...(await listActivePlaybookIds(userId))] };
  });

  app.get("/recommendations", async (request) => {
    const userId = getUserId(request);
    const { limit, contextLimit } = request.query as { limit?: string; contextLimit?: string };
    return await buildPlaybookRecommendations(userId, {
      limit: parseOptionalInteger(limit),
      contextLimit: parseOptionalInteger(contextLimit),
    });
  });

  app.post("/:id/activate", { schema: { params: playbookIdParamSchema } }, async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    return { playbook: await activatePlaybook(userId, id) };
  });

  app.delete("/:id/activate", { schema: { params: playbookIdParamSchema } }, async (request) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    await deactivatePlaybook(userId, id);
    return { success: true };
  });
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
