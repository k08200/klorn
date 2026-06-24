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
import { checkAttentionInputHash } from "../attention-input-hash.js";
import { overrideAttentionTier } from "../attention-override.js";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import { ensureFreshGmailWatch } from "../gmail.js";
import { getInteractionGraph } from "../interaction-graph.js";
import { senderEmail } from "../notification-format.js";
import { captureError } from "../sentry.js";
import { manualOverrideReason, normalizeTier, TIERS, type Tier } from "../tiers.js";
import { getTrustScoresBulk } from "../trust-score.js";

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
      enum: TIERS,
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
  // True iff the stored AttentionItem.inputHash does NOT match a fresh hash
  // of the email's current bytes (from/subject/snippet/labels). Means the
  // input was mutated after classification and the cached tier may be
  // stale. Soft signal — the row is still shown, but the UI can render
  // a "stale, re-classifying" badge and clients shouldn't trust the tier.
  // See attention-input-hash.ts doctrine.
  hashStale?: boolean;
}

interface FirewallResponse {
  tiers: Record<Tier, FirewallItem[]>;
  summary: {
    SILENT: number;
    QUEUE: number;
    PUSH: number;
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

  // GET /api/inbox/firewall/graph — the relationship graph the firewall reasons
  // over, as nodes/edges for a force-directed view. Read-only over data we
  // already have (interaction-graph): NO new graph engine. Nodes = you + your
  // ranked contacts; edges = you→contact (interaction) plus contact↔contact when
  // they share a non-freemail domain (a company cluster). The decision/ontology
  // graph is a separate mode to add later, not mixed in here.
  app.get("/graph", async (request) => {
    const userId = getUserId(request);
    const graph = await getInteractionGraph(userId);

    const domainOf = (email: string): string => {
      const at = email.lastIndexOf("@");
      return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
    };
    // Freemail domains are NOT a company — clustering on them would fuse every
    // unrelated personal contact into one false blob.
    const FREEMAIL = new Set([
      "gmail.com",
      "outlook.com",
      "hotmail.com",
      "yahoo.com",
      "icloud.com",
      "me.com",
      "naver.com",
      "proton.me",
      "protonmail.com",
    ]);

    const nodes = [
      { id: "__you__", label: "You", kind: "self", score: 100, group: "", tags: [] as string[] },
      ...graph.nodes.map((n) => ({
        id: n.email.toLowerCase(),
        label: n.name || n.email,
        kind: "contact" as const,
        score: n.score,
        group: domainOf(n.email),
        tags: n.tags,
        emailCount: n.emailCount,
        lastEmailDaysAgo: n.lastEmailDaysAgo,
        upcomingMeetings: n.upcomingMeetings,
      })),
    ];

    const edges: Array<{ source: string; target: string; kind: string; weight: number }> = [];
    for (const n of graph.nodes) {
      edges.push({
        source: "__you__",
        target: n.email.toLowerCase(),
        kind: "interaction",
        weight: n.score,
      });
    }
    // Chain members of each real-company domain so they cluster, without an
    // O(n^2) clique that would hairball a large company.
    const byDomain = new Map<string, string[]>();
    for (const n of graph.nodes) {
      const d = domainOf(n.email);
      if (!d || FREEMAIL.has(d)) continue;
      const arr = byDomain.get(d) ?? [];
      arr.push(n.email.toLowerCase());
      byDomain.set(d, arr);
    }
    for (const members of byDomain.values()) {
      for (let i = 1; i < members.length; i++) {
        edges.push({ source: members[i - 1], target: members[i], kind: "org", weight: 1 });
      }
    }

    return { nodes, edges, builtAt: graph.builtAt };
  });

  app.get("/", async (request): Promise<FirewallResponse> => {
    const userId = getUserId(request);

    // Activity-driven self-heal: the firewall view is the app's front door,
    // so opening it re-registers an expired Gmail watch even when the
    // in-process renewal scheduler slept through the expiry (free-tier
    // dynos). Fire-and-forget — never blocks or fails the queue response.
    void ensureFreshGmailWatch(userId);

    // Pull OPEN items only — resolved/dismissed don't belong in the live queue.
    // tier is nullable on AttentionItem because the migration backfill is
    // lazy; anything still null gets bucketed as QUEUE so it's visible.
    // inputHash is also nullable (legacy rows pre-PR #468) and is verified
    // soft-mode below; null hash short-circuits the check.
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
            inputHash: string | null;
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
        inputHash: true,
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

    // Batch-fetch EmailMessage rows for any PA that references an email
    // (by Gmail id) AND for any EMAIL-source AttentionItem (by EmailMessage id).
    const gmailIdsNeeded = new Set<string>();
    for (const pa of pendingActions) {
      const args = safeRecord(pa.toolArgs);
      const emailId = extractEmailId(pa.toolName, args);
      if (emailId) gmailIdsNeeded.add(emailId);
    }
    const emailRowIds = items.filter((row) => row.source === "EMAIL").map((row) => row.sourceId);

    const [emailRowsByGmailId, emailRowsById] = await Promise.all([
      gmailIdsNeeded.size
        ? prisma.emailMessage.findMany({
            where: { userId, gmailId: { in: [...gmailIdsNeeded] } },
            select: { id: true, gmailId: true, subject: true, from: true, snippet: true },
          })
        : Promise.resolve([] as never[]),
      emailRowIds.length
        ? prisma.emailMessage.findMany({
            where: { userId, id: { in: emailRowIds } },
            // labels is needed for the hash-verify integration — it's one
            // of the four hashed fields (see attention-input-hash.ts).
            select: {
              id: true,
              gmailId: true,
              subject: true,
              from: true,
              snippet: true,
              labels: true,
            },
          })
        : Promise.resolve([] as never[]),
    ]);
    const emailByGmailId = new Map(emailRowsByGmailId.map((e) => [e.gmailId, e]));
    const emailById = new Map(emailRowsById.map((e) => [e.id, e]));

    // Batch-fetch trust scores for every distinct sender address surfaced
    // by this page. One round-trip; the bulk helper returns a Map keyed by
    // normalized lowercase email.
    const senderAddrs = new Set<string>();
    for (const e of emailRowsByGmailId) {
      const addr = senderEmail(e.from);
      if (addr) senderAddrs.add(addr);
    }
    for (const e of emailRowsById) {
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
      AUTO: [],
    };

    for (const row of items) {
      // normalizeTier maps legacy CALL rows → PUSH (not QUEUE) and any
      // unknown/null tier → QUEUE. See tiers.ts.
      const tier = normalizeTier(row.tier);
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

      // Enrich EMAIL items directly from EmailMessage. sourceId is the
      // EmailMessage.id, set by poc-judge when the email syncs.
      if (row.source === "EMAIL") {
        const email = emailById.get(row.sourceId);
        if (email) {
          // Hash-verify integration (the read-side half of PR #468). For each
          // row that has a stored inputHash, recompute the hash of the email's
          // current bytes and compare. Mismatch means something mutated the
          // input after classification — the cached tier is stale. Soft mode
          // (checkAttentionInputHash, not verify) so the page still renders,
          // and clients see hashStale=true to either re-classify or warn.
          const hashCheck = checkAttentionInputHash(row.inputHash, {
            from: email.from,
            subject: email.subject,
            snippet: email.snippet,
            labels: email.labels,
          });
          if (!hashCheck.ok) {
            item.hashStale = true;
            captureError(
              new Error(
                `AttentionItem hash mismatch — stored=${hashCheck.storedHash.slice(0, 12)}… current=${hashCheck.currentHash.slice(0, 12)}…`,
              ),
              {
                tags: { scope: "firewall.hashVerify" },
                extra: {
                  attentionItemId: row.id,
                  emailDbId: email.id,
                  storedTier: row.tier,
                },
              },
            );
          }

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

      tiers[tier].push(item);
    }

    return {
      tiers,
      summary: {
        SILENT: tiers.SILENT.length,
        QUEUE: tiers.QUEUE.length,
        PUSH: tiers.PUSH.length,
        AUTO: tiers.AUTO.length,
        total: items.length,
      },
    };
  });

  // POST /api/inbox/firewall/:id — manual tier override.
  // Sets the tier directly and stamps a tierReason explaining it was a
  // human override. The override is the ground-truth signal the POC
  // judge uses to score the classifier (Day 7 bar = 80% agreement
  // between auto-tier and user-override-tier). The actual mutation lives
  // in attention-override.ts, shared with the Telegram webhook buttons.
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

      const result = await overrideAttentionTier(userId, id, tier);
      if (!result.ok) {
        reply.code(404);
        return { ok: false, message: "Attention item not found." };
      }

      return { ok: true, tier: result.tier };
    },
  );
}
