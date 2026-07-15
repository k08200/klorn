import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { db } from "../db.js";
import { getLearnedPatterns } from "../learning/pattern-learner.js";

export async function patternRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // GET /api/patterns — Live behavioral pattern analysis
  app.get("/", async (request) => {
    const userId = getUserId(request);
    const patterns = await getLearnedPatterns(userId);
    return { patterns };
  });

  // GET /api/patterns/memories — Persisted high-confidence patterns from memory
  app.get("/memories", async (request) => {
    const userId = getUserId(request);
    const memories = await db.memory.findMany({
      where: {
        userId,
        type: { in: ["FEEDBACK", "DECISION", "CONTEXT"] },
        source: "pattern-learner",
      },
      orderBy: { confidence: "desc" },
      take: 30,
    });
    return { memories };
  });
}
