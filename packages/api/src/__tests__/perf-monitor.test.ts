import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetPerfStats, attachPerfMonitor, getPerfSnapshot } from "../perf-monitor.js";

describe("perf-monitor", () => {
  beforeEach(() => {
    __resetPerfStats();
  });

  it("records request duration for each route", async () => {
    const app = Fastify();
    attachPerfMonitor(app);
    app.get("/fast", async () => ({ ok: true }));
    app.get("/slow", async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true };
    });

    await app.inject({ method: "GET", url: "/fast" });
    await app.inject({ method: "GET", url: "/slow" });
    await app.inject({ method: "GET", url: "/fast" });

    const snapshot = getPerfSnapshot();
    expect(snapshot.length).toBeGreaterThanOrEqual(2);
    const fast = snapshot.find((r) => r.route.includes("/fast"));
    const slow = snapshot.find((r) => r.route.includes("/slow"));
    expect(fast?.count).toBe(2);
    expect(slow?.count).toBe(1);

    await app.close();
  });

  it("computes p50/p95/p99 percentiles", async () => {
    const app = Fastify();
    attachPerfMonitor(app);
    app.get("/x", async () => ({ ok: true }));

    for (let i = 0; i < 10; i++) {
      await app.inject({ method: "GET", url: "/x" });
    }

    const snapshot = getPerfSnapshot();
    const x = snapshot.find((r) => r.route.includes("/x"));
    expect(x).toBeDefined();
    expect(x?.count).toBe(10);
    expect(x?.p50).toBeGreaterThanOrEqual(0);
    expect(x?.p95).toBeGreaterThanOrEqual(x?.p50 ?? 0);
    expect(x?.p99).toBeGreaterThanOrEqual(x?.p95 ?? 0);
    expect(x?.max).toBeGreaterThanOrEqual(x?.p99 ?? 0);

    await app.close();
  });

  it("tracks errors separately from success count", async () => {
    const app = Fastify();
    attachPerfMonitor(app);
    app.get("/fail", async (_req, reply) => {
      reply.code(500);
      return { error: "boom" };
    });
    app.get("/ok", async () => ({ ok: true }));

    await app.inject({ method: "GET", url: "/fail" });
    await app.inject({ method: "GET", url: "/ok" });

    const snapshot = getPerfSnapshot();
    const fail = snapshot.find((r) => r.route.includes("/fail"));
    const ok = snapshot.find((r) => r.route.includes("/ok"));
    expect(fail?.errorCount).toBe(1);
    expect(ok?.errorCount).toBe(0);

    await app.close();
  });

  it("caps sample history to bound memory", async () => {
    const app = Fastify();
    attachPerfMonitor(app);
    app.get("/many", async () => ({ ok: true }));

    // Send more than MAX_SAMPLES_PER_ROUTE (100) requests
    for (let i = 0; i < 120; i++) {
      await app.inject({ method: "GET", url: "/many" });
    }

    const snapshot = getPerfSnapshot();
    const many = snapshot.find((r) => r.route.includes("/many"));
    expect(many?.count).toBe(100);

    await app.close();
  });

  it("sorts snapshot by p95 descending", async () => {
    const app = Fastify();
    attachPerfMonitor(app);
    app.get("/a", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true };
    });
    app.get("/b", async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true };
    });

    for (let i = 0; i < 5; i++) {
      await app.inject({ method: "GET", url: "/a" });
      await app.inject({ method: "GET", url: "/b" });
    }

    const snapshot = getPerfSnapshot();
    expect(snapshot[0].p95).toBeGreaterThanOrEqual(snapshot[1].p95);

    await app.close();
  });

  // An unmatched request has no route template. Keying it by the raw URL put
  // its query string (tokens, addresses) into /api/admin/perf and the
  // slow-request Sentry breadcrumb, and gave every distinct URL its own
  // never-evicted entry.
  it("files every unmatched request under one key, without its path or query", async () => {
    const app = Fastify();
    attachPerfMonitor(app);
    app.get("/known", async () => ({ ok: true }));

    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "GET",
        url: `/missing-${i}?token=tok-${i}&to=alice%40example.com`,
      });
    }
    await app.inject({ method: "GET", url: "/known?token=tok-known" });

    const snapshot = getPerfSnapshot();
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("tok-");
    expect(text).not.toContain("alice");
    expect(text).not.toContain("/missing-");
    const unmatched = snapshot.filter((r) => !r.route.includes("/known"));
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]?.count).toBe(5);
    expect(snapshot.find((r) => r.route === "GET /known")?.count).toBe(1);

    await app.close();
  });
});
