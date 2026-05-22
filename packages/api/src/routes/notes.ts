import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";

export async function noteRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // GET /api/notes?search=xxx&category=xxx
  app.get("/", async (request) => {
    const userId = getUserId(request);
    const { search, category } = request.query as { search?: string; category?: string };
    const where: Record<string, unknown> = { userId };
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { content: { contains: search, mode: "insensitive" } },
      ];
    }
    if (category && category !== "all") {
      where.category = category;
    }

    const notes = await prisma.note.findMany({
      where,
      orderBy: { updatedAt: "desc" },
    });

    return { notes };
  });

  // GET /api/notes/:id
  app.get("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const note = await prisma.note.findUnique({ where: { id } });
    if (!note) return reply.code(404).send({ error: "Note not found" });
    if (note.userId !== userId) return reply.code(403).send({ error: "Forbidden" });
    return note;
  });

  // POST /api/notes
  app.post("/", async (request, reply) => {
    const userId = getUserId(request);
    const { title, content, category } = request.body as {
      title: string;
      content: string;
      category?: string;
    };

    const note = await prisma.note.create({
      data: { userId, title, content, category: category || "general" },
    });

    return reply.code(201).send(note);
  });

  // PATCH /api/notes/:id
  app.patch("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.note.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Note not found" });
    if (existing.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

    const body = request.body as { title?: string; content?: string; category?: string };
    // Only allow safe fields — prevent userId/id overwrite
    const updates: Record<string, string> = {};
    if (body.title !== undefined) updates.title = body.title;
    if (body.content !== undefined) updates.content = body.content;
    if (body.category !== undefined) updates.category = body.category;
    const note = await prisma.note.update({ where: { id }, data: updates });
    return reply.send(note);
  });

  // DELETE /api/notes/:id
  app.delete("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.note.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Note not found" });
    if (existing.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

    await prisma.note.delete({ where: { id } });
    return reply.code(204).send();
  });
}
