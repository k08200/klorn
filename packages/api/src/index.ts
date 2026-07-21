import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import {
  ensureDemoUser,
  getUserId,
  requireAdmin,
  requireAuth,
  revokeDemoAccessIfDisabled,
} from "./auth.js";
import { startBackgroundAgent } from "./background.js";
import { db, INTERACTIVE_TX_OPTIONS, prisma } from "./db.js";
import { withDbRetry } from "./db-retry.js";
import { isDevOrTestEnv } from "./env.js";
import { handleError } from "./error-handler.js";
import { attachPerfMonitor } from "./perf-monitor.js";
import { briefingRoutes } from "./pim/briefing.js";
import { purgeUserData } from "./purge-user-data.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { automationRoutes } from "./routes/automations.js";
import { billingRoutes } from "./routes/billing.js";
import { calendarRoutes } from "./routes/calendar.js";
import { chatConversationRoutes } from "./routes/chat-conversations.js";
import { chatRoutes } from "./routes/chat-pending-actions.js";
import { commitmentRoutes } from "./routes/commitments.js";
import { cronRoutes } from "./routes/cron.js";
import { deviceRoutes } from "./routes/devices.js";
import { diagnosticsRoutes } from "./routes/diagnostics.js";
import { emailRoutes } from "./routes/email.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { firewallRoutes } from "./routes/firewall.js";
import { githubRoutes } from "./routes/github.js";
import { gmailPushRoutes } from "./routes/gmail-push.js";
import { inboxRoutes } from "./routes/inbox.js";
import { memoryRoutes } from "./routes/memory.js";
import { naverImapRoutes } from "./routes/naver-imap.js";
import { notificationRoutes } from "./routes/notifications.js";
import { opsRoutes } from "./routes/ops.js";
import { patternRoutes } from "./routes/patterns.js";
import { phoneRoutes } from "./routes/phone.js";
import { playbookRoutes } from "./routes/playbooks.js";
import { playgroundRoutes } from "./routes/playground.js";
import { receiptRoutes } from "./routes/receipt.js";
import { skillRoutes } from "./routes/skills.js";
import { smsRoutes } from "./routes/sms.js";
import { telegramRoutes } from "./routes/telegram.js";
import { tokenUsageRoutes } from "./routes/token-usage.js";
import { waitlistRoutes } from "./routes/waitlist.js";
import { webhookRoutes } from "./routes/webhook.js";
import { buildSchedulerHealthReport, isBackgroundAgentsDisabled } from "./scheduler-heartbeat.js";
import { captureError, initSentry } from "./sentry.js";
import { getClientCount, initWebSocket } from "./websocket.js";

// Initialize Sentry FIRST so every captureError() across the app actually
// reports. Without this call `initialized` stays false and every captureError
// is a silent no-op — the entire error-observability layer was dead in prod.
// No-op when SENTRY_DSN is unset (local dev).
initSentry();

const app = Fastify({
  // trustProxy: resolve the real client IP from X-Forwarded-For. The platform
  // (Render) sits behind a load balancer, so without this every request's
  // `request.ip` is the LB's internal IP — which collapses all per-IP rate
  // limits (incl. the public /api/playground limit) into one shared bucket.
  trustProxy: true,
  logger: {
    // Defense-in-depth: even though Fastify's default serializer doesn't log
    // bodies, redact key-bearing fields so a future serializer change or a
    // rawBody dump can never leak a credential into the log drain.
    redact: {
      paths: ["req.body.apiKey", "req.body.password", "req.body.token", "req.rawBody"],
      censor: "[REDACTED]",
    },
  },
});

// Attach per-request performance tracking (p50/p95/p99 per route)
attachPerfMonitor(app);

// Global error handler: never reflect a 5xx's raw message to the client
// (Fastify's default does). 4xx pass through; 5xx are logged + generic.
app.setErrorHandler(handleError);

