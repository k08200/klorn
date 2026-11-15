import { CliError, errorMessage } from "../errors.js";

/** The body of GET /api/health (packages/api/src/ops/health-response.ts). */
export interface Health {
  status: "ok" | "degraded";
  db: string;
  timestamp: string;
  uptime: number;
  version: string | null;
  commit: string | null;
}

export interface HealthReading {
  health: Health;
  /** Local clock (ms) when the request left and when the answer arrived — for skew. */
  sentAtMs: number;
  receivedAtMs: number;
}

export interface PollDeps {
  fetch: typeof fetch;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
}

const REQUEST_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 2_000;

const isNullableString = (v: unknown) => v === null || typeof v === "string";

export function parseHealth(body: unknown): Health | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.status !== "ok" && b.status !== "degraded") return null;
  if (typeof b.db !== "string" || typeof b.timestamp !== "string") return null;
  if (typeof b.uptime !== "number" || !isNullableString(b.version) || !isNullableString(b.commit)) {
    return null;
  }
  return {
    status: b.status,
    db: b.db,
    timestamp: b.timestamp,
    uptime: b.uptime,
    version: (b.version as string | null) ?? null,
    commit: (b.commit as string | null) ?? null,
  };
}

export function healthUrl(apiUrl: string): string {
  return new URL("/api/health", apiUrl).href;
}

export async function fetchHealth(
  fetchFn: typeof fetch,
  apiUrl: string,
  nowMs: () => number = Date.now,
): Promise<HealthReading> {
  const url = healthUrl(apiUrl);
  const sentAtMs = nowMs();
  let response: Response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new CliError(`API unreachable at ${url} (${errorMessage(err)})`);
  }
  const receivedAtMs = nowMs();
  if (!response.ok) throw new CliError(`API answered HTTP ${response.status} at ${url}`);
  const health = parseHealth(await response.json().catch(() => null));
  if (!health) throw new CliError(`${url} is not a Klorn API (no health body)`);
  return { health, sentAtMs, receivedAtMs };
}

export function describeHealth(h: Health): string {
  return `${h.status}, db ${h.db}, version ${h.version ?? "unknown"}, commit ${h.commit ?? "unset"}`;
}

/** Poll /api/health until `accept` says yes, or throw with the last observation. */
export async function pollHealth(
  deps: PollDeps,
  apiUrl: string,
  accept: (h: Health) => boolean,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<Health> {
  const deadline = deps.nowMs() + opts.timeoutMs;
  let last = "no answer yet";
  for (;;) {
    try {
      const { health } = await fetchHealth(deps.fetch, apiUrl, deps.nowMs);
      if (accept(health)) return health;
      last = describeHealth(health);
    } catch (err) {
      last = errorMessage(err);
    }
    if (deps.nowMs() >= deadline) {
      throw new CliError(
        `gave up waiting for the API after ${opts.timeoutMs / 1000}s; last: ${last}`,
      );
    }
    await deps.sleep(opts.intervalMs ?? POLL_INTERVAL_MS);
  }
}
