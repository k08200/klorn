/**
 * Step B4 review fix: a generic host that keeps failing without rejecting the login
 * (stalling, refusing, a certificate that does not verify, a name that turned private)
 * costs up to ~105 s of a serial tick every five minutes, and a user can hold three
 * such accounts. Failures now back the account off: an exponential, bounded delay,
 * in memory, per account, cleared by a successful poll or a relink.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPollBackoff,
  isPollBackedOff,
  MAX_TRACKED_POLL_BACKOFFS,
  notePollBackoff,
  POLL_BACKOFF_BASE_MS,
  POLL_BACKOFF_MAX_MS,
  pollBackoffMs,
  resetPollBackoffState,
} from "../mail/imap-poll-backoff.js";

const MINUTE = 60_000;
const T0 = 1_800_000_000_000;

beforeEach(() => {
  resetPollBackoffState();
});

describe("the named limits", () => {
  it("start at ten minutes (two poll intervals) and stop at six hours", () => {
    expect(POLL_BACKOFF_BASE_MS).toBe(10 * MINUTE);
    expect(POLL_BACKOFF_MAX_MS).toBe(6 * 60 * MINUTE);
  });
});

describe("pollBackoffMs", () => {
  it.each([
    [1, 10 * MINUTE],
    [2, 20 * MINUTE],
    [3, 40 * MINUTE],
    [4, 80 * MINUTE],
    [5, 160 * MINUTE],
    [6, 320 * MINUTE],
    [7, 360 * MINUTE],
    [40, 360 * MINUTE],
    [10_000, 360 * MINUTE],
  ])("after %i consecutive failure(s): %i ms", (failures, ms) => {
    expect(pollBackoffMs(failures)).toBe(ms);
  });

  it.each([0, -1, Number.NaN])("never goes below the base for %s", (failures) => {
    expect(pollBackoffMs(failures)).toBe(POLL_BACKOFF_BASE_MS);
  });
});

describe("isPollBackedOff / notePollBackoff", () => {
  it("an account that never failed is not backed off", () => {
    expect(isPollBackedOff("row-1", T0)).toBe(false);
  });

  it("is backed off from the failure until the delay has passed, to the millisecond", () => {
    notePollBackoff("row-1", T0);
    expect(isPollBackedOff("row-1", T0)).toBe(true);
    expect(isPollBackedOff("row-1", T0 + 10 * MINUTE - 1)).toBe(true);
    expect(isPollBackedOff("row-1", T0 + 10 * MINUTE)).toBe(false);
  });

  it("each consecutive failure doubles the delay, and the count survives the delay passing", () => {
    expect(notePollBackoff("row-1", T0)).toBe(10 * MINUTE);
    // The delay has passed; the next poll fails again.
    expect(notePollBackoff("row-1", T0 + 10 * MINUTE)).toBe(20 * MINUTE);
    expect(isPollBackedOff("row-1", T0 + 10 * MINUTE + 20 * MINUTE - 1)).toBe(true);
    expect(isPollBackedOff("row-1", T0 + 10 * MINUTE + 20 * MINUTE)).toBe(false);
    expect(notePollBackoff("row-1", T0 + 30 * MINUTE)).toBe(40 * MINUTE);
  });

  it("is capped, however long it keeps failing", () => {
    let delay = 0;
    for (let i = 0; i < 30; i++) delay = notePollBackoff("row-1", T0 + i * POLL_BACKOFF_MAX_MS);
    expect(delay).toBe(POLL_BACKOFF_MAX_MS);
  });

  it("counts each account on its own", () => {
    notePollBackoff("row-1", T0);
    notePollBackoff("row-1", T0 + 10 * MINUTE);
    expect(notePollBackoff("row-2", T0)).toBe(10 * MINUTE);
    expect(isPollBackedOff("row-2", T0 + 10 * MINUTE)).toBe(false);
  });
});

describe("clearPollBackoff: a success or a relink starts over", () => {
  it("makes the account pollable at once, and the next failure is the first again", () => {
    notePollBackoff("row-1", T0);
    notePollBackoff("row-1", T0 + 10 * MINUTE);
    clearPollBackoff("row-1");
    expect(isPollBackedOff("row-1", T0 + 10 * MINUTE)).toBe(false);
    expect(notePollBackoff("row-1", T0 + 11 * MINUTE)).toBe(10 * MINUTE);
  });

  it("is harmless for an account that never failed", () => {
    expect(() => clearPollBackoff("never")).not.toThrow();
  });
});

describe("memory is bounded", () => {
  it("past the cap the oldest account is forgotten (it is simply polled again)", () => {
    for (let i = 0; i < MAX_TRACKED_POLL_BACKOFFS + 5; i++) notePollBackoff(`row-${i}`, T0);
    expect(isPollBackedOff("row-0", T0)).toBe(false); // evicted
    expect(isPollBackedOff(`row-${MAX_TRACKED_POLL_BACKOFFS + 4}`, T0)).toBe(true); // kept
  });
});
