/**
 * The answer of the two health endpoints, which share one database probe.
 *
 *   - `/api/health` is liveness: 200 while the process serves requests, with
 *     the probe's result in the body (`db`). A platform health check pointed at
 *     it (Render's dashboard can set one, render.yaml sets none) never restarts
 *     a healthy process over a database blip, and the web app's offline screen
 *     reads `db` from the body.
 *   - `/api/health/ready` is readiness: 503 while the probe fails, so a monitor
 *     that reads the status code (`curl -f` in the keepalive workflow) sees a
 *     database outage that liveness reports only in its body.
 *
 * The probe is bounded: a stuck pool or query reads as unreachable after
 * HEALTH_DB_PROBE_TIMEOUT_MS, short enough for a platform check's own timeout,
 * instead of holding the request open.
 */

export const HEALTH_DB_PROBE_TIMEOUT_MS = 3_000;

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
): Promise<{ ready: boolean; body: HealthBody }> {
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("db probe timed out")), HEALTH_DB_PROBE_TIMEOUT_MS);
  });
  try {
    await Promise.race([probeDb(), timedOut]);
    ready = true;
  } catch {
    // Unreachable or too slow: the body says so, never the error text.
  } finally {
    clearTimeout(timer);
  }
  return {
    ready,
    body: {
      status: ready ? "ok" : "degraded",
      db: ready ? "connected" : "unreachable",
      timestamp: meta.now.toISOString(),
      uptime: meta.uptimeSeconds,
      version: meta.version,
      commit: meta.commit,
    },
  };
}
