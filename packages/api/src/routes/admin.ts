import type { ProposalStatus, WaitlistStatus } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { Resend } from "resend";
import { runAllScenarios, summarizeEval } from "../agentcore/agent-eval.js";
import { getRetentionMetrics } from "../analytics.js";
import { getUserId, requireAdmin } from "../auth.js";
import { checkGlobalCostGate } from "../billing/cost-guard.js";
import { getCostTripSnapshot } from "../billing/cost-trip-alert.js";
import { getUsageSummary } from "../billing/llm-usage.js";
import { appleLoginEnabled, naverLoginEnabled } from "../config.js";
import { db, prisma } from "../db.js";
import { withTenant } from "../db-tenant.js";
import type { CalibrationSnapshotPayload } from "../judge/calibration-snapshot.js";
import { getDecisionMetrics } from "../judge/decision-metrics.js";
import { getJudgeHealth } from "../judge/judge-fallback-check.js";
import { buildInteractionGraph } from "../learning/interaction-graph.js";
import {
  listAppliedLearnedRules,
  listOpenLearnedRules,
  recomputeLearnedRules,
} from "../learning/learned-rule-store.js";
import { describePolicy } from "../learning/ontology.js";
import { refreshOverrideCache } from "../learning/ontology-overrides.js";
import {
  listAppliedProposals,
  listOpenProposals,
  recomputeOntologyProposals,
} from "../learning/ontology-proposals-store.js";
import { getTraitMetrics } from "../learning/sender-trait-metrics.js";
import { clearFallbackState, getProviderCooldownInfo } from "../llm/model-fallback.js";
import { MODEL } from "../llm/openai.js";
import { sendBetaInviteEmail } from "../mail/email.js";
import { collectFeatureFlags } from "../ops/feature-flags.js";
import { getPerfSnapshot } from "../perf-monitor.js";
import { cohortReadout, pmfSummary } from "../product/cohort.js";
import { getProviderChain } from "../providers/index.js";
import { captureError } from "../sentry.js";
import { deleteUserAndAllData } from "../user-deletion.js";

type FeedbackGroup = { signal: string; _count: { signal: number } };

/** Compact per-day KPI entry for the calibration trend (full payload only on `latest`). */
function calibrationSeriesEntry(row: { dayKey: string; payload: unknown }) {
  const p = row.payload as Partial<CalibrationSnapshotPayload> | null;
  return {
    dayKey: row.dayKey,
    totalItems: p?.totalItems ?? 0,
    manualOverrides: p?.manualOverrides ?? null,
    feedbackOverrides: p?.feedbackOverrides ?? null,
    judgeSourceCounts: p?.judgeSourceCounts ?? null,
    driftDeltaMax: p?.driftSignal?.deltaMax ?? null,
    // Weekly counterfactual accuracy on real overrides (Sundays only).
    correctionEval: p?.correctionEval ?? null,
    // Ledger-derived drift series: bounded PUSH recall + SILENT over-suppression.
    decisionMetrics: p?.decisionMetrics ?? null,
  };
}

function summarizeTrustFeedback(rows: FeedbackGroup[]) {
  const counts = { useful: 0, wrong: 0, later: 0, done: 0 };
  for (const row of rows) {
    if (row.signal === "APPROVED") counts.useful += row._count.signal;
    if (row.signal === "REJECTED") counts.wrong += row._count.signal;
    if (row.signal === "SNOOZED") counts.later += row._count.signal;
    if (row.signal === "DISMISSED") counts.done += row._count.signal;
  }
  const total = counts.useful + counts.wrong + counts.later + counts.done;
  return {
    total,
    ...counts,
    usefulRate: total > 0 ? counts.useful / total : null,
  };
}

const waitlistCreateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
    name: { type: "string", minLength: 1, maxLength: 120 },
    note: { type: "string", minLength: 1, maxLength: 500 },
  },
} as const;

const waitlistQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", maxLength: 500 },
  },
} as const;

const llmUsageQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    userId: { type: "string", maxLength: 500 },
    days: { type: "string", maxLength: 500 },
  },
} as const;

const calibrationQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    userId: { type: "string", maxLength: 500 },
    days: { type: "string", maxLength: 500 },
  },
} as const;

const decisionMetricsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    userId: { type: "string", maxLength: 500 },
    days: { type: "string", maxLength: 500 },
    source: { type: "string", maxLength: 500 },
  },
} as const;

const interactionGraphRebuildQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    userId: { type: "string", maxLength: 500 },
  },
} as const;

const senderTraitsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    userId: { type: "string", maxLength: 500 },
  },
} as const;

/**
 * Google's unverified-app allowance.
 *
 * While the OAuth consent screen is "In production, unverified", the project
 * can create a fixed number of new users over its LIFETIME — the count does
 * not reset, and clicking through the unverified warning spends a slot. The
 * beta gate used to hold this line; with sign-up open it is spending, so the
 * remaining room needs to be visible somewhere other than the Cloud console.
 *
 * Approximate by design: this counts accounts Klorn created, which is a lower
 * bound on slots Google has actually charged. It tracks the trend, and the
 * console stays the authority. GOOGLE_UNVERIFIED_USER_CAP lets the number move
 * (or go effectively away) once CASA verification clears.
 */
