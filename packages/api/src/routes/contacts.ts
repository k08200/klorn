import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import { getTrustScoresBulk } from "../trust-score.js";

export async function contactRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/", async (request) => {
    const userId = getUserId(request);
    const { search } = request.query as { search?: string };
    const where: Record<string, unknown> = { userId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { company: { contains: search, mode: "insensitive" } },
        { tags: { contains: search, mode: "insensitive" } },
      ];
    }
    const contacts = await prisma.contact.findMany({ where, orderBy: { name: "asc" } });
    return { contacts };
  });

  // Contacts enriched with trust scores — used by the Contacts page
  app.get("/with-trust", async (request) => {
    const userId = getUserId(request);
    const { search } = request.query as { search?: string };
    const where: Record<string, unknown> = { userId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { company: { contains: search, mode: "insensitive" } },
        { tags: { contains: search, mode: "insensitive" } },
      ];
    }
    const contacts = await prisma.contact.findMany({ where, orderBy: { name: "asc" } });

    const emails = contacts.flatMap((c) => (c.email ? [c.email] : []));
    const trustMap = await getTrustScoresBulk(userId, emails);

    const BADGE_ORDER = { reliable: 0, mostly_reliable: 1, unknown: 2, unreliable: 3 } as const;

    const enriched = contacts
      .map((c) => {
        const trust = c.email ? (trustMap.get(c.email.toLowerCase().trim()) ?? null) : null;
        return { ...c, trust };
      })
      .sort((a, b) => {
        const ba = a.trust?.badge ?? "unknown";
        const bb = b.trust?.badge ?? "unknown";
        if (BADGE_ORDER[ba] !== BADGE_ORDER[bb]) return BADGE_ORDER[ba] - BADGE_ORDER[bb];
        return a.name.localeCompare(b.name);
      });

    return { contacts: enriched };
  });

  app.post("/", async (request, reply) => {
    const userId = getUserId(request);
    const body = request.body as Record<string, string>;
    const contact = await prisma.contact.create({
      data: {
        userId,
        name: body.name,
        email: body.email || null,
        phone: body.phone || null,
        company: body.company || null,
        role: body.role || null,
        notes: body.notes || null,
        tags: body.tags || null,
      },
    });
    return reply.code(201).send(contact);
  });

  app.patch("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.contact.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Contact not found" });
    if (existing.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

    const body = request.body as Record<string, string>;
    // Only allow safe fields — prevent userId/id overwrite
    const { name, email, phone, company, role, notes, tags } = body;
    const updates: Record<string, string | null> = {};
    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email || null;
    if (phone !== undefined) updates.phone = phone || null;
    if (company !== undefined) updates.company = company || null;
    if (role !== undefined) updates.role = role || null;
    if (notes !== undefined) updates.notes = notes || null;
    if (tags !== undefined) updates.tags = tags || null;
    const contact = await prisma.contact.update({ where: { id }, data: updates });
    return reply.send(contact);
  });

  app.delete("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.contact.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Contact not found" });
    if (existing.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

    await prisma.contact.delete({ where: { id } });
    return reply.code(204).send();
  });
}
