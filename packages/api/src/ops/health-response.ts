/**
 * The /api/health answer. It probes the database and used to answer 200 either
 * way, so nothing that reads the status code (the keepalive and prod-lag
 * workflows call it with `curl -f`) noticed a database outage. A failed probe
 * now answers 503 with the same JSON fields, so tools that read the body
 * without `-f` still get the commit. render.yaml sets no healthCheckPath (check
 * the Render dashboard matches before relying on that). The probe is bounded: a
 * stuck pool or query reads as unreachable after HEALTH_DB_PROBE_TIMEOUT_MS
 * instead of holding the request open.
 */

export const HEALTH_DB_PROBE_TIMEOUT_MS = 5_000;

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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("db probe timed out")), HEALTH_DB_PROBE_TIMEOUT_MS);
  });
  try {
    await Promise.race([probeDb(), timedOut]);
    dbOk = true;
  } catch {
    // Unreachable or too slow: the body says so, never the error text.
  } finally {
    clearTimeout(timer);
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
