/**
 * Performance Monitoring — Fastify request duration tracking.
 *
 * Records per-route latency in-memory and exposes aggregated metrics
 * via /api/admin/perf. Slow requests (>1000ms) are logged for triage.
 *
 * Keeps a rolling window of the last N samples per route to bound memory.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { addBreadcrumb, captureError } from "./sentry.js";

const SLOW_THRESHOLD_MS = 1000;
const MAX_SAMPLES_PER_ROUTE = 100;
/**
 * The key for a request no route matched. Its URL would carry the query string
 * (tokens, addresses) into /api/admin/perf and the slow-request breadcrumb, and
 * a key per distinct URL would grow `stats` without bound.
 */
const UNMATCHED_ROUTE = "(unmatched)";

interface RouteStats {
  samples: number[];
  errorCount: number;
}

const stats = new Map<string, RouteStats>();

function record(routeKey: string, durationMs: number, isError: boolean): void {
  let entry = stats.get(routeKey);
  if (!entry) {
    entry = { samples: [], errorCount: 0 };
    stats.set(routeKey, entry);
  }
  entry.samples.push(durationMs);
  if (entry.samples.length > MAX_SAMPLES_PER_ROUTE) {
    entry.samples.shift();
  }
  if (isError) entry.errorCount++;
}

/** Register Fastify hooks to track request duration */
export function attachPerfMonitor(app: FastifyInstance): void {
  app.addHook("onRequest", async (request: FastifyRequest) => {
    (request as unknown as { _perfStart: number })._perfStart = Date.now();
  });

  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    const start = (request as unknown as { _perfStart?: number })._perfStart;
    if (!start) return;
    const duration = Date.now() - start;
    const routeKey = `${request.method} ${request.routeOptions?.url || UNMATCHED_ROUTE}`;
    const isError = reply.statusCode >= 500;
    record(routeKey, duration, isError);

    if (duration > SLOW_THRESHOLD_MS) {
      addBreadcrumb("perf", `Slow request: ${routeKey} took ${duration}ms`, {
        duration,
        statusCode: reply.statusCode,
      });
      // Only Sentry-capture if it's both slow AND errored
      if (isError) {
        captureError(new Error(`Slow failing request: ${routeKey} (${duration}ms)`), {
          tags: { perf: "slow-error", route: routeKey },
          extra: { duration, statusCode: reply.statusCode },
        });
      }
    }
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

export interface RouteMetric {
  route: string;
  count: number;
  errorCount: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function getPerfSnapshot(): RouteMetric[] {
  const result: RouteMetric[] = [];
  for (const [route, entry] of stats.entries()) {
    if (entry.samples.length === 0) continue;
    const sorted = [...entry.samples].sort((a, b) => a - b);
    result.push({
      route,
      count: sorted.length,
      errorCount: entry.errorCount,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1],
    });
  }
  // Sort by p95 descending so slowest routes surface first
  return result.sort((a, b) => b.p95 - a.p95);
}

/** Test-only helper to clear the in-memory state */
export function __resetPerfStats(): void {
  stats.clear();
}
