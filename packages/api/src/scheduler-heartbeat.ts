/**
 * Scheduler heartbeat registry.
 *
 * Every in-process scheduler (setInterval loop) registers here on start and
 * records a tick each time its loop fires. `GET /api/health/schedulers`
 * surfaces the registry so an external uptime monitor can alert when a loop
 * goes silent — the failure mode this closes is "the dyno slept / the import
 * failed / the event loop wedged and nobody noticed until a briefing was
 * missed" (see routes/cron.ts for the documented dogfood incident).
 *
 * Registration counts as the first heartbeat: most schedulers delay their
 * first tick (30s for naver-imap/github/autonomous-agent, 5min for
 * pattern-learner), so a boot must start in a healthy state.
 */

/**
 * Names every scheduler that index.ts starts when BACKGROUND_AGENTS_DISABLED
 * is off. An expected name that never registers is reported as missing —
 * this is the only external signal when a dynamic import fails at startup
 * (pattern-learner's failure is otherwise swallowed).
 */
export const EXPECTED_SCHEDULERS = [
  "background-agent",
  "reminder",
  "automation",
  "naver-imap",
  "github",
  "autonomous-agent",
  "pattern-learner",
  "log-retention",
] as const;

export type SchedulerName = (typeof EXPECTED_SCHEDULERS)[number];

/**
 * A scheduler is stale after 3 missed intervals, but never sooner than 120s:
 * 3x the reminder scheduler's 30s interval is 90s, which a deploy restart or
 * a long event-loop pause would trip — the floor keeps one-off hiccups from
 * paging while still catching a genuinely dead loop within minutes.
 */
const MIN_STALE_THRESHOLD_MS = 120_000;

/**
 * Missing schedulers do not fail the health check while the process is this
 * young — index.ts starts schedulers via dynamic imports after listen(), so
 * there is a legitimate window where the registry is still filling in.
 */
const STARTUP_GRACE_MS = 120_000;

interface SchedulerState {
  intervalMs: number;
  lastSeenAt: number;
  disabled: boolean;
}

export interface SchedulerHealthEntry {
  name: string;
  intervalMs: number;
  lastSeenAt: number;
  staleAfterMs: number;
  stale: boolean;
  disabled: boolean;
}

export interface SchedulerHealth {
  ok: boolean;
  inStartupGrace: boolean;
  schedulers: SchedulerHealthEntry[];
  missing: string[];
}

const registry = new Map<string, SchedulerState>();

export function registerScheduler(name: SchedulerName, intervalMs: number, now = Date.now()): void {
  registry.set(name, { intervalMs, lastSeenAt: now, disabled: false });
}

/**
 * Mark a scheduler as off by design (e.g. autonomous-agent when no LLM is
 * configured on a self-hosted install). It shows up in the report but is
 * never stale and never missing — the alternative is a permanent false alarm.
 */
export function markSchedulerDisabled(name: SchedulerName, now = Date.now()): void {
  registry.set(name, { intervalMs: 0, lastSeenAt: now, disabled: true });
}

/** No-op for unregistered names: a tick without a registration is a bug in
 *  the scheduler's start function, and inventing an interval here would just
 *  mask it with a made-up staleness threshold. */
export function recordSchedulerTick(name: SchedulerName, now = Date.now()): void {
  const state = registry.get(name);
  if (!state) return;
  registry.set(name, { ...state, lastSeenAt: now });
}

export function getSchedulerHealth(
  opts: { now?: number; uptimeMs?: number } = {},
): SchedulerHealth {
  const now = opts.now ?? Date.now();
  const uptimeMs = opts.uptimeMs ?? process.uptime() * 1000;
  const inStartupGrace = uptimeMs < STARTUP_GRACE_MS;

  const schedulers = [...registry.entries()].map(([name, state]): SchedulerHealthEntry => {
    const staleAfterMs = Math.max(3 * state.intervalMs, MIN_STALE_THRESHOLD_MS);
    return {
      name,
      intervalMs: state.intervalMs,
      lastSeenAt: state.lastSeenAt,
      staleAfterMs,
      stale: !state.disabled && now - state.lastSeenAt > staleAfterMs,
      disabled: state.disabled,
    };
  });

  const missing = EXPECTED_SCHEDULERS.filter((name) => !registry.has(name));
  const ok = schedulers.every((s) => !s.stale) && (missing.length === 0 || inStartupGrace);

  return { ok, inStartupGrace, schedulers, missing };
}

/** Test helper — the registry is module-level state. */
export function resetSchedulerHeartbeats(): void {
  registry.clear();
}

export interface SchedulerHealthReport {
  statusCode: 200 | 503;
  body: {
    status: "ok" | "stale" | "disabled";
    inStartupGrace?: boolean;
    schedulers?: SchedulerHealthEntry[];
    missing?: string[];
  };
}

/**
 * Response builder for GET /api/health/schedulers, kept here so it is
 * unit-testable — index.ts starts listening at import time and cannot be
 * loaded in a test.
 */
export function buildSchedulerHealthReport(opts: {
  disabled: boolean;
  now?: number;
  uptimeMs?: number;
}): SchedulerHealthReport {
  if (opts.disabled) {
    return { statusCode: 200, body: { status: "disabled" } };
  }
  const health = getSchedulerHealth({ now: opts.now, uptimeMs: opts.uptimeMs });
  return {
    statusCode: health.ok ? 200 : 503,
    body: {
      status: health.ok ? "ok" : "stale",
      inStartupGrace: health.inStartupGrace,
      schedulers: health.schedulers,
      missing: health.missing,
    },
  };
}

/** Shared BACKGROUND_AGENTS_DISABLED check (same semantics as index.ts). */
export function isBackgroundAgentsDisabled(): boolean {
  return (
    process.env.BACKGROUND_AGENTS_DISABLED === "true" ||
    process.env.BACKGROUND_AGENTS_DISABLED === "1"
  );
}
