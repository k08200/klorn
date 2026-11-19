/**
 * The shared per-address window (login, register, password reset). Its map is
 * capped, and a flood of new addresses keeps it at the cap: the cost of one
 * new key there has to stay constant, not grow with the cap (the API runs on
 * one 0.1-CPU instance). Measured as walks over the map and windows examined,
 * never as wall time. A walk starts at the Map's front, where V8 also skips the
 * slots of deleted entries, so walks are counted on their own: one walk per
 * new key at the cap would cost up to the map's capacity each time even when
 * it examines a single window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountWindowThrottle } from "../security/account-window-throttle.js";

const WINDOW_MS = 15 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-18T09:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createAccountWindowThrottle — cost at the cap", () => {
  it("examines a constant number of windows per new key while a flood holds the map full", () => {
    const cap = 1_000;
    const flood = 1_000;
    const throttle = createAccountWindowThrottle({
      maxAttempts: 5,
      windowMs: WINDOW_MS,
      maxTracked: cap,
    });

    for (let i = 0; i < cap + flood; i++) throttle.record(`flood-${i}@example.com`);

    expect(throttle.trackedCount()).toBeLessThanOrEqual(cap);
    // A full scan per insert at the cap would be ~cap × flood (a million here).
    expect(throttle.sweepVisitsForTests()).toBeLessThanOrEqual(3 * (cap + flood));
    // One walk makes room for many new keys, not one.
    expect(throttle.sweepPassesForTests()).toBeLessThanOrEqual(flood / 10);
  });

  it("drops expired windows without a full scan per insert", () => {
    const cap = 1_000;
    const throttle = createAccountWindowThrottle({
      maxAttempts: 5,
      windowMs: WINDOW_MS,
      maxTracked: cap,
    });
    for (let i = 0; i < cap; i++) throttle.record(`old-${i}@example.com`);
    vi.advanceTimersByTime(WINDOW_MS);
    const before = throttle.sweepVisitsForTests();

    for (let i = 0; i < cap; i++) throttle.record(`new-${i}@example.com`);

    // Every expired window is examined once, when it is dropped.
    expect(throttle.trackedCount()).toBe(cap);
    expect(throttle.sweepVisitsForTests() - before).toBeLessThanOrEqual(3 * cap);
    expect(throttle.sweepPassesForTests()).toBe(1);
    expect(throttle.remainingMs("old-0@example.com")).toBe(0);
  });
});

describe("createAccountWindowThrottle — limits and order", () => {
  it("locks a key at maxAttempts and frees it when its window ends", () => {
    const throttle = createAccountWindowThrottle({
      maxAttempts: 2,
      windowMs: WINDOW_MS,
      maxTracked: 10,
    });
    throttle.record("a@example.com");
    expect(throttle.remainingMs("a@example.com")).toBe(0);
    throttle.record("a@example.com");
    expect(throttle.remainingMs("a@example.com")).toBe(WINDOW_MS);
    vi.advanceTimersByTime(WINDOW_MS);
    expect(throttle.remainingMs("a@example.com")).toBe(0);
  });

  it("evicts the window that started first, not the key that was inserted first", () => {
    const throttle = createAccountWindowThrottle({
      maxAttempts: 1,
      windowMs: WINDOW_MS,
      maxTracked: 4,
    });
    throttle.record("a@example.com");
    vi.advanceTimersByTime(WINDOW_MS / 2);
    throttle.record("b@example.com");
    throttle.record("c@example.com");
    vi.advanceTimersByTime(WINDOW_MS / 2);
    // a's window ended; this attempt starts a new one, the newest so far. The
    // map is under its cap, so nothing is swept here.
    throttle.record("a@example.com");
    throttle.record("d@example.com");

    // At the cap with nothing expired: one window has to go.
    throttle.record("e@example.com");

    expect(throttle.trackedCount()).toBe(4);
    expect(throttle.remainingMs("a@example.com")).toBe(WINDOW_MS);
    expect(throttle.remainingMs("b@example.com")).toBe(0);
    expect(throttle.remainingMs("c@example.com")).toBe(WINDOW_MS / 2);
    expect(throttle.remainingMs("d@example.com")).toBe(WINDOW_MS);
    expect(throttle.remainingMs("e@example.com")).toBe(WINDOW_MS);
  });

  it("walks the map only when a new window finds it full", () => {
    const throttle = createAccountWindowThrottle({
      maxAttempts: 5,
      windowMs: WINDOW_MS,
      maxTracked: 100,
    });
    for (let i = 0; i < 100; i++) throttle.record(`k-${i}@example.com`);
    for (let i = 0; i < 100; i++) throttle.record(`k-${i}@example.com`);
    expect(throttle.sweepPassesForTests()).toBe(0);
  });

  it("drops a key's own expired window before evicting a live one at the cap", () => {
    const throttle = createAccountWindowThrottle({
      maxAttempts: 1,
      windowMs: WINDOW_MS,
      maxTracked: 2,
    });
    throttle.record("a@example.com");
    vi.advanceTimersByTime(WINDOW_MS / 2);
    throttle.record("b@example.com");
    vi.advanceTimersByTime(WINDOW_MS / 2);

    throttle.record("a@example.com");

    expect(throttle.remainingMs("a@example.com")).toBe(WINDOW_MS);
    expect(throttle.remainingMs("b@example.com")).toBe(WINDOW_MS / 2);
  });

  it("keeps counting inside a window without moving the key", () => {
    const throttle = createAccountWindowThrottle({
      maxAttempts: 3,
      windowMs: WINDOW_MS,
      maxTracked: 2,
    });
    throttle.record("a@example.com");
    throttle.record("b@example.com");
    throttle.record("a@example.com");

    // a's window is still the older one, so it goes first.
    throttle.record("c@example.com");

    expect(throttle.remainingMs("a@example.com")).toBe(0);
    throttle.record("b@example.com");
    throttle.record("b@example.com");
    expect(throttle.remainingMs("b@example.com")).toBe(WINDOW_MS);
  });

  it("clear forgets a key", () => {
    const throttle = createAccountWindowThrottle({
      maxAttempts: 1,
      windowMs: WINDOW_MS,
      maxTracked: 10,
    });
    throttle.record("a@example.com");
    throttle.clear("a@example.com");
    expect(throttle.remainingMs("a@example.com")).toBe(0);
    expect(throttle.trackedCount()).toBe(0);
  });
});
