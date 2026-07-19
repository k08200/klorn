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
 * Override stamps tierReason as 'Manual override — user moved to X' (display)
 * and sets isManualOverride: true (the actual trust signal, GHSA-cxc5-fmqv-pxv6)
 * so the row is identifiable as a human-labelled ground-truth example for
 * poc-judge.
 */

import type { FirewallItem, FirewallResponse } from "@klorn/contract";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { requireAppAccess } from "../billing/entitlement-guard.js";
import { prisma } from "../db.js";
import { dismissAttentionItem } from "../judge/attention-dismiss.js";
import { checkAttentionInputHash, registerHashMismatch } from "../judge/attention-input-hash.js";
import { confirmAttentionTier, overrideAttentionTier } from "../judge/attention-override.js";
import { snoozeAttentionItem } from "../judge/attention-snooze.js";
import { getDecisionMetrics } from "../judge/decision-metrics.js";
import { collapseEmailThreads } from "../judge/firewall-thread-collapse.js";
import { manualOverrideReason, normalizeTier, TIERS, type Tier } from "../judge/tiers.js";
import { getInteractionGraph } from "../learning/interaction-graph.js";
import { describePolicy } from "../learning/ontology.js";
import { getTrustScoresBulk } from "../learning/trust-score.js";
import { ensureFreshGmailWatch } from "../mail/gmail.js";
import { senderEmail } from "../notify/notification-format.js";
import { captureError } from "../sentry.js";

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

// The response wire shapes live in @klorn/contract (single source of truth
// shared with the web board, which used to hand-mirror them — and had drifted:
// its copy was missing hashStale). The classifier's internal Tier (judge/tiers)
// and the contract's wire Tier are structurally identical; the typed literals
// below (tiers record, summary) let tsc enforce that on every build.

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

/// Per-process (row, storedHash) pairs already alerted + healed — see
/// registerHashMismatch. Survives across requests; resets on deploy, which is
/// fine (a still-stale row re-alerts once per boot until the heal lands).
const hashMismatchesSeen = new Set<string>();

/** Test-only: drop the per-process dedupe (mirrors quota-limiter's idiom). */
export function _resetHashMismatchDedupeForTests(): void {
  hashMismatchesSeen.clear();
}

/**
 * Self-heal a stale decision: re-fetch the full row and re-judge it, which
 * rewrites inputHash over the CURRENT bytes (attention-mirror upsert). The
 * doctrine answer to a failed read-side verification is a fresh decision,
 * not a repeated alert (checkAttentionInputHash's own doc says to pair it
 * with a background re-classify). Fire-and-forget; failures are captured.
 */
function healStaleAttentionItem(userId: string, emailDbId: string): void {
  void (async () => {
    try {
      const row = await prisma.emailMessage.findFirst({
        where: { id: emailDbId, userId },
        select: {
          id: true,
          gmailId: true,
          from: true,
          subject: true,
          snippet: true,
          body: true,
          labels: true,
          receivedAt: true,
        },
      });
      if (!row) return;
      // Lazy import: the judge pulls a heavy transitive graph (providers,
      // gmail) that the hot read path — and its tests — must not load.
      const { judgeAndMirrorEmail } = await import("../judge/email-firewall.js");
      await judgeAndMirrorEmail(userId, row);
    } catch (err) {
      captureError(err, { tags: { scope: "firewall.hashRejudge" }, extra: { emailDbId } });
    }
  })();
}