// Security response headers (X-Content-Type-Options: nosniff, HSTS,
// Referrer-Policy, frameguard, etc.). CSP is disabled: this is a JSON API plus
// a couple of static HTML responses, not an app origin that needs a content
// policy — the Next.js web app sets its own CSP. Registered before cors so the
// headers apply to every response.
await app.register(helmet, {
  // The API returns JSON (plus a couple of static HTML pages), so lock the
  // content policy to nothing-loadable and forbid framing outright — a JSON
  // API is never a legitimate frame target. Explicit here because the Google
  // restricted-scope CASA Tier 2 DAST flags a missing CSP / X-Frame-Options
  // on every host it scans (security hardening 2026-07-20).
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
  frameguard: { action: "deny" },
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: "no-referrer" },
});
// Belt-and-suspenders: force the framing/CSP headers on every response even if
// an upstream proxy (Cloudflare/Render) strips helmet's — the DAST scanner sees
// the edge response, so the guarantee must survive the proxy.
app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("X-Frame-Options", "DENY");
  // JSON responses lock to nothing-loadable. The only HTML the API serves is
  // the tiny OAuth "login successful" page, which uses an inline <style> (no
  // scripts, no external loads) — allow inline styles there so it isn't broken,
  // while keeping script-src at 'none' so there is still no XSS surface.
  const contentType = reply.getHeader("content-type");
  const isHtml = typeof contentType === "string" && contentType.includes("text/html");
  reply.header(
    "Content-Security-Policy",
    isHtml
      ? "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"
      : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  // No intermediary or shared-machine browser cache may retain API responses —
  // they carry Gmail-derived content and PII. no-store on every API response
  // (CASA/ASVS V8 data-protection; the API is not a cacheable surface anyway).
  reply.header("Cache-Control", "no-store");
  reply.removeHeader("X-Powered-By");
  return payload;
});

// First-party surfaces that call the API from a browser. Always allowed —
// independent of CORS_ORIGINS — so the public marketing site's login-free
// playground classifier works in production. These are our own domains, so
// permitting them (even with credentials) carries no cross-origin trust risk.
const FIRST_PARTY_ORIGINS = ["https://klorn.ai", "https://www.klorn.ai"];

// The localhost/tauri fallback is a DEV convenience only. On a real deploy with
// CORS_ORIGINS unset we must fail closed to the first-party origins rather than
// silently trusting localhost/tauri with credentials (security audit 2026-07-21,
// CASA hardening) — mirrors the isDevOrTestEnv gate on isAllowedDevOrigin below.
const DEV_ORIGIN_FALLBACK =
  "http://localhost:8001,http://127.0.0.1:8001,http://127.0.2.2:8001,http://127.0.2.3:8001,http://localhost:3000,http://127.0.0.1:3000,tauri://localhost,https://tauri.localhost,http://tauri.localhost";
const ALLOWED_ORIGINS = [
  ...(process.env.CORS_ORIGINS ?? (isDevOrTestEnv() ? DEV_ORIGIN_FALLBACK : ""))
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  ...FIRST_PARTY_ORIGINS,
];

