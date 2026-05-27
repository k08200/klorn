/**
 * POC Firewall API — the tier-grouped queue + daily receipt counts.
 *
 * GET  /api/inbox/firewall      — open AttentionItems grouped by tier
 *                                 plus today's receipt summary counts.
 *                                 Each PENDING_ACTION item is enriched
 *                                 with toolName/toolArgs and, when the
 *                                 args reference an email_id, with the
 *                                 source email's subject + sender + DB
 *                                 id so the UI can preview and link.
 * POST /api/inbox/firewall/:id  — manually override one item's tier.
 *
 * Override stamps tierReason as 'Manual override — user moved to X' so
 * the row is identifiable as a human-labelled ground-truth example for
 * poc-judge.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import { senderEmail } from "../notification-format.js";
import { getTrustScoresBulk } from "../trust-score.js";

type Tier = "SILENT" | "QUEUE" | "PUSH" | "CALL" | "AUTO";

const TIER_VALUES: ReadonlyArray<Tier> = ["SILENT", "QUEUE", "PUSH", "CALL", "AUTO"];

// Tool args that carry a Gmail message id we can map back to a stored
// EmailMessage row. Other tools (create_event, send_email, etc.) carry
// the user-meaningful payload directly in toolArgs and don't need a join.
const EMAIL_ID_TOOLS = new Set([
  "read_email",
  "mark_read",
  "archive_email",
  "delete_email",
  "reply_to_email",
]);

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

interface TrustWire {
  badge: "reliable" | "mostly_reliable" | "unreliable" | "unknown";
  label: string;
  onTimeRate: number;
  totalCount: number;
}

interface EmailContext {
  // EmailMessage.id (DB id) — used by /email/[id]
  emailDbId: string;
  subject: string | null;
  from: string | null;
  snippet: string | null;
  // Sender trust signal (null when no ContactTrustScore row exists for
  // this address yet). Heavy email users said this is the single most
  // useful per-row signal — render via <TrustDot /> on the firewall card.
  trust: TrustWire | null;
}

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
  // Source-specific enrichment for the preview / drill-down. Populated
  // best-effort; missing fields just mean "no extra context to show".
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  email?: EmailContext;
  href?: string; // where the firewall card should link on click
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

function safeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function extractEmailId(
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
): string | undefined {
  if (!toolArgs || !EMAIL_ID_TOOLS.has(toolName)) return undefined;
  const raw = toolArgs.email_id ?? toolArgs.emailId ?? toolArgs.gmail_id;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
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

    // Batch-fetch PendingActions referenced by the PENDING_ACTION items —
    // gives us toolName / toolArgs / reasoning to render in the card.
    const pendingActionIds = items
      .filter((row) => row.source === "PENDING_ACTION")
      .map((row) => row.sourceId);
    const pendingActions = pendingActionIds.length
      ? await prisma.pendingAction.findMany({
          where: { id: { in: pendingActionIds } },
          select: { id: true, toolName: true, toolArgs: true },
        })
      : [];
    const paById = new Map(pendingActions.map((pa) => [pa.id, pa]));

    // Batch-fetch EmailMessage rows for any PA that references an email.
    const gmailIdsNeeded = new Set<string>();
    for (const pa of pendingActions) {
      const args = safeRecord(pa.toolArgs);
      const emailId = extractEmailId(pa.toolName, args);
      if (emailId) gmailIdsNeeded.add(emailId);
    }
    const emailRows = gmailIdsNeeded.size
      ? await prisma.emailMessage.findMany({
          where: { userId, gmailId: { in: [...gmailIdsNeeded] } },
          select: { id: true, gmailId: true, subject: true, from: true, snippet: true },
        })
      : [];
    const emailByGmailId = new Map(emailRows.map((e) => [e.gmailId, e]));

    // Batch-fetch trust scores for every distinct sender address surfaced
    // by this page. One round-trip; the bulk helper returns a Map keyed by
    // normalized lowercase email.
    const senderAddrs = new Set<string>();
    for (const e of emailRows) {
      const addr = senderEmail(e.from);
      if (addr) senderAddrs.add(addr);
    }
    const trustMap = senderAddrs.size
      ? await getTrustScoresBulk(userId, [...senderAddrs])
      : new Map();

    const tiers: Record<Tier, FirewallItem[]> = {
      SILENT: [],
      QUEUE: [],
      PUSH: [],
      CALL: [],
      AUTO: [],
    };

    for (const row of items) {
      const tier = (TIER_VALUES.includes(row.tier as Tier) ? row.tier : "QUEUE") as Tier;
      const item: FirewallItem = {
        id: row.id,
        source: row.source,
        sourceId: row.sourceId,
        type: row.type,
        title: row.title,
        tier,
        tierReason: row.tierReason,
        priority: row.priority,
        surfacedAt: row.surfacedAt.toISOString(),
      };

      // Enrich PENDING_ACTION items with tool context + maybe email
      if (row.source === "PENDING_ACTION") {
        const pa = paById.get(row.sourceId);
        if (pa) {
          item.toolName = pa.toolName;
          const args = safeRecord(pa.toolArgs);
          if (args) item.toolArgs = args;
          const emailId = extractEmailId(pa.toolName, args);
          if (emailId) {
            const email = emailByGmailId.get(emailId);
            if (email) {
              const addr = senderEmail(email.from);
              const trust = addr ? trustMap.get(addr) : null;
              item.email = {
                emailDbId: email.id,
                subject: email.subject ?? null,
                from: email.from ?? null,
                snippet: email.snippet ?? null,
                trust: trust
                  ? {
                      badge: trust.badge,
                      label: trust.label,
                      onTimeRate: trust.onTimeRate,
                      totalCount: trust.totalCount,
                    }
                  : null,
              };
              item.href = `/email/${email.id}`;
            }
          }
        }
      }

      tiers[tier].push(item);
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
