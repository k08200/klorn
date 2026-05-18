import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { encryptOptional } from "../crypto-tokens.js";
import { prisma } from "../db.js";

export async function agentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // POST /api/agents — Register an agent
  app.post("/", async (request, reply) => {
    const userId = getUserId(request);
    const { name, endpoint, apiKey } = request.body as {
      name: string;
      endpoint: string;
      apiKey?: string;
    };

    // Validate endpoint URL to prevent stored SSRF
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(endpoint);
    } catch {
      return reply.code(400).send({ error: "Invalid endpoint URL" });
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return reply.code(400).send({ error: "Only HTTP(S) endpoints are allowed" });
    }
    const host = parsedUrl.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".internal") ||
      host.endsWith(".local")
    ) {
      return reply.code(400).send({ error: "Private/internal endpoints are not allowed" });
    }
    const ipMatch = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254) ||
        a === 0
      ) {
        return reply.code(400).send({ error: "Private/internal endpoints are not allowed" });
      }
    }

    const agent = await prisma.agent.create({
      data: {
        name,
        endpoint: parsedUrl.href,
        // Encrypt at-rest. Callers that actually invoke the agent must
        // decrypt with decryptOptional from crypto-tokens.
        apiKey: encryptOptional(apiKey ?? null),
        userId,
      },
    });

    return reply.code(201).send({ id: agent.id, name: agent.name, endpoint: agent.endpoint });
  });

  // GET /api/agents — List agents for authenticated user
  app.get("/", async (request) => {
    const userId = getUserId(request);

    const [agents, total] = await Promise.all([
      prisma.agent.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, endpoint: true, createdAt: true },
      }),
      prisma.agent.count({ where: { userId } }),
    ]);

    return { agents, total };
  });

  // GET /api/agents/:id — Get agent details
  app.get("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const agent = await prisma.agent.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        endpoint: true,
        createdAt: true,
        userId: true,
        _count: { select: { testRuns: true } },
      },
    });

    if (!agent || agent.userId !== userId) {
      return reply.code(404).send({ error: "Agent not found" });
    }
    // Strip userId from response
    const { userId: _uid, ...safeAgent } = agent;
    return safeAgent;
  });

  // DELETE /api/agents/:id
  app.delete("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent || agent.userId !== userId) {
      return reply.code(404).send({ error: "Agent not found" });
    }

    await prisma.agent.delete({ where: { id } });
    return reply.code(204).send();
  });
}
