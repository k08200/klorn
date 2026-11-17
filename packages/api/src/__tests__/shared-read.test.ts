/**
 * createSharedRead: concurrent callers of one key share one read in flight;
 * nothing is kept after it settles (success or failure); a read that hangs
 * past maxAgeMs is no longer joined, so it cannot hold every later caller.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSharedRead } from "../shared-read.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSharedRead", () => {
  it("shares one read among concurrent callers of a key, and none across keys", async () => {
    const shared = createSharedRead<string>();
    const read = vi.fn(async () => "value");
    const results = await Promise.all([shared("a", read), shared("a", read), shared("b", read)]);
    expect(results).toEqual(["value", "value", "value"]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps nothing after a read settles: the next caller reads again", async () => {
    const shared = createSharedRead<number>();
    let n = 0;
    const read = async () => ++n;
    expect(await shared("a", read)).toBe(1);
    expect(await shared("a", read)).toBe(2);
  });

  it("rejects every joined caller of a failed read, then reads again", async () => {
    const shared = createSharedRead<string>();
    const first = deferred<string>();
    const read = vi.fn(() => first.promise);
    const a = shared("a", read);
    const b = shared("a", read);
    first.reject(new Error("db down"));
    await expect(a).rejects.toThrow("db down");
    await expect(b).rejects.toThrow("db down");
    expect(await shared("a", async () => "recovered")).toBe("recovered");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("stops joining a read that hangs past maxAgeMs, and keeps the newer one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const shared = createSharedRead<string>(1_000);
    const hung = deferred<string>();
    const stuck = shared("a", () => hung.promise);
    vi.setSystemTime(999);
    expect(shared("a", async () => "unused")).toBe(stuck);
    vi.setSystemTime(1_000);
    const fresh = deferred<string>();
    const next = shared("a", () => fresh.promise);
    expect(next).not.toBe(stuck);
    // The hung read settling late must not drop the newer read's entry.
    hung.resolve("late");
    await stuck;
    expect(shared("a", async () => "unused")).toBe(next);
    fresh.resolve("fresh");
    expect(await next).toBe("fresh");
  });
});
