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
 * The full route set:
 *   - GET    /rules
 *   - POST   /rules
 *   - PATCH  /rules/:id
 *   - DELETE /rules/:id
 *   - GET    /rules/pins      — the user's tier pins in wire shape
 *   - POST   /rules/compile   — NL rule text → proposed pins (LLM)
 *   - POST   /rules/pins      — replace-apply pins (settings Rules UI)
 */

import type { ApplyTierPinsResponse } from "@klorn/contract";
import type { EmailRuleAction, Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { requireEntitled } from "../billing/entitlement-guard.js";
import { prisma } from "../db.js";
import { describeLlmFailure } from "../llm/describe-failure.js";
import { listTierPins, replaceTierPins, validateTierPin } from "../mail/pin-rules.js";
import { compileRuleText, RULE_TEXT_MAX_CHARS } from "../mail/rule-compile.js";
import { captureError } from "../sentry.js";

/**
 * Shape gate for PIN_TIER rows on the generic CRUD: the judge's read-side
 * invariants (exact single entity, live lane, no public mailbox domain)
 * must hold no matter which endpoint authored the row — without this, the
 * generic POST /rules was a bypass around every pin-route guard.
 */
function pinRuleShapeError(conditions: unknown, actionValue: unknown): string | null {
  const c = (conditions ?? {}) as { from?: unknown; fromDomain?: unknown };
  const hasFrom = Array.isArray(c.from) && c.from.length > 0;
  const hasDomain = Array.isArray(c.fromDomain) && c.fromDomain.length > 0;
  if (hasFrom === hasDomain) {
    return "A PIN_TIER rule needs exactly one of conditions.from or conditions.fromDomain.";
  }
  const entities = (hasFrom ? c.from : c.fromDomain) as unknown[];
  if (entities.length !== 1 || typeof entities[0] !== "string") {
    return "A PIN_TIER rule pins exactly one address or one domain.";
  }
  const validated = validateTierPin({
    scope: hasFrom ? "sender" : "domain",
    value: entities[0],
    tier: String(actionValue ?? ""),
  });
  return "error" in validated ? validated.error : null;
}

/**
 * An AUTO_REPLY rule sends with no per-message approval, so it must name its
 * senders: a non-empty list of non-blank strings (addresses or domains,
 * matched by mail/email-reply.ts ruleSenderMatches). Applied on create and to
 * the merged row of an update that touches the rule's shape.
 */
function autoReplySenderError(conditions: unknown): string | null {
  const from = (conditions as { from?: unknown } | null)?.from;
  const valid =
    Array.isArray(from) &&
    from.length > 0 &&
    from.every((entry) => typeof entry === "string" && entry.trim() !== "");
  return valid ? null : "An auto-reply rule needs at least one sender address or domain.";
}

export async function registerEmailRulesRoutes(app: FastifyInstance) {
  // GET /api/email/rules/pins — declared before the generic routes so the
  // static segment never competes with /rules/:id.
  app.get("/rules/pins", { preHandler: requireAuth }, async (request) => {
    const uid = getUserId(request);
    const pins = await listTierPins(uid);
    return { pins };
  });

  // POST /api/email/rules/compile — one foreground LLM call per request,
  // so the paid-compose gate and the LLM rate budget both apply.
  app.post(
    "/rules/compile",
    {
      preHandler: [requireAuth, requireEntitled],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const uid = getUserId(request);
      const { text } = (request.body as { text?: string }) || {};
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (!trimmed) return reply.code(400).send({ error: "Rule text is required." });
      if (trimmed.length > RULE_TEXT_MAX_CHARS) {
        return reply
          .code(400)
          .send({ error: `Rule text must be at most ${RULE_TEXT_MAX_CHARS} characters.` });
      }
      try {
        const compiled = await compileRuleText(uid, trimmed);
        if (!compiled) {
          return reply
            .code(502)
            .send({ error: "Could not understand that rule — try rephrasing it." });
        }
        return compiled;
      } catch (err) {
        if (err instanceof Error && err.name === "DailyCostCapExceededError") {
          return reply.code(429).send({ error: err.message });
        }
        if (err instanceof Error && err.name === "UserRateLimitedError") {
          const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs ?? 1_000;
          reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
          return reply.code(429).send({ error: err.message });
        }
        captureError(err, { tags: { scope: "email-rules.compile" }, extra: { userId: uid } });
        return reply.code(503).send({
          error: `Rule compilation is temporarily unavailable (${describeLlmFailure(err)}).`,
        });
      }
    },
  );

  // POST /api/email/rules/pins — replace-apply. Pure DB, so requireAuth
  // only, like the rest of this file.
  app.post("/rules/pins", { preHandler: requireAuth }, async (request, reply) => {
    const uid = getUserId(request);
    const { pins } = (request.body as { pins?: unknown }) || {};
    if (!Array.isArray(pins) || pins.length === 0) {
      return reply.code(400).send({ error: "pins must be a non-empty array." });
    }
    if (pins.length > 20) {
      return reply.code(400).send({ error: "At most 20 pins per request." });
    }
    const okPins = [];
    const rejected: ApplyTierPinsResponse["rejected"] = [];
    for (const rawPin of pins) {
      const candidate = rawPin as { scope?: unknown; value?: unknown; tier?: unknown };
      const pin = {
        scope: String(candidate.scope ?? ""),
        value: String(candidate.value ?? ""),
        tier: String(candidate.tier ?? ""),
      };
      const validated = validateTierPin(pin);
      if ("error" in validated) {
        rejected.push({ pin, reason: validated.error });
      } else {
        okPins.push(validated.ok);
      }
    }
    const applied = await replaceTierPins(uid, okPins);
    return { applied, rejected } satisfies ApplyTierPinsResponse;
  });

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

    if (actionType === "PIN_TIER") {
      const shapeError = pinRuleShapeError(conditions, actionValue);
      if (shapeError) return { error: shapeError };
    }
    if ((actionType || "AUTO_REPLY") === "AUTO_REPLY") {
      const senderError = autoReplySenderError(conditions);
      if (senderError) return { error: senderError };
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

    // Same shape gate as POST, applied to the MERGED row: a PATCH must not
    // be able to morph a rule into a malformed PIN_TIER. Only when the
    // update touches the pin shape, though — rows authored before this gate
    // existed can be malformed, and the user must still be able to disable
    // them (isActive) without first fixing a shape they may not understand.
    const nextActionType = updates.actionType ?? rule.actionType;
    const touchesPinShape =
      updates.actionType !== undefined ||
      updates.conditions !== undefined ||
      updates.actionValue !== undefined;
    if (nextActionType === "AUTO_REPLY" && touchesPinShape) {
      const senderError = autoReplySenderError(updates.conditions ?? rule.conditions);
      if (senderError) return { error: senderError };
    }
    if (nextActionType === "PIN_TIER" && touchesPinShape) {
      const shapeError = pinRuleShapeError(
        updates.conditions ?? rule.conditions,
        updates.actionValue ?? rule.actionValue,
      );
      if (shapeError) return { error: shapeError };
    }

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