const DEFAULT_GOOGLE_USER_CAP = 100;

function googleQuota(consumed: number): { consumed: number; cap: number; remaining: number } {
  const parsed = Number.parseInt(process.env.GOOGLE_UNVERIFIED_USER_CAP ?? "", 10);
  const cap = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GOOGLE_USER_CAP;
  // An over-cap project must read as zero room left, never as negative room.
  return { consumed, cap, remaining: Math.max(0, cap - consumed) };
}

/**
 * Which social-login vars a deployment actually has, and whether its signing
 * key is usable — reported as names and booleans, never values.
 *
 * `?error=apple_config` says the deployment is misconfigured but not which of
 * five vars is at fault, and the only thing that knew was a service log line.
 * A key pasted into a field that strips newlines is the common case and looks
 * identical to a missing one from outside.
 */
const APPLE_VARS = [
  "APPLE_CLIENT_ID",
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
  "APPLE_REDIRECT_URI",
] as const;

const NAVER_VARS = ["NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET", "NAVER_REDIRECT_URI"] as const;

function splitByPresence(names: readonly string[]): { present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    (process.env[name] ? present : missing).push(name);
  }
  return { present, missing };
}

/** Parse-only: proves the paste survived, never returns the key. */
async function checkApplePrivateKey(): Promise<{
  present: boolean;
  parses: boolean;
  detail: string;
}> {
  const raw = process.env.APPLE_PRIVATE_KEY;
  if (!raw) return { present: false, parses: false, detail: "not set" };
  try {
    const { importPKCS8 } = await import("jose");
    await importPKCS8(raw.replace(/\\n/g, "\n"), "ES256");
    return { present: true, parses: true, detail: "ok" };
  } catch (err) {
    return { present: true, parses: false, detail: (err as Error).message };
  }
}