export async function firewallRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  // Usable free tier: the firewall graph/classification view is core, read-only
  // value — admit any non-hard-walled user (free included). No-op pre-launch.
  app.addHook("preHandler", requireAppAccess);

  // GET /api/inbox/firewall/graph?mode=relationships|decisions — nodes/edges for
  // a force-directed view. Read-only over data we already have: NO new graph
  // engine. Two modes:
  //   - relationships (default): you + your ranked contacts (interaction-graph),
  //     clustered by company domain.
  //   - decisions: the classifier "brain" — the 4 features gating the 4 tiers
  //     (the tierFromFeatures rule), with your override signal (decision-metrics)
  //     overlaid on each tier. Always populated (it's the policy structure), so
  //     it renders even on a thin account.
  app.get("/graph", async (request) => {
    const userId = getUserId(request);
    const mode =
      (request.query as { mode?: string }).mode === "decisions" ? "decisions" : "relationships";

    if (mode === "decisions") {
      const policy = describePolicy();
      const m = (await getDecisionMetrics({ userId })).overall;
      // Which features gate each tier, straight from tierFromFeatures' branches.
      const GATES: Record<string, string[]> = {
        PUSH: ["confidence", "urgency"],
        SILENT: ["senderTrust", "urgency", "reversibility"],
        AUTO: ["confidence", "senderTrust", "reversibility", "urgency"],
        QUEUE: ["confidence"],
      };
      const tierNote: Record<string, string> = {
        PUSH:
          m.push.shown > 0
            ? `shown ${m.push.shown}${m.push.recallUpperBound != null ? ` · recall ≤${m.push.recallUpperBound.toFixed(2)}` : ""}`
            : "",
        SILENT:
          m.silent.shown > 0
            ? `shown ${m.silent.shown}${m.silent.overSuppressionRate != null ? ` · over-suppress ${m.silent.overSuppressionRate.toFixed(2)}` : ""}`
            : "",
        QUEUE: "",
        AUTO: "",
      };
      const FEATURES = ["confidence", "senderTrust", "reversibility", "urgency"];
      const nodes = [
        ...FEATURES.map((f) => ({
          id: `feat:${f}`,
          label: f,
          kind: "feature" as const,
          score: 30,
          group: "feature",
          tags: [] as string[],
        })),
        ...policy.tiers.map((t) => ({
          id: `tier:${t}`,
          label: tierNote[t] ? `${t} — ${tierNote[t]}` : t,
          kind: "tier" as const,
          score: 70,
          group: "tier",
          tags: [t],
        })),
      ];
      const edges: Array<{ source: string; target: string; kind: string; weight: number }> = [];
      for (const [tier, feats] of Object.entries(GATES)) {
        for (const f of feats) {
          edges.push({ source: `feat:${f}`, target: `tier:${tier}`, kind: "gate", weight: 1 });
        }
      }
      return {
        mode,
        nodes,
        edges,
        overrideRate: m.overrideRate,
        overriddenKnobs: policy.relation.overriddenKnobs,
      };
    }

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

    // The interaction-graph ranks only the TOP contacts. To densify the view we
    // build a node for EVERY sender in recent stored mail, then overlay the
    // interaction-graph score/tags on the ones it ranked.
    const [interaction, recent, self] = await Promise.all([
      getInteractionGraph(userId),
      prisma.emailMessage.findMany({
        where: { userId },
        select: { from: true },
        orderBy: { receivedAt: "desc" },
        take: 4000,
      }),
      prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    ]);
    const igByEmail = new Map(interaction.nodes.map((n) => [n.email.toLowerCase(), n]));
    const selfEmail = self?.email?.toLowerCase() ?? "";

    const senders = new Map<string, { email: string; name: string | null; count: number }>();
    for (const { from } of recent) {
      const email = senderEmail(from).toLowerCase();
      if (!email || email === selfEmail) continue;
      const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
      const name = m ? m[1].trim() : null;
      const cur = senders.get(email) ?? { email, name, count: 0 };
      cur.count += 1;
      if (!cur.name && name) cur.name = name;
      senders.set(email, cur);
    }
    // Cap by frequency so a big mailbox stays renderable.
    const MAX_CONTACTS = 150;
    const top = [...senders.values()].sort((a, b) => b.count - a.count).slice(0, MAX_CONTACTS);

    const nodes = [
      { id: "__you__", label: "You", kind: "self", score: 100, group: "", tags: [] as string[] },
      ...top.map((s) => {
        const ig = igByEmail.get(s.email);
        return {
          id: s.email,
          label: s.name || s.email,
          kind: "contact" as const,
          // Size by interaction score when ranked, else by email volume.
          score: ig?.score ?? Math.min(70, 8 + s.count * 2),
          group: domainOf(s.email),
          tags: ig?.tags ?? [],
          emailCount: s.count,
          // Learned from the user's own actions (outbound replies/sends): who they
          // actually engage with, so the graph can highlight it. null = no signal.
          learnedImportance: ig?.learnedImportance ?? null,
          outboundCount: ig?.outboundCount ?? 0,
          // Inferred (propagated) importance for a quiet peer at an org the user
          // engages with — rendered softer than direct engagement. null = none.
          propagatedImportance: ig?.propagatedImportance ?? null,
        };
      }),
    ];

    const edges: Array<{ source: string; target: string; kind: string; weight: number }> = [];
    for (const s of top) {
      // Outbound engagement thickens the tie — the graph shows who the user
      // actually reaches back to, not just who emails them.
      const engagement = igByEmail.get(s.email)?.outboundCount ?? 0;
      edges.push({
        source: "__you__",
        target: s.email,
        kind: "interaction",
        weight: s.count + engagement * 2,
      });
    }
    // Chain members of each real-company domain so they cluster, without an
    // O(n^2) clique that would hairball a large company.
    const byDomain = new Map<string, string[]>();
    for (const s of top) {
      const d = domainOf(s.email);
      if (!d || FREEMAIL.has(d)) continue;
      const arr = byDomain.get(d) ?? [];
      arr.push(s.email);
      byDomain.set(d, arr);
    }
    for (const members of byDomain.values()) {
      for (let i = 1; i < members.length; i++) {
        edges.push({ source: members[i - 1], target: members[i], kind: "org", weight: 1 });
      }
    }

    return { nodes, edges, builtAt: interaction.builtAt };
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
              // Gmail thread id — used to collapse a multi-message conversation
              // (N EmailMessage rows) to a single firewall card. See below.
              threadId: true,
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

    // Collapse a multi-message email conversation to one card. Items are ordered
    // [priority desc, surfacedAt desc], so the kept row is the thread's
    // highest-priority (newest on ties) message. Without this, a reschedule
    // thread or a repeated "Deployment failed" shows once per message, each with
    // a different judge-authored tierReason (the duplicate seen in dogfooding).
    const dedupedItems = collapseEmailThreads(
      items,
      (row) => emailById.get(row.sourceId)?.threadId ?? null,
    );

    for (const row of dedupedItems) {
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
            // Alert + heal exactly ONCE per (row, storedHash). Repeats stay
            // silent: hashStale on the wire already tells clients, and the
            // desktop's 60s poll would otherwise re-page the same benign
            // mutation (e.g. reading a mail flips its UNREAD label — one of
            // the four hashed fields) forever. Measured before this guard:
            // 333 Sentry events in the first 12 minutes of DSN going live.
            if (registerHashMismatch(hashMismatchesSeen, row.id, hashCheck.storedHash)) {
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
              healStaleAttentionItem(userId, email.id);
            }
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

  // POST /api/inbox/firewall/:id/confirm — the user explicitly AGREED with the
  // shown tier. Positive ground truth, the counterpart to the override above: it
  // stamps CONFIRM:<tier> on the decision ledger (no tier change, no
  // isManualOverride) so decision-metrics can report a point estimate over rows
  // the user actually labelled instead of a bound over silence. Used by the
  // onboarding "review your classifications" step.
  app.post<{ Params: { id: string } }>(
    "/:id/confirm",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply): Promise<{ ok: true; tier: Tier } | { ok: false; message: string }> => {
      const userId = getUserId(request);
      const { id } = request.params;

      const result = await confirmAttentionTier(userId, id);
      if (!result.ok) {
        reply.code(404);
        return { ok: false, message: "Attention item not found." };
      }

      return { ok: true, tier: result.tier };
    },
  );

  // POST /api/inbox/firewall/:id/snooze — set an item aside until a future time.
  // The scheduler's source-agnostic resurrectSnoozedItems() flips it back to OPEN
  // when snoozeUntil passes, so this works for any source (EMAIL included), unlike
  // the PENDING_ACTION-scoped snooze in chat-pending-actions.ts.
  app.post<{
    Params: { id: string };
    Body: { snoozeUntil: string };
  }>(
    "/:id/snooze",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["snoozeUntil"],
          properties: { snoozeUntil: { type: "string", minLength: 1 } },
        },
      },
    },
    async (
      request,
      reply,
    ): Promise<{ ok: true; snoozedUntil: string } | { ok: false; message: string }> => {
      const userId = getUserId(request);
      const { id } = request.params;
      const { snoozeUntil } = request.body;

      const snoozeDate = new Date(snoozeUntil);
      if (!Number.isFinite(snoozeDate.getTime()) || snoozeDate <= new Date()) {
        reply.code(400);
        return { ok: false, message: "snoozeUntil must be a future ISO datetime." };
      }

      const result = await snoozeAttentionItem(userId, id, snoozeDate);
      if (!result.ok) {
        reply.code(404);
        return { ok: false, message: "Attention item not found." };
      }

      return { ok: true, snoozedUntil: snoozeDate.toISOString() };
    },
  );

  // POST /api/inbox/firewall/:id/dismiss — clear an item from the queue
  // (status DISMISSED) without touching the source email. Works for any source.
  app.post<{
    Params: { id: string };
  }>(
    "/:id/dismiss",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply): Promise<{ ok: true } | { ok: false; message: string }> => {
      const userId = getUserId(request);
      const { id } = request.params;

      const result = await dismissAttentionItem(userId, id);
      if (!result.ok) {
        reply.code(404);
        return { ok: false, message: "Attention item not found." };
      }

      return { ok: true };
    },
  );
}
