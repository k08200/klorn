/**
 * Per-key single flight with one trailing re-run: a Gmail push that lands
 * while that inbox is already syncing must not start a second concurrent sync
 * (each push used to start its own), but it must not be lost either — the
 * sync that is running may have read the mailbox before the new mail arrived.
 */

import { describe, expect, it, vi } from "vitest";
import { createSingleFlight } from "../mail/sync-single-flight.js";

const gate = () => {
  let open: () => void = () => {};
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
};

describe("createSingleFlight", () => {
  it("runs the first call for a key at once", async () => {
    const flight = createSingleFlight<number>();
    expect(await flight.run("u1", async () => 7)).toBe(7);
  });

  it("never runs two calls for the same key at the same time", async () => {
    const flight = createSingleFlight<void>();
    let running = 0;
    let peak = 0;
    const g = gate();
    const job = async () => {
      running++;
      peak = Math.max(peak, running);
      await g.p;
      running--;
    };
    const calls = [flight.run("u1", job), flight.run("u1", job), flight.run("u1", job)];
    g.open();
    await Promise.all(calls);
    expect(peak).toBe(1);
  });

  it("folds every call made during a run into one trailing re-run", async () => {
    const flight = createSingleFlight<number>();
    let runs = 0;
    const g = gate();
    const job = async () => {
      runs++;
      if (runs === 1) await g.p;
      return runs;
    };
    const first = flight.run("u1", job);
    const second = flight.run("u1", job);
    const third = flight.run("u1", job);
    g.open();

    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(await third).toBe(2);
    expect(runs).toBe(2);
  });

  it("keeps keys independent", async () => {
    const flight = createSingleFlight<string>();
    const g = gate();
    const slow = flight.run("u1", async () => {
      await g.p;
      return "u1";
    });
    expect(await flight.run("u2", async () => "u2")).toBe("u2");
    g.open();
    expect(await slow).toBe("u1");
  });

  it("still re-runs after a failed run, and a later call starts fresh", async () => {
    const flight = createSingleFlight<string>();
    const g = gate();
    const failing = flight.run("u1", async () => {
      await g.p;
      throw new Error("sync failed");
    });
    const trailing = flight.run("u1", async () => "recovered");
    g.open();

    await expect(failing).rejects.toThrow("sync failed");
    expect(await trailing).toBe("recovered");
    expect(await flight.run("u1", async () => "fresh")).toBe("fresh");
  });

  it("the trailing re-run uses the latest caller's function", async () => {
    const flight = createSingleFlight<string>();
    const g = gate();
    const first = flight.run("u1", async () => {
      await g.p;
      return "first";
    });
    const older = flight.run("u1", async () => "older");
    const latest = flight.run("u1", async () => "latest");
    g.open();

    expect(await first).toBe("first");
    expect(await older).toBe("latest");
    expect(await latest).toBe("latest");
  });

  it("a run stuck past the stale limit no longer blocks new runs, and cannot clear them", async () => {
    vi.useFakeTimers();
    try {
      const flight = createSingleFlight<string>({ staleAfterMs: 60_000 });
      const stuck = gate();
      const hung = flight.run("u1", async () => {
        await stuck.p;
        return "hung";
      });
      await vi.advanceTimersByTimeAsync(60_001);

      const fresh = gate();
      let freshStarted = false;
      const replacement = flight.run("u1", async () => {
        freshStarted = true;
        await fresh.p;
        return "fresh";
      });
      expect(freshStarted).toBe(true);

      // The hung run finally settles: the replacement must still count as running.
      stuck.open();
      expect(await hung).toBe("hung");
      let joinedRan = false;
      const joined = flight.run("u1", async () => {
        joinedRan = true;
        return "joined";
      });
      expect(joinedRan).toBe(false);

      fresh.open();
      expect(await replacement).toBe("fresh");
      expect(await joined).toBe("joined");
    } finally {
      vi.useRealTimers();
    }
  });
});