function isAllowedDevOrigin(origin: string): boolean {
  // Only trust localhost origins (CORS with credentials) in dev/test — never on
  // a real deployment where NODE_ENV might be unset/"staging"/a "prod" typo.
  if (!isDevOrTestEnv()) return false;
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
await app.register(chatConversationRoutes, { prefix: "/api/chat" });
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
await app.register(playgroundRoutes, { prefix: "/api/playground" });
await app.register(adminRoutes, { prefix: "/api/admin" });
await app.register(memoryRoutes, { prefix: "/api/memories" });
await app.register(naverImapRoutes, { prefix: "/api/naver-imap" });
await app.register(githubRoutes, { prefix: "/api/github" });
await app.register(patternRoutes, { prefix: "/api/patterns" });
await app.register(tokenUsageRoutes, { prefix: "/api/usage" });
await app.register(skillRoutes, { prefix: "/api/skills" });
await app.register(smsRoutes, { prefix: "/api/sms" });
await app.register(telegramRoutes, { prefix: "/api/telegram" });
await app.register(phoneRoutes, { prefix: "/api/phone" });

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

// Scheduler liveness for external monitors (UptimeRobot etc). 503 when any
// in-process scheduler loop has gone silent past its staleness threshold —
// the failure mode where the dyno slept or an import failed and briefings
// just stopped (see routes/cron.ts). Public like /api/health: exposes only
// scheduler names and tick times, no user data.
app.get("/api/health/schedulers", async (_request, reply) => {
  const report = buildSchedulerHealthReport({ disabled: isBackgroundAgentsDisabled() });
  reply.code(report.statusCode);
  return report.body;
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
  // Exhaustive user-data wipe (keeps the account row). See purge-user-data.ts —
  // the list is CASA/Google "delete my data" critical and regression-tested.
  // Pool-sized maxWait (#845 P2028 class) + a 60s timeout of its own: a full
  // purge of a large account is many deletes and must not die at the 5s
  // interactive default on a compliance-critical endpoint.
  await prisma.$transaction((tx) => purgeUserData(tx as unknown as typeof db, userId), {
    ...INTERACTIVE_TX_OPTIONS,
    timeout: 60_000,
  });
  return reply.code(204).send();
});

app.get("/api/notion/status", async () => ({
  configured: !!process.env.NOTION_API_KEY,
}));

// Activity feed — recent items across all categories. requireAuth (not bare
// getUserId) so the device-session and revocation checks apply like every
// other authed surface, and an invalid token gets a 401 instead of a 500.
app.get("/api/activity", { preHandler: requireAuth }, async (request) => {
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

// WebSocket status endpoint (must be before listen). Ops/debug surface — no
// client consumes it, and connection counts are deployment telemetry, so it
// is admin-gated rather than public. The old unauthenticated version also
// hardcoded a demo-user count (dev leftover).
app.get("/api/ws/status", { preHandler: requireAdmin }, async (request) => ({
  connected: getClientCount(),
  connectedForMe: getClientCount(getUserId(request)),
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

  // Ensure demo user exists for unauthenticated access (no-op unless demo
  // access is explicitly enabled in a non-prod environment).
  await withDbRetry(() => ensureDemoUser(), {
    label: "startup.ensure_demo_user",
    maxAttempts: 8,
    baseDelayMs: 500,
  });

  // In prod, retroactively revoke any demo-user session/JWT seeded by an
  // earlier build (the seeding gate stops new seeds but can't reach a row
  // already in the DB). No-op once revoked.
  await withDbRetry(() => revokeDemoAccessIfDisabled(), {
    label: "startup.revoke_demo_access",
    maxAttempts: 8,
    baseDelayMs: 500,
  });

  // Load approved ontology overrides into the effective-threshold cache BEFORE
  // we accept requests, so no email is classified on base thresholds in the
  // window between listen and cache load. Best-effort: refreshOverrideCache logs
  // + captures and returns false on failure (classifier falls back to base) —
  // surface that here too. Independent of BG_DISABLED — it only reads, and
  // overrides affect on-demand classification too.
  try {
    const { refreshOverrideCache } = await import("./learning/ontology-overrides.js");
    const ok = await refreshOverrideCache();
    if (!ok) {
      console.warn(
        "[STARTUP] ontology override cache loaded with errors — classifier on base thresholds",
      );
    }
  } catch (err) {
    console.warn("[STARTUP] ontology override cache load failed:", err);
  }

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
  const BG_DISABLED = isBackgroundAgentsDisabled();
  if (BG_DISABLED) {
    console.warn(
      "[STARTUP] BACKGROUND_AGENTS_DISABLED is set — skipping all schedulers and background agents. The HTTP API still serves; no LLM calls from this container.",
    );
  }

  // Start autonomous background agent
  if (!BG_DISABLED) startBackgroundAgent();

  // Start reminder notification scheduler
  if (!BG_DISABLED) {
    import("./pim/reminder-scheduler.js")
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
    import("./mail/naver-imap-scheduler.js")
      .then(({ startNaverImapScheduler }) => {
        startNaverImapScheduler();
      })
      .catch((err) => {
        console.error("[STARTUP] naver-imap-scheduler failed to start:", err);
        captureError(err, { tags: { context: "startup:naver-imap-scheduler" } });
      });
  }

  // Start GitHub notifications polling scheduler (5min interval per connected user)
  if (!BG_DISABLED) {
    import("./mail/github-scheduler.js")
      .then(({ startGitHubScheduler }) => {
        startGitHubScheduler();
      })
      .catch((err) => {
        console.error("[STARTUP] github-scheduler failed to start:", err);
        captureError(err, { tags: { context: "startup:github-scheduler" } });
      });
  }

  // Start autonomous LLM reasoning agent
  if (!BG_DISABLED) {
    import("./agentcore/autonomous-agent-scheduler.js")
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
    import("./learning/pattern-learner.js")
      .then(({ startPatternLearner }) => {
        startPatternLearner();
      })
      .catch((_err) => {});
  }

  // Start log retention sweep (6h cycle; no-op + disabled heartbeat report
  // unless LOG_RETENTION_ENABLED is set)
  if (!BG_DISABLED) {
    import("./log-retention.js")
      .then(({ startLogRetentionScheduler }) => {
        startLogRetentionScheduler();
      })
      .catch((err) => {
        console.error("[STARTUP] log-retention failed to start:", err);
        captureError(err, { tags: { context: "startup:log-retention" } });
      });
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

// Graceful shutdown: Render sends SIGTERM on every deploy/restart. Without a
// handler the process dies mid-request; with one we stop accepting new
// connections, let in-flight requests finish, and run the onClose hook
// (Prisma disconnect). Explicit exit is required because the scheduler
// setIntervals would otherwise keep the event loop alive forever, and the
// hard-exit timer covers held-open WebSocket connections (server.close waits
// for them). Anything cut off mid-outbox-execution is reclaimed by the
// stale-IN_PROGRESS sweep on the next boot.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`[SHUTDOWN] ${signal} received — draining connections`);
    const hardExit = setTimeout(() => process.exit(1), 10_000);
    hardExit.unref();
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
