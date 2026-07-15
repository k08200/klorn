/**
 * Skills API — Reusable workflows defined by the user.
 *
 * Each skill is a named prompt template (with optional {{variable}} slots)
 * that Eve can run on demand or via the execute_skill tool.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import { requireEntitled } from "../entitlement-guard.js";
import { MAX_SKILL_PROMPT_LENGTH, renderSkillTemplate } from "../skill-render.js";

interface SkillPayload {
  name: string;
  description?: string;
  prompt: string;
}

function slugify(name: string): string {
  // Bound input first so the regex pass is linear regardless of caller input.
  // Then split the leading/trailing underscore trim into two anchored regexes
  // — alternation with `+` on the same regex can backtrack polynomially.
  return `skill_${name
    .slice(0, 100)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "")
    .slice(0, 40)}`;
}

export async function skillRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  // Paywall: refuse non-entitled users at the paid surface (no-op pre-launch).
  app.addHook("preHandler", requireEntitled);

  // GET /api/skills — List user's skills
  app.get("/", async (request) => {
    const userId = getUserId(request);
    const rows = await prisma.skill.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });
    return {
      skills: rows.map((s) => ({
        id: s.key,
        name: s.name,
        description: s.description,
        prompt: s.prompt,
        updatedAt: s.updatedAt.toISOString(),
      })),
    };
  });

  // POST /api/skills — Create or update a skill
  app.post("/", async (request, reply) => {
    const userId = getUserId(request);
    const { name, description, prompt } = request.body as SkillPayload;

    if (!name?.trim() || !prompt?.trim()) {
      return reply.code(400).send({ error: "Name and prompt are required" });
    }
    if (prompt.length > MAX_SKILL_PROMPT_LENGTH) {
      return reply
        .code(400)
        .send({ error: `Prompt must be at most ${MAX_SKILL_PROMPT_LENGTH} characters` });
    }

    const key = slugify(name);
    const skill = await prisma.skill.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, name, description: description ?? "", prompt },
      update: { name, description: description ?? "", prompt },
    });

    return reply.code(201).send({
      id: skill.key,
      name: skill.name,
      description: skill.description,
      prompt: skill.prompt,
    });
  });

  // DELETE /api/skills/:key — Delete a skill
  app.delete("/:key", async (request, reply) => {
    const userId = getUserId(request);
    const { key } = request.params as { key: string };

    const result = await prisma.skill.deleteMany({ where: { userId, key } });
    if (result.count === 0) {
      return reply.code(404).send({ error: "Skill not found" });
    }
    return reply.code(204).send();
  });

  // POST /api/skills/:key/execute — Run a skill (returns rendered prompt)
  app.post("/:key/execute", async (request, reply) => {
    const userId = getUserId(request);
    const { key } = request.params as { key: string };
    const { variables } = (request.body || {}) as { variables?: Record<string, string> };

    const skill = await prisma.skill.findUnique({
      where: { userId_key: { userId, key } },
    });
    if (!skill) {
      return reply.code(404).send({ error: "Skill not found" });
    }

    const prompt = renderSkillTemplate(skill.prompt, variables);

    return { prompt, skillName: skill.name };
  });
}
