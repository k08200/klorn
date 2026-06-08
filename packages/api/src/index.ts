import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import { ensureDemoUser, getUserId, requireAuth } from "./auth.js";
import { startBackgroundAgent } from "./background.js";
import { briefingRoutes } from "./briefing.js";
import { db, prisma } from "./db.js";
import { withDbRetry } from "./db-retry.js";
import { attachPerfMonitor } from "./perf-monitor.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { automationRoutes } from "./routes/automations.js";
import { billingRoutes } from "./routes/billing.js";
import { calendarRoutes } from "./routes/calendar.js";
import { chatRoutes } from "./routes/chat-pending-actions.js";
import { commitmentRoutes } from "./routes/commitments.js";
import { cronRoutes } from "./routes/cron.js";
import { deviceRoutes } from "./routes/devices.js";
import { diagnosticsRoutes } from "./routes/diagnostics.js";
import { emailRoutes } from "./routes/email.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { firewallRoutes } from "./routes/firewall.js";
import { gmailPushRoutes } from "./routes/gmail-push.js";
import { inboxRoutes } from "./routes/inbox.js";
import { memoryRoutes } from "./routes/memory.js";
import { naverImapRoutes } from "./routes/naver-imap.js";
import { notificationRoutes } from "./routes/notifications.js";
import { opsRoutes } from "./routes/ops.js";
import { patternRoutes } from "./routes/patterns.js";
import { playbookRoutes } from "./routes/playbooks.js";
import { receiptRoutes } from "./routes/receipt.js";
import { skillRoutes } from "./routes/skills.js";
import { smsRoutes } from "./routes/sms.js";
import { tokenUsageRoutes } from "./routes/token-usage.js";
import { waitlistRoutes } from "./routes/waitlist.js";
import { webhookRoutes } from "./routes/webhook.js";
import { captureError } from "./sentry.js";
import { getClientCount, initWebSocket } from "./websocket.js";

type TxClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

const app = Fastify({ logger: true });

// Attach per-request performance tracking (p50/p95/p99 per route)
attachPerfMonitor(app);

const ALLOWED_ORIGINS = (
  process.env.CORS_ORIGINS ||
  "http://localhost:8001,http://127.0.0.1:8001,http://127.0.2.2:8001,http://127.0.2.3:8001,http://localhost:3000,http://127.0.0.1:3000,tauri://localhost,https://tauri.localhost,http://tauri.localhost"
)
  .split(",")
  .map((o) => o.trim());

function isAllowedDevOrigin(origin: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  try {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    return /^(localhost|127\.0\.0\.1|127\.0\.2\.\d+)$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

await app.register(cors, {
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin || ALLOWED_ORIGINS.includes(origin) || isAllowedDevOrigin(origin)) {
      cb(null, true);
    } else {
      cb(new Error("Not allowed by CORS"), false);
    }
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
});

// Global rate limiting — 100 requests per minute per IP
await app.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute",
  allowList: (req: { url?: string }) => {
    const url = req.url ?? "";
    // OAuth callback: Google redirects here after consent; rate-limiting it
    // would break the login flow for users on slow networks or retry loops.
    if (url.startsWith("/api/auth/google/callback")) return true;
    // Gmail Pub/Sub push traffic comes from Google's shared infra; under heavy
    // mail load it would otherwise trip the per-IP limit and back up delivery.
    if (url.startsWith("/api/gmail/push")) return true;
    return false;
  },
});

// Raw body support for Stripe webhook signature verification
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  try {
    const str = (body as string) || "{}";
    (req as unknown as { rawBody: string }).rawBody = str;
    done(null, JSON.parse(str));
  } catch (err) {
    done(err as Error, undefined);
  }
});

