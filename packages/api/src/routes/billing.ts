import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { encryptOptional } from "../crypto-tokens.js";
import { db, prisma } from "../db.js";
import { clearFallbackState } from "../model-fallback.js";
import { MODEL } from "../openai.js";
import { getUserUsage } from "../quota-limiter.js";
import { getEffectivePlan, PLAN_FEATURES, PLANS, stripe } from "../stripe.js";

function keyHash(apiKey: string | null | undefined): string | null {
  if (!apiKey) return null;
  return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
}

export async function billingRoutes(app: FastifyInstance) {
  // All billing routes require authentication
  app.addHook("preHandler", requireAuth);
  // POST /api/billing/checkout — Create Stripe checkout session
  app.post("/checkout", async (request, reply) => {
    const userId = getUserId(request);
    const { plan } = request.body as {
      plan: "PRO";
    };

    // Only PRO accepts new checkouts. Legacy TEAM subscriptions keep working
    // via webhook/status routes but cannot be purchased from the UI.
    if (plan !== "PRO") {
      return reply.code(400).send({ error: "Invalid plan" });
    }

    const planConfig = PLANS[plan];
    if (!planConfig?.priceId) {
      return reply.code(400).send({ error: "Invalid plan" });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "User not found" });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: user.stripeId ? undefined : user.email,
      customer: user.stripeId || undefined,
      line_items: [{ price: planConfig.priceId, quantity: 1 }],
      success_url: `${process.env.WEB_URL || "http://localhost:8001"}/billing?success=true`,
      cancel_url: `${process.env.WEB_URL || "http://localhost:8001"}/billing?canceled=true`,
      metadata: { userId, plan },
    });

    return { url: session.url };
  });

  // POST /api/billing/portal — Create Stripe customer portal session
  app.post("/portal", async (request, reply) => {
    const userId = getUserId(request);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.stripeId) {
      return reply.code(400).send({ error: "No billing account" });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeId,
      return_url: `${process.env.WEB_URL || "http://localhost:8001"}/billing`,
    });

    return { url: session.url };
  });

  // GET /api/billing/status — Get user's billing status
  app.get("/status", async (request, reply) => {
    const userId = getUserId(request);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "User not found" });

    const planConfig = getEffectivePlan(user.plan, user.role);

    // Count user messages and tokens this billing period (current calendar month)
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [messageCount, tokenAgg] = await Promise.all([
      prisma.message.count({
        where: {
          conversation: { userId },
          role: "USER",
          createdAt: { gte: periodStart },
        },
      }),
      db.tokenUsage.aggregate({
        where: { userId, createdAt: { gte: periodStart } },
        _sum: { totalTokens: true, estimatedCost: true },
      }),
    ]);

    return {
      plan: user.plan,
      planName: planConfig.name,
      messageLimit: planConfig.messageLimit,
      messageCount,
      tokenLimit: planConfig.tokenLimit,
      tokenUsage: tokenAgg._sum.totalTokens || 0,
      estimatedCost: Math.round((tokenAgg._sum.estimatedCost || 0) * 10000) / 10000,
      stripeId: user.stripeId,
    };
  });

  // GET /api/billing/features — Get features available for user's plan
  app.get("/features", async (request, reply) => {
    const userId = getUserId(request);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "User not found" });

    const features = PLAN_FEATURES[user.plan];
    const featureList = features ? Array.from(features) : [];

    return {
      plan: user.plan,
      features: featureList,
    };
  });

  // GET /api/billing/models — Report the active LLM model + BYOK key status.
  // Klorn auto-selects the model now; this endpoint exists so the Settings
  // page can show which model is in use and whether the user has BYOK keys
  // attached.
  app.get("/models", async (request, reply) => {
    const userId = getUserId(request);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "User not found" });

    const keyFields = user as unknown as {
      openRouterApiKey?: string | null;
      geminiApiKey?: string | null;
    };

    const usage = getUserUsage(userId);

    return {
      plan: user.plan,
      activeModel: MODEL,
      hasOpenRouterApiKey: !!keyFields.openRouterApiKey,
      hasGeminiApiKey: !!keyFields.geminiApiKey,
      usage: {
        rpmUsed: usage.rpmUsed,
        rpmCap: usage.rpmCap,
        dailyUsed: usage.dailyUsed,
        dailyCap: usage.dailyCap,
        dailyResetAt: usage.dailyResetAt.toISOString(),
      },
    };
  });

  // PATCH /api/billing/models — Bring-your-own-key updates. The chat/agent
  // model is no longer user-selectable; passing chatModel/agentModel is
  // accepted but ignored to preserve old client compatibility.
  app.patch(
    "/models",
    {
      // Bound + shape the body: a BYOK key is short, so cap it (an unbounded
      // string would bloat the row and get re-read+decrypted on every hot-path
      // call). additionalProperties:false rejects anything unexpected.
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            openRouterApiKey: { type: ["string", "null"], maxLength: 512 },
            geminiApiKey: { type: ["string", "null"], maxLength: 512 },
            clearOpenRouterApiKey: { type: "boolean" },
            clearGeminiApiKey: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = getUserId(request);
      const { openRouterApiKey, geminiApiKey, clearOpenRouterApiKey, clearGeminiApiKey } =
        request.body as {
          openRouterApiKey?: string | null;
          geminiApiKey?: string | null;
          clearOpenRouterApiKey?: boolean;
          clearGeminiApiKey?: boolean;
        };

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return reply.code(404).send({ error: "User not found" });

      const updateData: { openRouterApiKey?: string | null; geminiApiKey?: string | null } = {};

      if (typeof openRouterApiKey === "string") {
        const trimmed = openRouterApiKey.trim();
        updateData.openRouterApiKey = trimmed ? encryptOptional(trimmed) : null;
      } else if (clearOpenRouterApiKey) {
        updateData.openRouterApiKey = null;
      }

      if (typeof geminiApiKey === "string") {
        const trimmed = geminiApiKey.trim();
        updateData.geminiApiKey = trimmed ? encryptOptional(trimmed) : null;
      } else if (clearGeminiApiKey) {
        updateData.geminiApiKey = null;
      }

      if (Object.keys(updateData).length === 0) {
        return reply.code(400).send({ error: "No key setting specified" });
      }

      await prisma.user.update({
        where: { id: userId },
        data: { ...updateData, updatedAt: new Date() },
      });

      return {
        success: true,
        hasOpenRouterApiKey:
          updateData.openRouterApiKey !== undefined
            ? !!updateData.openRouterApiKey
            : !!(user as unknown as { openRouterApiKey?: string | null }).openRouterApiKey,
        hasGeminiApiKey:
          updateData.geminiApiKey !== undefined
            ? !!updateData.geminiApiKey
            : !!(user as unknown as { geminiApiKey?: string | null }).geminiApiKey,
      };
    },
  );
}
