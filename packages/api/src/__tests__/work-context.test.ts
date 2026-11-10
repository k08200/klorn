import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  newWork,
  PROCESS_STARTED_AT,
  registerWorkContextHook,
  runAsNewWork,
  workStartedAt,
} from "../work-context.js";

// The data-wipe fence rejects a write from work that began before the wipe.
// "When did this work begin" is carried by AsyncLocalStorage: a request, a
// scheduler tick and anything they start (timers, queued LLM calls, promises)
// share one start time.

afterEach(() => {
  vi.useRealTimers();
});

describe("work start time", () => {
  it("is the process start outside any work, the conservative default", () => {
    expect(workStartedAt()).toBe(PROCESS_STARTED_AT);
  });

  it("is the moment runAsNewWork began, inside it and in what it starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T03:00:00Z"));
    const seen = await runAsNewWork(async () => {
      vi.setSystemTime(new Date("2026-10-19T03:05:00Z"));
      const inTimer = await new Promise<Date>((resolve) => {
        setTimeout(() => resolve(workStartedAt()), 10);
        vi.advanceTimersByTime(10);
      });
      return { direct: workStartedAt(), inTimer };
    });
    expect(seen.direct.toISOString()).toBe("2026-10-19T03:00:00.000Z");
    expect(seen.inTimer.toISOString()).toBe("2026-10-19T03:00:00.000Z");
  });

  it("starts a fresh work for every call of a newWork-wrapped tick", () => {
    vi.useFakeTimers();
    const starts: string[] = [];
    const tick = newWork(() => {
      starts.push(workStartedAt().toISOString());
    });
    vi.setSystemTime(new Date("2026-10-19T03:00:00Z"));
    tick();
    vi.setSystemTime(new Date("2026-10-19T03:01:00Z"));
    tick();
    expect(starts).toEqual(["2026-10-19T03:00:00.000Z", "2026-10-19T03:01:00.000Z"]);
  });

  it("gives a nested work its own start and leaves the outer one's alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T03:00:00Z"));
    await runAsNewWork(async () => {
      vi.setSystemTime(new Date("2026-10-19T03:09:00Z"));
      const inner = await runAsNewWork(async () => workStartedAt());
      expect(inner.toISOString()).toBe("2026-10-19T03:09:00.000Z");
      expect(workStartedAt().toISOString()).toBe("2026-10-19T03:00:00.000Z");
    });
  });
});

describe("lazy thenables", () => {
  it("starts a returned thenable inside the work, like a lazy Prisma query", async () => {
    let seenAt: Date | undefined;
    // A Prisma query does nothing until `.then` is called.
    const lazy = {
      // biome-ignore lint/suspicious/noThenProperty: a hand-made thenable is what this test is about.
      then(resolve: (value: Date) => void) {
        seenAt = workStartedAt();
        resolve(seenAt);
      },
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T03:00:00Z"));
    await runAsNewWork(() => lazy);
    expect(seenAt?.toISOString()).toBe("2026-10-19T03:00:00.000Z");
  });
});

describe("the request hook", () => {
  it("gives each request its own start, in the handler, after the body was parsed", async () => {
    const app = Fastify();
    registerWorkContextHook(app);
    app.post("/echo", async () => ({ startedAt: workStartedAt().toISOString() }));
    await app.ready();

    const before = Date.now();
    const res = await app.inject({ method: "POST", url: "/echo", payload: { a: 1 } });
    const startedAt = Date.parse(res.json().startedAt);

    expect(res.statusCode).toBe(200);
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).not.toBe(PROCESS_STARTED_AT.getTime());
    await app.close();
  });

  it("carries the request's start into work the handler leaves running", async () => {
    const app = Fastify();
    registerWorkContextHook(app);
    let detached: Promise<Date> | undefined;
    app.get("/spawn", async () => {
      detached = new Promise((resolve) => setImmediate(() => resolve(workStartedAt())));
      return { startedAt: workStartedAt().toISOString() };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/spawn" });
    const later = await detached;
    expect(later?.toISOString()).toBe(res.json().startedAt);
    await app.close();
  });
});