await app.register(billingRoutes, { prefix: "/api/billing" });
await app.register(deviceRoutes, { prefix: "/api/devices" });
await app.register(webhookRoutes, { prefix: "/api/webhook" });
await app.register(chatRoutes, { prefix: "/api/chat" });
await app.register(authRoutes, { prefix: "/api/auth" });
await app.register(briefingRoutes, { prefix: "/api/briefing" });
await app.register(notificationRoutes, { prefix: "/api/notifications" });
await app.register(opsRoutes, { prefix: "/api/ops" });
await app.register(cronRoutes, { prefix: "/api/cron" });
await app.register(diagnosticsRoutes, { prefix: "/api/diagnostics" });
await app.register(inboxRoutes, { prefix: "/api/inbox" });
await app.register(firewallRoutes, { prefix: "/api/inbox/firewall" });
await app.register(receiptRoutes, { prefix: "/api/inbox/receipt" });
await app.register(playbookRoutes, { prefix: "/api/playbooks" });
await app.register(commitmentRoutes, { prefix: "/api/commitments" });
await app.register(feedbackRoutes, { prefix: "/api/feedback" });
await app.register(calendarRoutes, { prefix: "/api/calendar" });
await app.register(emailRoutes, { prefix: "/api/email" });
await app.register(gmailPushRoutes, { prefix: "/api/gmail" });
await app.register(automationRoutes, { prefix: "/api/automations" });
await app.register(waitlistRoutes, { prefix: "/api/waitlist" });
await app.register(adminRoutes, { prefix: "/api/admin" });
await app.register(memoryRoutes, { prefix: "/api/memories" });
await app.register(naverImapRoutes, { prefix: "/api/naver-imap" });
await app.register(patternRoutes, { prefix: "/api/patterns" });
await app.register(tokenUsageRoutes, { prefix: "/api/usage" });
await app.register(skillRoutes, { prefix: "/api/skills" });
await app.register(smsRoutes, { prefix: "/api/sms" });

// Version is read once at startup from package.json on disk — keeps the
// string in lockstep with the published artifact without a separate
// manifest to forget about. Read sync at module load so /api/health is
// answer-ready the moment the listener binds.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PKG_VERSION: string | null = (() => {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const raw = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
})();

app.get("/api/health", async () => {
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    // DB unreachable
  }
  return {
    status: dbOk ? "ok" : "degraded",
    db: dbOk ? "connected" : "unreachable",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: PKG_VERSION ?? null,
    commit:
      process.env.RENDER_GIT_COMMIT ||
      process.env.GIT_COMMIT_SHA ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      null,
  };
});

// Public email diagnostic — sends a real test email to the configured admin
// only. Returns Resend response or error so we can diagnose delivery failures
// without admin auth. Remove once delivery is verified working.
app.get("/api/health/email", async () => {
  const { Resend } = await import("resend");
  const hasApiKey = !!process.env.RESEND_API_KEY;
  const fromEmail = process.env.FROM_EMAIL || "EVE <onboarding@resend.dev>";
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

  const resendClient = new Resend(process.env.RESEND_API_KEY);
  try {
    const result = await resendClient.emails.send({
      from: fromEmail,
      to: alertTo,
      subject: "[EVE] Email config test",
      html: "<p>Email delivery is working.</p>",
    });
    return {
      ok: true,
      fromEmail,
      alertTo,
      resendId:
        (result as { data?: { id?: string }; id?: string }).data?.id ??
        (result as { id?: string }).id ??
        null,
      raw: result,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg, fromEmail, alertTo };
  }
});

