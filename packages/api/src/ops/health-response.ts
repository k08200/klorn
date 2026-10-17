/**
 * The /api/health answer. It probes the database and used to answer 200 either
 * way, so nothing that reads the status code (the keepalive and prod-lag
 * workflows call it with `curl -f`) noticed a database outage. A failed probe
 * now answers 503 with the same JSON fields, so tools that read the commit
 * still can. Render has no healthCheckPath configured, so this never restarts
 * the service.
 */

export interface HealthMeta {
  version: string | null;
  commit: string | null;
  now: Date;
  uptimeSeconds: number;
}

export interface HealthBody {
  status: "ok" | "degraded";
  db: "connected" | "unreachable";
  timestamp: string;
  uptime: number;
  version: string | null;
  commit: string | null;
}

export async function healthResponse(
  probeDb: () => Promise<unknown>,
  meta: HealthMeta,
): Promise<{ statusCode: 200 | 503; body: HealthBody }> {
  let dbOk = false;
  try {
    await probeDb();
    dbOk = true;
  } catch {
    // Unreachable: the body says so, never the error text.
  }
  return {
    statusCode: dbOk ? 200 : 503,
    body: {
      status: dbOk ? "ok" : "degraded",
      db: dbOk ? "connected" : "unreachable",
      timestamp: meta.now.toISOString(),
      uptime: meta.uptimeSeconds,
      version: meta.version,
      commit: meta.commit,
    },
  };
}
