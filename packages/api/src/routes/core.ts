import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAdmin, requireAuth } from "../auth.js";
import { db, prisma } from "../db.js";
import { exportDriveFiles } from "../drive/drive-export.js";
import { getPublicJudgeHealth, type PublicJudgeHealth } from "../judge/judge-fallback-check.js";
import { healthResponse } from "../ops/health-response.js";
import { buildSchedulerHealthReport, isBackgroundAgentsDisabled } from "../scheduler-heartbeat.js";
import { purgeAllUserData } from "../user-deletion.js";
import { getClientCount } from "../websocket.js";

// Version is read once at startup from package.json on disk — keeps the
// string in lockstep with the published artifact without a separate
// manifest to forget about. Read sync at module load so /api/health is
// answer-ready the moment the listener binds.
const PKG_VERSION: string | null = (() => {
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const raw = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
})();

function probeHealth() {
  return healthResponse(() => prisma.$queryRaw`SELECT 1`, {
    version: PKG_VERSION ?? null,
    commit:
      process.env.RENDER_GIT_COMMIT ||
      process.env.GIT_COMMIT_SHA ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      null,
    now: new Date(),
    uptimeSeconds: Math.floor(process.uptime()),
  });
}

// A wipe is heavy (long transactions) and never needs repeating quickly.
const WIPE_DATA_ROUTE = {
  preHandler: requireAuth,
  config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
};

/**
 * The routes index.ts used to declare inline: health probes, the "me" data
 * export/wipe, the activity feed and the WebSocket status. Registered on the
 * root instance (no prefix) by registerApiRoutes, after the route-auth guard.
 */
export function registerCoreRoutes(app: FastifyInstance): void {
  // Liveness: 200 while the process serves requests; `db` in the body says
  // whether the database answered. See ops/health-response.ts.
  app.get("/api/health", async (_request, reply) => {
    const { body } = await probeHealth();
    return reply.code(200).send(body);
  });

  // Readiness: 503 while the database probe fails, for status-code monitors.
  app.get("/api/health/ready", async (_request, reply) => {
    const { ready, body } = await probeHealth();
    return reply.code(ready ? 200 : 503).send(body);
  });

  // Scheduler liveness for external monitors (UptimeRobot etc). 503 when any
  // in-process scheduler loop has gone silent past its staleness threshold —
  // the failure mode where the dyno slept or an import failed and briefings
  // just stopped (see routes/cron.ts). Public like /api/health: exposes only
  // scheduler names and tick times, no user data — plus the LLM judge's coarse
  // fallback status + ratio (#1572), never error text.
  app.get("/api/health/schedulers", async (_request, reply) => {
    // The judge read is a cached in-memory value, but it must never turn the
    // liveness endpoint into a 500: on any throw the field is simply omitted.
    let judge: PublicJudgeHealth | undefined;
    try {
      judge = getPublicJudgeHealth();
    } catch (err) {
      console.warn("[JUDGE-HEALTH] public judge health read failed:", err);
    }
    const report = buildSchedulerHealthReport({ disabled: isBackgroundAgentsDisabled(), judge });
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
      driveFiles,
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
      exportDriveFiles(userId),
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
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
      driveFiles,
      notifications,
      automationConfig,
      agentLogs,
      exportedAt: new Date().toISOString(),
    };
  });

  app.delete("/api/user/me/data", WIPE_DATA_ROUTE, async (request, reply) => {
    const userId = getUserId(request);
    // Exhaustive user-data wipe (keeps the account row), fenced against work
    // already running for the user. See user-deletion.ts. 202: access is gone and
    // the purge did not commit yet; the data-wipe sweep finishes it.
    const outcome = await purgeAllUserData(userId);
    return outcome === "purged"
      ? reply.code(204).send()
      : reply.code(202).send({ status: "pending" });
  });

  // Session-guarded like every non-exempt route (security/route-auth-guard.ts):
  // only the signed-in settings page reads it, so it need not be public.
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
}
