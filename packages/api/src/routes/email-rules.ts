/**
 * Email rules sub-routes.
 *
 * Extracted from routes/email.ts (2026-05-19) so the parent file —
 * which is still 2900+ lines — can shrink one cohesive endpoint group
 * at a time without behavior changes.
 *
 * Mount path: every route here is registered under the same prefix as
 * the parent `emailRoutes`. From a client's perspective, nothing moved
 * — GET/POST/PATCH/DELETE /api/email/rules still answers from this file.
 *
 * The full route set lives in routes/email.ts:
 *   - GET    /rules
 *   - POST   /rules
 *   - PATCH  /rules/:id
 *   - DELETE /rules/:id
 */

import type { EmailRuleAction, Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";

export async function registerEmailRulesRoutes(app: FastifyInstance) {
  // GET /api/email/rules
  app.get("/rules", async (request) => {
    const uid = getUserId(request);
    const rules = await prisma.emailRule.findMany({
      where: { userId: uid },
      orderBy: { createdAt: "desc" },
    });
    // conditions is JSONB after migration 20260519030000_email_rule_conditions_jsonb
    // so Prisma returns it as a parsed value — no JSON.parse needed.
    return { rules };
  });

  // POST /api/email/rules
  app.post("/rules", { preHandler: requireAuth }, async (request) => {
    const uid = getUserId(request);
    const { name, description, conditions, actionType, actionValue } = request.body as {
      name: string;
      description?: string;
      conditions: { from?: string[]; subjectContains?: string[]; category?: string[] };
      actionType: string;
      actionValue: string;
    };

    if (!name || !conditions || !actionValue) {
      return { error: "Missing required fields: name, conditions, actionValue" };
    }

    const rule = await prisma.emailRule.create({
      data: {
        userId: uid,
        name,
        description: description || null,
        // Prisma serializes the object directly into the JSONB column;
        // we no longer round-trip through JSON.stringify.
        conditions: conditions as Prisma.InputJsonValue,
        actionType: (actionType as EmailRuleAction) || "AUTO_REPLY",
        actionValue,
      },
    });

    return { rule };
  });

  // PATCH /api/email/rules/:id
  app.patch("/rules/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const uid = getUserId(request);
    const updates = request.body as {
      name?: string;
      description?: string;
      conditions?: object;
      actionType?: string;
      actionValue?: string;
      isActive?: boolean;
    };

    const rule = await prisma.emailRule.findFirst({ where: { id, userId: uid } });
    if (!rule) return { error: "Rule not found" };

    const data: Prisma.EmailRuleUpdateInput = {};
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.description !== undefined) data.description = updates.description;
    if (updates.conditions !== undefined) {
      data.conditions = updates.conditions as Prisma.InputJsonValue;
    }
    if (updates.actionType !== undefined) data.actionType = updates.actionType as EmailRuleAction;
    if (updates.actionValue !== undefined) data.actionValue = updates.actionValue;
    if (updates.isActive !== undefined) data.isActive = updates.isActive;

    const updated = await prisma.emailRule.update({ where: { id }, data });
    return { rule: updated };
  });

  // DELETE /api/email/rules/:id
  app.delete("/rules/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const uid = getUserId(request);

    const rule = await prisma.emailRule.findFirst({ where: { id, userId: uid } });
    if (!rule) return { error: "Rule not found" };

    await prisma.emailRule.delete({ where: { id } });
    return { success: true };
  });
}