// User data management — "me" routes require authentication
app.get("/api/user/me/export", { preHandler: requireAuth }, async (request) => {
  const userId = getUserId(request);
  const [
    tasks,
    notes,
    contacts,
    reminders,
    conversations,
    calendarEvents,
    notifications,
    automationConfig,
    agentLogs,
  ] = await Promise.all([
    prisma.task.findMany({ where: { userId } }),
    prisma.note.findMany({ where: { userId } }),
    prisma.contact.findMany({ where: { userId } }),
    prisma.reminder.findMany({ where: { userId } }),
    prisma.conversation.findMany({
      where: { userId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    }),
    prisma.calendarEvent.findMany({ where: { userId } }),
    prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.automationConfig.findUnique({ where: { userId } }),
    db.agentLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);
  return {
    tasks,
    notes,
    contacts,
    reminders,
    conversations,
    calendarEvents,
    notifications,
    automationConfig,
    agentLogs,
    exportedAt: new Date().toISOString(),
  };
});

app.delete("/api/user/me/data", { preHandler: requireAuth }, async (request, reply) => {
  const userId = getUserId(request);
  await prisma.$transaction(async (tx: TxClient) => {
    await tx.pushSubscription.deleteMany({ where: { userId } });
    await tx.notification.deleteMany({ where: { userId } });
    await (tx as unknown as typeof db).agentLog.deleteMany({ where: { userId } });
    await tx.automationConfig.deleteMany({ where: { userId } });
    await tx.calendarEvent.deleteMany({ where: { userId } });
    await tx.userToken.deleteMany({ where: { userId } });
    await (tx as unknown as typeof db).tokenUsage.deleteMany({ where: { userId } });
    await (tx as unknown as typeof db).memory.deleteMany({ where: { userId } });
    await (tx as unknown as typeof db).conversationSummary.deleteMany({
      where: { conversation: { userId } },
    });
    await tx.message.deleteMany({ where: { conversation: { userId } } });
    await tx.conversation.deleteMany({ where: { userId } });
    await tx.task.deleteMany({ where: { userId } });
    await tx.note.deleteMany({ where: { userId } });
    await tx.contact.deleteMany({ where: { userId } });
    await tx.reminder.deleteMany({ where: { userId } });
    await tx.commitment.deleteMany({ where: { userId } });
    await tx.feedbackEvent.deleteMany({ where: { userId } });
    await tx.attentionItem.deleteMany({ where: { userId } });
    await (
      tx as unknown as Record<string, { deleteMany: (a: unknown) => Promise<unknown> }>
    ).contactTrustScore.deleteMany({ where: { userId } });
  });
  return reply.code(204).send();
});

app.get("/api/notion/status", async () => ({
  configured: !!process.env.NOTION_API_KEY,
}));

// Activity feed — recent items across all categories
app.get("/api/activity", async (request) => {
  const uid = getUserId(request);
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7 days

  const [tasks, notes, reminders, conversations] = await Promise.all([
    prisma.task.findMany({
      where: { userId: uid, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.note.findMany({
      where: { userId: uid, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.reminder.findMany({
      where: { userId: uid, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.conversation.findMany({
      where: { userId: uid, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { _count: { select: { messages: true } } },
    }),
  ]);

  const activity = [
    ...tasks.map((t: { title: string; status: string; createdAt: Date }) => ({
      type: "task" as const,
      title: t.title,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
    })),
    ...notes.map((n: { title: string; createdAt: Date }) => ({
      type: "note" as const,
      title: n.title,
      status: null,
      createdAt: n.createdAt.toISOString(),
    })),
    ...reminders.map((r: { title: string; status: string; createdAt: Date }) => ({
      type: "reminder" as const,
      title: r.title,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
    ...conversations.map(
      (c: { title: string | null; _count: { messages: number }; createdAt: Date }) => ({
        type: "conversation" as const,
        title: c.title || "Chat",
        status: `${c._count.messages} msgs`,
        createdAt: c.createdAt.toISOString(),
      }),
    ),
  ]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 20);

  return { activity };
});

// WebSocket status endpoint (must be before listen)
app.get("/api/ws/status", async () => ({
  connected: getClientCount(),
  connectedByUser: getClientCount("demo-user"),
}));

app.addHook("onClose", async () => {
  await prisma.$disconnect();
});

// --- Server Startup ---
// Startup DB calls are wrapped in withDbRetry so a Neon cold-start (suspended
// compute waking up) does not kill the container. If retries are exhausted we
// exit so Render restarts the process — this is safer than a permanent 503
// fallback that ignores DB recovery.
try {
  await withDbRetry(() => prisma.$queryRaw`SELECT 1`, {
    label: "startup.db_verify",
    maxAttempts: 8,
    baseDelayMs: 500,
  });

  // Ensure demo user exists for unauthenticated access
  await withDbRetry(() => ensureDemoUser(), {
    label: "startup.ensure_demo_user",
    maxAttempts: 8,
    baseDelayMs: 500,
  });

  const port = Number(process.env.PORT) || 3001;
  await app.listen({ port, host: "0.0.0.0" });

  // Attach WebSocket server to the underlying HTTP server
  const httpServer = app.server;
  initWebSocket(httpServer);

  // Emergency kill switch for ALL background LLM-driven loops. Set
  // BACKGROUND_AGENTS_DISABLED=true on Render when prod is bleeding to
  // upstream provider billing — the HTTP server still answers requests,
  // but no scheduler tick fires, no agent loop runs, no LLM call is
  // emitted from this container. Flip it back to false (or unset) after
  // the bleed has stopped and the runaway loop has been identified.
  //
  // Origin: 2026-06-05 Google Cloud billing alert at 150% of budget with
  // no clear single offender — the cost gate only fires for calls that
  // pass `userId`, so any system-call path that omits it is invisible
  // to the cap. Until that gap is closed, this switch is the only
  // bytes-down brake.
  const BG_DISABLED =
    process.env.BACKGROUND_AGENTS_DISABLED === "true" ||
    process.env.BACKGROUND_AGENTS_DISABLED === "1";
  if (BG_DISABLED) {
    console.warn(
      "[STARTUP] BACKGROUND_AGENTS_DISABLED is set — skipping all schedulers and background agents. The HTTP API still serves; no LLM calls from this container.",
    );
  }

  // Start autonomous background agent
  if (!BG_DISABLED) startBackgroundAgent();

  // Start reminder notification scheduler
  if (!BG_DISABLED) {
    import("./reminder-scheduler.js")
      .then(({ startReminderScheduler }) => {
        startReminderScheduler();
      })
      .catch((err) => {
        console.error("[STARTUP] reminder-scheduler failed to start:", err);
        captureError(err, { tags: { context: "startup:reminder-scheduler" } });
      });
  }

  // Start automation scheduler (daily briefing, email classify)
  if (!BG_DISABLED) {
    import("./automation-scheduler.js")
      .then(({ startAutomationScheduler }) => {
        startAutomationScheduler();
      })
      .catch((err) => {
        console.error("[STARTUP] automation-scheduler failed to start:", err);
        captureError(err, { tags: { context: "startup:automation-scheduler" } });
      });
  }

  // Start Naver IMAP polling scheduler (5min interval per connected user)
  if (!BG_DISABLED) {
    import("./naver-imap-scheduler.js")
      .then(({ startNaverImapScheduler }) => {
        startNaverImapScheduler();
      })
      .catch((err) => {
        console.error("[STARTUP] naver-imap-scheduler failed to start:", err);
        captureError(err, { tags: { context: "startup:naver-imap-scheduler" } });
      });
  }

  // Start autonomous LLM reasoning agent
  if (!BG_DISABLED) {
    import("./autonomous-agent-scheduler.js")
      .then(({ startAutonomousAgent }) => {
        startAutonomousAgent();
      })
      .catch((err) => {
        console.error("[STARTUP] autonomous-agent failed to start:", err);
        captureError(err, { tags: { context: "startup:autonomous-agent" } });
      });
  }

  // Start pattern learner (6-hour cycle for learning user behavior patterns)
  if (!BG_DISABLED) {
    import("./pattern-learner.js")
      .then(({ startPatternLearner }) => {
        startPatternLearner();
      })
      .catch((_err) => {});
  }

  // Self-ping to prevent Render free tier from sleeping after 15 min inactivity
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    const KEEP_ALIVE_MS = 10 * 60 * 1000; // every 10 minutes
    setInterval(() => {
      fetch(`${RENDER_URL}/api/health`).catch(() => {});
    }, KEEP_ALIVE_MS);
  }
} catch (_err) {
  // Exit so Render restarts the container. A permanent fallback 503 server
  // would mask DB recovery and require manual redeploy to clear.
  process.exit(1);
}
