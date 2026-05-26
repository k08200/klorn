/**
 * POC Firewall API — the tier-grouped queue + daily receipt counts.
 *
 * GET  /api/inbox/firewall      — open AttentionItems grouped by tier
 *                                 plus today's receipt summary counts.
 * POST /api/inbox/firewall/:id  — manually override one item's tier.
 *
 * This powers the POC `/inbox/firewall` screen. The user sees what
 * Klorn decided (tier-by-tier) and can drag/click an item into a
 * different tier when the classifier got it wrong — that override
 * doubles as ground-truth training signal.
 *
 * Backend was already 99% built: AttentionItem has tier + tierReason,
 * attention-mirror.ts decides the tier for each source, and
 * routes/receipt.ts returns today's categorized lists. This route
 * just exposes the OPEN slice for the live queue view.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";

type Tier = "SILENT" | "QUEUE" | "PUSH" | "CALL" | "AUTO";

const TIER_VALUES: ReadonlyArray<Tier> = ["SILENT", "QUEUE", "PUSH", "CALL", "AUTO"];

const overrideBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["tier"],
  properties: {
    tier: {
      type: "string",
      enum: ["SILENT", "QUEUE", "PUSH", "CALL", "AUTO"],
    },
  },
} as const;

interface FirewallItem {
  id: string;
  source: string;
  sourceId: string;
  type: string;
  title: string;
  tier: Tier;
  tierReason: string | null;
  priority: number;
  surfacedAt: string;
}

interface FirewallResponse {
  tiers: Record<Tier, FirewallItem[]>;
  summary: {
    SILENT: number;
    QUEUE: number;
    PUSH: number;
    CALL: number;
    AUTO: number;
    total: number;
  };
}

export async function firewallRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/", async (request): Promise<FirewallResponse> => {
    const userId = getUserId(request);

    // Pull OPEN items only — resolved/dismissed don't belong in the live queue.
    // tier is nullable on AttentionItem because the migration backfill is
    // lazy; anything still null gets bucketed as QUEUE so it's visible.
    const items = await (
      prisma.attentionItem as unknown as {
        findMany: (args: unknown) => Promise<
          Array<{
            id: string;
            source: string;
            sourceId: string;
            type: string;
            title: string;
            tier: string | null;
            tierReason: string | null;
            priority: number;
            surfacedAt: Date;
          }>
        >;
      }
    ).findMany({
      where: { userId, status: "OPEN" },
      select: {
        id: true,
        source: true,
        sourceId: true,
        type: true,
        title: true,
        tier: true,
        tierReason: true,
        priority: true,
        surfacedAt: true,
      },
      orderBy: [{ priority: "desc" }, { surfacedAt: "desc" }],
      take: 200,
    });

    const tiers: Record<Tier, FirewallItem[]> = {
      SILENT: [],
      QUEUE: [],
      PUSH: [],
      CALL: [],
      AUTO: [],
    };

    for (const row of items) {
      const tier = (TIER_VALUES.includes(row.tier as Tier) ? row.tier : "QUEUE") as Tier;
      tiers[tier].push({
        id: row.id,
        source: row.source,
        sourceId: row.sourceId,
        type: row.type,
        title: row.title,
        tier,
        tierReason: row.tierReason,
        priority: row.priority,
        surfacedAt: row.surfacedAt.toISOString(),
      });
    }

    return {
      tiers,
      summary: {
        SILENT: tiers.SILENT.length,
        QUEUE: tiers.QUEUE.length,
        PUSH: tiers.PUSH.length,
        CALL: tiers.CALL.length,
        AUTO: tiers.AUTO.length,
        total: items.length,
      },
    };
  });

  // POST /api/inbox/firewall/:id — manual tier override.
  // Sets the tier directly and stamps a tierReason explaining it was a
  // human override. The override is the ground-truth signal the POC
  // judge uses to score the classifier (Day 7 bar = 80% agreement
  // between auto-tier and user-override-tier).
  app.post<{
    Params: { id: string };
    Body: { tier: Tier };
  }>(
    "/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        body: overrideBodySchema,
      },
    },
    async (request, reply): Promise<{ ok: true; tier: Tier } | { ok: false; message: string }> => {
      const userId = getUserId(request);
      const { id } = request.params;
      const { tier } = request.body;

      // Ownership check before mutating
      const existing = await (
        prisma.attentionItem as unknown as {
          findFirst: (args: unknown) => Promise<{ id: string } | null>;
        }
      ).findFirst({
        where: { id, userId },
        select: { id: true },
      });

      if (!existing) {
        reply.code(404);
        return { ok: false, message: "Attention item not found." };
      }

      await (
        prisma.attentionItem as unknown as {
          update: (args: unknown) => Promise<unknown>;
        }
      ).update({
        where: { id },
        data: {
          tier,
          tierReason: `Manual override — user moved to ${tier}`,
        },
      });

      return { ok: true, tier };
    },
  );
}