export async function adminRoutes(app: FastifyInstance) {
  // All admin routes require ADMIN role
  app.addHook("preHandler", requireAdmin);

  // GET /api/admin/flags — one truthful "what is actually on?" snapshot
  // (import-time consts vs dynamic env reads, labeled; presence-only for
  // operational config — never values). Ends the probe-behavior-to-find-out
  // loop every flag flip used to require. `costGuard` adds today's cost-cap
  // trip state so a silently-degraded judge (ceiling tripped → keyword
  // fallback → PUSH dead) is visible here instead of only in logs.
  app.get("/flags", async () => {
    const globalGate = await checkGlobalCostGate();
    return {
      ...collectFeatureFlags(),
      costGuard: {
        ...getCostTripSnapshot(),
        globalUsedCents: globalGate.usedCents,
        globalCapCents: globalGate.capCents,
      },
    };
  });

  // GET /api/admin/analytics — Phase 1 retention dashboard (DAU/WAU, D1/D7/D14
  // retention, queue-actions/day, PUSH open-rate, notification-mute rate).
  app.get("/analytics", async () => getRetentionMetrics());

  // POST /api/admin/sentry-test — fire a marker event through the REAL
  // captureError path so "is error tracking actually wired?" is verifiable
  // end-to-end (DSN set, SDK initialized, event ingested) instead of assumed.
  app.post("/sentry-test", async (request) => {
    const userId = getUserId(request);
    const marker = `sentry-verification-${Date.now()}`;
    captureError(new Error(`Sentry verification test (${marker})`), {
      tags: { scope: "admin.sentry-test" },
      extra: { firedBy: userId, marker },
    });
    return { fired: true, marker, sentryConfigured: Boolean(process.env.SENTRY_DSN) };
  });

  // GET /api/admin/users — List all users
  app.get("/users", async () => {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        plan: true,
        stripeId: true,
        createdAt: true,
        _count: {
          select: {
            conversations: true,
            tasks: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Add monthly message count for each user
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const usersWithUsage = await Promise.all(
      users.map(async (user: (typeof users)[number]) => {
        const messageCount = await prisma.message.count({
          where: {
            conversation: { userId: user.id },
            role: "USER",
            createdAt: { gte: periodStart },
          },
        });
        return { ...user, messageCount };
      }),
    );

    return { users: usersWithUsage };
  });

  // PATCH /api/admin/users/:id — Update user plan or role
  app.patch("/users/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { plan, role } = request.body as { plan?: string; role?: string };

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: "User not found" });

    const data: Record<string, string> = {};
    if (plan && ["FREE", "PRO", "TEAM", "ENTERPRISE"].includes(plan)) {
      data.plan = plan;
    }
    if (role && ["USER", "ADMIN"].includes(role)) {
      data.role = role;
    }

    if (Object.keys(data).length === 0) {
      return reply.code(400).send({ error: "No valid fields to update" });
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, email: true, name: true, role: true, plan: true },
    });

    return updated;
  });

  // DELETE /api/admin/users/:id — Delete user and all their data
  app.delete("/users/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: "User not found" });
    if (user.role === "ADMIN") {
      return reply.code(400).send({ error: "Cannot delete admin user" });
    }

    // Shared with the self-service delete route so the two can never drift.
    await deleteUserAndAllData(id);

    return reply.code(204).send();
  });

  // GET /api/admin/cohort — who actually showed up, and would they miss it.
  // Reads only what is already stored; asks no user anything. Ranked by mail
  // volume because that is the ICP hypothesis under test.
  app.get("/cohort", async () => {
    const [rows, pmf] = await Promise.all([cohortReadout(), pmfSummary()]);
    return { pmf, cohort: rows };
  });

  // GET /api/admin/stats — Dashboard stats
  app.get("/stats", async () => {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalUsers, totalConversations, totalMessages, planDistribution, googleUsers] =
      await Promise.all([
        prisma.user.count(),
        prisma.conversation.count(),
        prisma.message.count({ where: { createdAt: { gte: periodStart } } }),
        prisma.user.groupBy({ by: ["plan"], _count: { id: true } }),
        // Google-origin accounts only: no password, and no Apple/Naver
        // identity. Counting every user would over-report the burn the moment
        // another provider is enabled.
        prisma.user.count({ where: { passwordHash: null, identities: { none: {} } } }),
      ]);

    return {
      totalUsers,
      googleQuota: googleQuota(googleUsers),
      totalConversations,
      monthlyMessages: totalMessages,
      planDistribution: Object.fromEntries(
        planDistribution.map((p: { plan: string; _count: { id: number } }) => [
          p.plan,
          p._count.id,
        ]),
      ),
    };
  });

  // GET /api/admin/provider-config — which social-login vars this deployment
  // has and whether the Apple key parses. Names and booleans only.
  app.get("/provider-config", async () => {
    const apple = splitByPresence(APPLE_VARS);
    const naver = splitByPresence(NAVER_VARS);
    return {
      apple: {
        enabled: appleLoginEnabled(),
        ...apple,
        privateKey: await checkApplePrivateKey(),
      },
      naver: { enabled: naverLoginEnabled(), ...naver },
    };
  });

  // GET /api/admin/ops — Operational metrics (tool success rate, approval rate, DAU, token cost, etc.)
  app.get("/ops", async () => {
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    const last24h = new Date(now.getTime() - day);
    const last7d = new Date(now.getTime() - 7 * day);
    const last30d = new Date(now.getTime() - 30 * day);

    // Tool success/failure from AgentLog (action: auto_action|error|skip)
    const [toolExecuted, toolErrors, toolSkipped] = await Promise.all([
      db.agentLog.count({ where: { action: "auto_action", createdAt: { gte: last7d } } }),
      db.agentLog.count({ where: { action: "error", createdAt: { gte: last7d } } }),
      db.agentLog.count({ where: { action: "skip", createdAt: { gte: last7d } } }),
    ]);
    const totalToolCalls = toolExecuted + toolErrors;
    const toolSuccessRate = totalToolCalls > 0 ? toolExecuted / totalToolCalls : 0;

    // Approval rate from PendingAction
    const [proposed, approved, rejected, stillPending] = await Promise.all([
      db.pendingAction.count({ where: { createdAt: { gte: last7d } } }),
      db.pendingAction.count({ where: { status: "EXECUTED", createdAt: { gte: last7d } } }),
      db.pendingAction.count({ where: { status: "REJECTED", createdAt: { gte: last7d } } }),
      db.pendingAction.count({ where: { status: "PENDING", createdAt: { gte: last7d } } }),
    ]);
    const decided = approved + rejected;
    const approvalRate = decided > 0 ? approved / decided : 0;

    // Notification read rate
    const [notifSent, notifRead] = await Promise.all([
      prisma.notification.count({ where: { createdAt: { gte: last7d } } }),
      prisma.notification.count({ where: { createdAt: { gte: last7d }, isRead: true } }),
    ]);
    const readRate = notifSent > 0 ? notifRead / notifSent : 0;

    const [briefingFeedback, replyNeededFeedback] = await Promise.all([
      prisma.feedbackEvent.groupBy({
        by: ["signal"],
        where: {
          source: "ATTENTION_ITEM",
          toolName: "briefing_top_action",
          createdAt: { gte: last7d },
        },
        _count: { signal: true },
      }),
      prisma.feedbackEvent.groupBy({
        by: ["signal"],
        where: {
          source: "ATTENTION_ITEM",
          toolName: "reply_needed",
          createdAt: { gte: last7d },
        },
        _count: { signal: true },
      }),
    ]);

    // Active users
    const [dau, wau, mau] = await Promise.all([
      prisma.message
        .groupBy({
          by: ["conversationId"],
          where: { createdAt: { gte: last24h }, role: "USER" },
        })
        .then((g: { conversationId: string }[]) => g.length),
      prisma.message
        .groupBy({
          by: ["conversationId"],
          where: { createdAt: { gte: last7d }, role: "USER" },
        })
        .then((g: { conversationId: string }[]) => g.length),
      prisma.message
        .groupBy({
          by: ["conversationId"],
          where: { createdAt: { gte: last30d }, role: "USER" },
        })
        .then((g: { conversationId: string }[]) => g.length),
    ]);

    // Token usage + estimated cost
    const tokenAgg = await db.tokenUsage.aggregate({
      where: { createdAt: { gte: last7d } },
      _sum: { promptTokens: true, completionTokens: true, totalTokens: true, estimatedCost: true },
    });
    const promptTokens = Number(tokenAgg._sum?.promptTokens ?? 0);
    const completionTokens = Number(tokenAgg._sum?.completionTokens ?? 0);
    const totalTokens = Number(tokenAgg._sum?.totalTokens ?? 0);
    const estimatedCostUsd = Number(tokenAgg._sum?.estimatedCost ?? 0);

    // Top errors (last 7d)
    const recentErrors = await db.agentLog.findMany({
      where: { action: "error", createdAt: { gte: last7d } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { summary: true, createdAt: true, userId: true, tool: true },
    });

    return {
      window: "7d",
      tools: {
        executed: toolExecuted,
        errors: toolErrors,
        skipped: toolSkipped,
        successRate: toolSuccessRate,
      },
      approvals: {
        proposed,
        approved,
        rejected,
        pending: stillPending,
        approvalRate,
      },
      notifications: {
        sent: notifSent,
        read: notifRead,
        readRate,
      },
      trust: {
        briefingTop3: summarizeTrustFeedback(briefingFeedback),
        replyNeeded: summarizeTrustFeedback(replyNeededFeedback),
      },
      activeUsers: { dau, wau, mau },
      tokens: {
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd,
      },
      recentErrors,
    };
  });

  // GET /api/admin/perf — Per-route latency (p50/p95/p99) since last server restart
  app.get("/perf", async () => {
    const snapshot = getPerfSnapshot();
    return { routes: snapshot, capturedAt: new Date().toISOString() };
  });

  // GET /api/admin/waitlist — Public waitlist entries (PENDING first)
  app.get("/waitlist", { schema: { querystring: waitlistQuerySchema } }, async (request) => {
    const { status } = request.query as { status?: string };
    const where =
      status === "APPROVED" || status === "REJECTED" ? { status: status as WaitlistStatus } : {};
    const entries = await db.waitlist.findMany({
      where,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 200,
    });
    const countRows = await db.waitlist.groupBy({
      by: ["status"],
      _count: { status: true },
    });
    const counts: Record<string, number> = {};
    for (const row of countRows) {
      counts[row.status] = row._count.status;
    }
    return { entries, counts };
  });

  // POST /api/admin/waitlist — put an address on the list by hand.
  //
  // The public intake (POST /api/waitlist) was deleted 2026-08-26: it had no
  // caller and the landing says "no invite, no waitlist". But it was also the
  // only way a row could be created, and `docs/oauth-verification/README.md`
  // §3.5 depends on creating one — with BETA_GATE_ENABLED on, a Google
  // reviewer and the CASA DAST scanner cannot sign themselves up, so their
  // addresses have to be pre-provisioned. Deleting a public endpoint should
  // not cost us that, so creation moved behind `requireAdmin` rather than
  // disappearing.
  //
  // Unlike the public route this does not pretend an existing address is new:
  // there is no enumeration concern behind an admin token, and the caller
  // needs to know whether they just created a row or found one.
  app.post("/waitlist", { schema: { body: waitlistCreateSchema } }, async (request, reply) => {
    const body = request.body as { email: string; name?: string; note?: string };
    const email = body.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: "Invalid email" });
    }
    const existing = await db.waitlist.findUnique({
      where: { email },
      select: { id: true, email: true, status: true },
    });
    if (existing) {
      return reply.code(200).send({ entry: existing, created: false });
    }
    const entry = await db.waitlist.create({
      data: {
        email,
        name: body.name?.trim() || null,
        useCase: body.note?.trim() || null,
        source: "admin",
      },
      select: { id: true, email: true, status: true },
    });
    return reply.code(201).send({ entry, created: true });
  });

  // DELETE /api/admin/waitlist/:id — remove a row for good.
  //
  // The list accumulates junk: smoke tests, mistyped addresses, and probes from
  // back when POST /api/waitlist was public and unauthenticated. Until now the
  // only cleanup was Reject, which leaves the row in the list forever, so the
  // PENDING count stopped meaning "people waiting".
  //
  // An APPROVED row is refused. While BETA_GATE_ENABLED is on, that row IS the
  // user's access (auth.ts:411, auth.ts:1295, social-login.ts:142 all look up
  // status === "APPROVED"), so deleting one silently locks a real person out of
  // their own account. Reject it first if that is genuinely what you mean —
  // then the refusal no longer applies and the intent is on the record.
  app.delete("/waitlist/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = await db.waitlist.findUnique({
      where: { id },
      select: { id: true, email: true, status: true },
    });
    if (!entry) {
      return reply.code(404).send({ error: "Waitlist entry not found" });
    }
    if (entry.status === "APPROVED") {
      return reply.code(409).send({
        error: "Reject this entry before deleting it — an APPROVED row is a live user's access.",
      });
    }
    await db.waitlist.delete({ where: { id } });
    return { ok: true, deleted: entry.email };
  });

  // PATCH /api/admin/waitlist/:id — mark approved or rejected. On the
  // PENDING/REJECTED → APPROVED transition, fire-and-forget an invite email so
  // the applicant knows they can sign up. Idempotent: re-PATCHing an already-
  // APPROVED entry does not re-send the email.
  app.patch("/waitlist/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = request.body as { status?: string };
    if (status !== "APPROVED" && status !== "REJECTED" && status !== "PENDING") {
      return reply.code(400).send({ error: "status must be APPROVED, REJECTED, or PENDING" });
    }

    const previous = await db.waitlist.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!previous) {
      return reply.code(404).send({ error: "Waitlist entry not found" });
    }

    const entry = await db.waitlist.update({
      where: { id },
      data: {
        status,
        approvedAt: status === "APPROVED" ? new Date() : null,
      },
    });

    if (status === "APPROVED" && previous.status !== "APPROVED") {
      sendBetaInviteEmail(entry.email, entry.name).catch((err) => {
        console.error("[ADMIN] Failed to send beta invite email:", err);
      });
    }

    return entry;
  });

  // GET /api/admin/email-config — Diagnose email delivery: checks env vars and sends a real test email
  app.get("/email-config", async () => {
    const hasApiKey = !!process.env.RESEND_API_KEY;
    const fromEmail = process.env.FROM_EMAIL || "Klorn <onboarding@resend.dev>";
    const adminEmails = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const alertTo = process.env.WAITLIST_ALERT_EMAIL || adminEmails[0] || null;

    if (!hasApiKey) {
      return { ok: false, reason: "RESEND_API_KEY not set", fromEmail, alertTo };
    }
    if (!alertTo) {
      return { ok: false, reason: "ADMIN_EMAILS and WAITLIST_ALERT_EMAIL both unset", fromEmail };
    }

    const resendClient = new Resend(process.env.RESEND_API_KEY!);
    try {
      const result = await resendClient.emails.send({
        from: fromEmail,
        to: alertTo,
        subject: "[Klorn] Email config test",
        html: "<p>Email delivery is working.</p>",
      });
      return { ok: true, fromEmail, alertTo, resendId: (result as { id?: string }).id ?? null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: msg, fromEmail, alertTo };
    }
  });

  // GET /api/admin/llm-state — Snapshot of provider availability and cooldown.
  // Useful during incidents to see which provider is locked out and until when,
  // without grepping logs or restarting the API to clear in-memory state.
  app.get("/llm-state", async () => {
    const chain = getProviderChain();
    const providers = chain.map((p) => {
      const cooldown = getProviderCooldownInfo(p.quotaKey);
      return {
        name: p.name,
        quotaKey: p.quotaKey,
        defaultModel: p.defaultModel,
        supportsTools: p.supportsTools,
        creditRetryAt: cooldown.creditRetryAt?.toISOString() ?? null,
        keyLimitedUntil: cooldown.keyLimitedUntil?.toISOString() ?? null,
        unavailable: !!(cooldown.creditRetryAt || cooldown.keyLimitedUntil),
      };
    });
    return {
      activeModel: MODEL,
      providers,
      observedAt: new Date().toISOString(),
    };
  });

  // POST /api/admin/llm-state/clear — Reset in-memory provider cooldown state.
  // Body: { quotaKey?: string } — when omitted, clears every tracked provider.
  // Use during incidents to un-stick the chain without restarting the API
  // (state is in-memory, so a redeploy also works but takes longer).
  app.post("/llm-state/clear", async (request, reply) => {
    const body = (request.body ?? {}) as { quotaKey?: string };
    let target: string | undefined;
    if (typeof body.quotaKey === "string" && body.quotaKey) {
      // Whitelist the quotaKey shape so a malicious admin (or compromised
      // token) can't pass "__proto__" / control chars / 10kb of garbage into
      // the in-memory state Map.
      if (!/^(openrouter|gemini):(env|user:[A-Za-z0-9_-]{1,64})$/.test(body.quotaKey)) {
        return reply.code(400).send({
          error: "Invalid quotaKey. Expected openrouter|gemini : env|user:<id>.",
        });
      }
      target = body.quotaKey;
    }
    clearFallbackState(target);
    return { success: true, cleared: target ?? "all", clearedAt: new Date().toISOString() };
  });

  // GET /api/admin/llm-usage — Ground-truth LLM token usage (LlmUsageLog).
  // Unlike /ops (TokenUsage, agent-loop only, estimates) this reads the
  // chokepoint ledger: actual provider-reported tokens per call, with the
  // model that really served each request after failover.
  // Query: ?userId=<uuid> to scope to one user, ?days=1..90 (default 7).
  app.get(
    "/llm-usage",
    { schema: { querystring: llmUsageQuerySchema } },
    async (request, reply) => {
      const { userId, days } = request.query as { userId?: string; days?: string };
      const sinceDays = days === undefined ? 7 : Number.parseInt(days, 10);
      if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 90) {
        return reply.code(400).send({ error: "days must be an integer between 1 and 90" });
      }
      return await getUsageSummary(userId || undefined, sinceDays);
    },
  );

  // GET /api/admin/calibration — classification-quality KPIs over time.
  //   ?userId=&days=N → daily series (+ latest full payload) for one user
  //   no userId      → latest snapshot per user (overview)
  // Reads CalibrationSnapshot rows written by the scheduler's daily job —
  // never recomputes live, so the endpoint stays cheap and consistent.
  app.get("/calibration", { schema: { querystring: calibrationQuerySchema } }, async (request) => {
    const q = request.query as { userId?: string; days?: string };
    const days = Math.min(90, Math.max(1, Number(q.days ?? "14") || 14));

    if (q.userId) {
      const rows = (await prisma.calibrationSnapshot.findMany({
        where: { userId: q.userId },
        orderBy: { dayKey: "desc" },
        take: days,
      })) as Array<{ dayKey: string; payload: unknown }>;
      return {
        userId: q.userId,
        days,
        latest: rows[0]?.payload ?? null,
        series: rows.map(calibrationSeriesEntry),
      };
    }

    // Overview: rows arrive newest-first; keep the first row seen per user.
    const rows = (await prisma.calibrationSnapshot.findMany({
      orderBy: { dayKey: "desc" },
      take: 365,
    })) as Array<{ userId: string; dayKey: string; payload: unknown }>;
    const seen = new Set<string>();
    const overview: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      if (seen.has(row.userId)) continue;
      seen.add(row.userId);
      overview.push({ userId: row.userId, ...calibrationSeriesEntry(row) });
    }
    return { overview };
  });

  // GET /api/admin/decision-metrics — the read path over the DecisionLabel
  // ledger. PUSH recall (upper bound) + SILENT over-suppression (lower bound)
  // from real overrides; null outcomes are never counted as agreement.
  // Optional ?userId= narrows to one inbox (the dogfood account).
  app.get(
    "/decision-metrics",
    { schema: { querystring: decisionMetricsQuerySchema } },
    async (request) => {
      const { userId, days, source } = request.query as {
        userId?: string;
        days?: string;
        source?: string;
      };
      const sinceDays = days ? Number(days) : undefined;
      // EMAIL and GITHUB are the only inbound channels that carry a firewall
      // decision; default to EMAIL and ignore anything else so a stray query
      // param can't read an unrelated source. ?source=GITHUB reads the GitHub
      // firewall accuracy (the no-OAuth dogfood channel).
      const channel = source === "GITHUB" ? "GITHUB" : "EMAIL";
      return getDecisionMetrics({
        ...(userId ? { userId } : {}),
        ...(sinceDays !== undefined && Number.isFinite(sinceDays) ? { sinceDays } : {}),
        source: channel,
      });
    },
  );

  // POST /api/admin/interaction-graph/rebuild — force-rebuild the interaction
  // graph NOW. The judge reads a CACHED graph (getCachedInteractionGraph, never
  // rebuilt on the hot path); that cache otherwise refreshes only on the weekly
  // batch or after its 3-day TTL. So right after flipping CONTACT_ENGAGEMENT_IN_
  // JUDGE, freshly-accrued engagement won't reach the judge until a rebuild —
  // this forces it immediately. The counts confirm there's actually a signal to
  // consume (the runbook's "is anything learned yet?" check). Defaults to the
  // acting admin's own account; ?userId= targets another (support/dogfood).
  // Counts only — no contact addresses (see the per-user /graph page for those).
  app.post(
    "/interaction-graph/rebuild",
    { schema: { querystring: interactionGraphRebuildQuerySchema } },
    async (request) => {
      const { userId: q } = request.query as { userId?: string };
      const userId = q || getUserId(request);
      const graph = await buildInteractionGraph(userId);
      const directlyEngaged = graph.nodes.filter(
        (n) => n.learnedImportance != null && (n.outboundCount ?? 0) > 0,
      ).length;
      const orgPropagated = graph.nodes.filter((n) => n.propagatedImportance != null).length;
      return {
        userId,
        builtAt: graph.builtAt,
        nodeCount: graph.nodes.length,
        // Direct measured engagement present in the freshly-built graph. If this is
        // 0, the flip is inert for this user — no replies have accrued yet.
        directlyEngaged,
        // Quiet peers that inherited a soft org prior (cold-start propagation).
        orgPropagated,
        // How many org domains carry an engagement signal (≥2 engaged contacts).
        orgImportanceDomains: Object.keys(graph.orgImportance ?? {}).length,
      };
    },
  );

  // GET /api/admin/judge-health — fleet-wide judge health: the last DB-backed
  // check of how often the judge fell back to the keyword pipeline over 24 h
  // (which caps PUSH recall ~46% / AUTO 0%), plus the top unrecovered provider
  // error this process has seen. `lastCheck.degraded: true` means the LLM scorer
  // is likely failing for everyone. Pairs with the alarm in
  // judge-fallback-check.ts; a stale cache is refreshed in the background.
  app.get("/judge-health", async () => {
    return getJudgeHealth();
  });

  // GET /api/admin/ontology — the read side of the shared deterministic core.
  // A JSON snapshot of every policy the classifier runs on (tier rule, sender
  // priors, keyword patterns, model dial), plus open write-side proposals (the
  // threshold changes the override signal suggests — advisory, never applied
  // live). This is the surface a second app or the desktop shell queries to
  // inspect the same brain the firewall uses.
  app.get("/ontology", async () => {
    const [proposals, applied] = await Promise.all([listOpenProposals(), listAppliedProposals()]);
    return { ...describePolicy(), proposals, applied };
  });

  // POST /api/admin/ontology/proposals/recompute — regenerate write-side
  // proposals from the override ledger on demand (the daily calibration job
  // also does this). Returns the active candidates + write counts.
  app.post("/ontology/proposals/recompute", async (request, reply) => {
    const body = (request.body ?? {}) as { sinceDays?: unknown };
    const raw = body.sinceDays;
    // Validate before it reaches getDecisionMetrics: a non-finite value would
    // become Date(NaN) in the ledger query and throw a 500. undefined is fine
    // (the reader applies its own default window).
    let sinceDays: number | undefined;
    if (raw !== undefined) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 365) {
        return reply.code(400).send({ error: "sinceDays must be an integer between 1 and 365" });
      }
      sinceDays = n;
    }
    return recomputeOntologyProposals({ sinceDays });
  });

  // POST /api/admin/ontology/proposals/:id/dismiss — manually dismiss a proposal
  // (advisory; does not change classifier behavior).
  app.post("/ontology/proposals/:id/dismiss", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.ontologyProposal.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Proposal not found" });
    await prisma.ontologyProposal.update({ where: { id }, data: { status: "DISMISSED" } });
    return reply.code(204).send();
  });

  // POST /api/admin/ontology/proposals/:id/approve — approve a proposal so the
  // classifier reads it live (status APPLIED), then refresh the effective cache.
  app.post("/ontology/proposals/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.ontologyProposal.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Proposal not found" });
    if (existing.status !== "OPEN") {
      return reply.code(409).send({ error: `Cannot approve a ${existing.status} proposal` });
    }
    await prisma.ontologyProposal.update({ where: { id }, data: { status: "APPLIED" } });
    // cacheRefreshed=false means the DB says APPLIED but the live cache didn't
    // update (transient failure) — it will catch up on next restart/refresh.
    const cacheRefreshed = await refreshOverrideCache();
    return { status: "APPLIED", cacheRefreshed };
  });

  // POST /api/admin/ontology/proposals/:id/revert — revert an approved override
  // (status DISMISSED) and refresh the cache so the classifier drops it.
  app.post("/ontology/proposals/:id/revert", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.ontologyProposal.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Proposal not found" });
    if (existing.status !== "APPLIED") {
      return reply.code(409).send({ error: `Cannot revert a ${existing.status} proposal` });
    }
    await prisma.ontologyProposal.update({ where: { id }, data: { status: "DISMISSED" } });
    const cacheRefreshed = await refreshOverrideCache();
    return { status: "DISMISSED", cacheRefreshed };
  });

  // ── Learned rules (per-user generalising rules mined from overrides) ──
  // Unlike ontology proposals (global thresholds), these are scoped to the
  // authenticated admin's OWN userId — a rule can only be reviewed or approved
  // by its owner. There is no cache to refresh: the judge reads APPLIED rules
  // per email (getAppliedRulesForMatch, behind LEARNED_RULES_IN_JUDGE), so a
  // status flip is live on the next email.

  // GET /api/admin/learned-rules — this user's OPEN + APPLIED rules. Each row
  // carries the override sourceIds it was mined from (provenance for review).
  app.get("/learned-rules", async (request) => {
    const userId = getUserId(request);
    const [open, applied] = await Promise.all([
      listOpenLearnedRules(userId),
      listAppliedLearnedRules(userId),
    ]);
    return { open, applied };
  });

  // POST /api/admin/learned-rules/recompute — re-mine this user's rules from
  // their override ledger on demand (the weekly job also does this).
  app.post("/learned-rules/recompute", async (request) => {
    const userId = getUserId(request);
    return recomputeLearnedRules(userId);
  });

  // The three lifecycle transitions below are the same shape: read the rule,
  // reject it unless it is in the expected state, write the new one. Two
  // details are load-bearing rather than stylistic.
  //
  // They run inside withTenant, which binds app.current_user_id for the
  // transaction. That is inert today — the app connects as a role that
  // bypasses RLS outright — and is what lets isolation be switched on later
  // without touching this code. See docs/rls-rollout.md.
  //
  // It also makes the read and the write atomic. Read-then-write across two
  // connections leaves a window where a concurrent request changes the status
  // between the guard and the update, so both callers observe OPEN and both
  // write — the guard reports a conflict that the write does not honour. That
  // is why this call site passes `atomic`: withTenant skips the transaction
  // while RLS is inert, and this block needs the transaction for its own sake,
  // not for isolation.
  //
  // The write is an updateMany scoped by userId, not an update by id. The
  // ownership scope then travels with the write itself instead of depending on
  // the preceding read, which survives a later refactor that moves or drops
  // the guard.
  async function transitionLearnedRule(
    userId: string,
    id: string,
    transition: { from: ProposalStatus; to: ProposalStatus; verb: string; conflictHint?: string },
  ): Promise<{ ok: true } | { ok: false; code: 404 | 409; error: string }> {
    return withTenant(
      userId,
      async (tx) => {
        const existing = await tx.learnedRule.findFirst({ where: { id, userId } });
        if (!existing)
          return { ok: false as const, code: 404 as const, error: "Learned rule not found" };
        if (existing.status !== transition.from) {
          return {
            ok: false as const,
            code: 409 as const,
            error: `Cannot ${transition.verb} a ${existing.status} rule${transition.conflictHint ?? ""}`,
          };
        }
        // A concurrent account purge (purge-user-data.ts) can delete the row
        // between the guard and the write, in which case updateMany matches
        // nothing. Reporting the success the caller did not get would be a
        // silent lie, so treat a vanished row the same as one that was never
        // there. (The pre-refactor `update({where:{id}})` threw P2025 here and
        // surfaced as a 500; 404 describes the same situation truthfully.)
        const written = await tx.learnedRule.updateMany({
          where: { id, userId },
          data: { status: transition.to },
        });
        if (written.count === 0)
          return { ok: false as const, code: 404 as const, error: "Learned rule not found" };
        return { ok: true as const };
      },
      { atomic: true },
    );
  }

  // POST /api/admin/learned-rules/:id/approve — OPEN → APPLIED so the judge
  // starts acting on it (behind the flag). Scoped to the owner.
  app.post("/learned-rules/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await transitionLearnedRule(getUserId(request), id, {
      from: "OPEN",
      to: "APPLIED",
      verb: "approve",
    });
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    return { status: "APPLIED" };
  });

  // POST /api/admin/learned-rules/:id/dismiss — OPEN → DISMISSED (advisory; the
  // judge never read it). OPEN-only: an APPLIED rule is live, so it must be
  // reverted (not silently disabled via dismiss). Scoped to the owner.
  app.post("/learned-rules/:id/dismiss", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await transitionLearnedRule(getUserId(request), id, {
      from: "OPEN",
      to: "DISMISSED",
      verb: "dismiss",
      conflictHint: " (revert it instead)",
    });
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    return reply.code(204).send();
  });

  // POST /api/admin/learned-rules/:id/revert — APPLIED → DISMISSED (the judge
  // drops it on the next email). Scoped to the owner.
  app.post("/learned-rules/:id/revert", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await transitionLearnedRule(getUserId(request), id, {
      from: "APPLIED",
      to: "DISMISSED",
      verb: "revert",
    });
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    return { status: "DISMISSED" };
  });

  // GET /api/admin/eval — Run agent decision-logic eval scenarios
  app.get("/eval", async () => {
    const results = runAllScenarios();
    return {
      summary: summarizeEval(results),
      results: results.map((r) => ({
        id: r.scenario.id,
        name: r.scenario.name,
        description: r.scenario.description,
        category: r.scenario.category,
        severity: r.scenario.severity,
        passed: r.passed,
        message: r.message,
      })),
      runAt: new Date().toISOString(),
    };
  });

  // GET /api/admin/sender-traits — Sender-trait measurement metrics + evidence
  // inspector. Returns aggregate metrics (coverage, confidence distribution,
  // conflict rate) always, and per-sender trait rows with evidenceText ONLY
  // when an explicit ?userId= is given. Without a userId, evidenceText (which
  // is verbatim email quotes) is withheld — a cross-user dump would leak one
  // user's mail to an admin scoped to another, violating CASA data-min even
  // behind the admin gate.
  app.get(
    "/sender-traits",
    { schema: { querystring: senderTraitsQuerySchema } },
    async (request, reply) => {
      const userId = (request.query as { userId?: string }).userId;
      if (userId !== undefined && !/^[0-9a-fA-F-]{10,40}$/.test(userId)) {
        return reply.code(400).send({ error: "Invalid userId" });
      }
      const metrics = await getTraitMetrics(prisma, userId);
      // Per-trait evidence (verbatim email quotes) only for an explicit user —
      // never a cross-user dump, even behind the admin gate (CASA data-min).
      const traits = userId
        ? await prisma.senderTrait.findMany({
            where: { userId },
            orderBy: [{ sender: "asc" }, { factKind: "asc" }],
            take: 200,
            select: {
              sender: true,
              factKind: true,
              factValue: true,
              confidence: true,
              evidenceText: true,
              status: true,
              conflictValue: true,
              observedCount: true,
            },
          })
        : [];
      return { metrics, traits };
    },
  );
}
