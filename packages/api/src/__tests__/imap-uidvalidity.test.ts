/**
 * UIDVALIDITY (RFC 3501 §2.3.1.1) is what makes a stored UID mean anything: a
 * mailbox whose value changed renumbers its messages, so a UID kept from before
 * addresses a different message (or none). Step B2 of
 * docs/providers/unified-platform-plan.md compares the live value with the one
 * the poller stored before any action touches a UID.
 *
 * These pin the pure rules: what counts as a valid value, how a stored and a live
 * value compare, how the poller classifies a cycle, and that a refusal is logged
 * once per change rather than once per call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalUidValidity,
  classifyPollValidity,
  compareUidValidity,
  liveUidValidity,
  logValidityRefusalOnce,
  MAX_UID_VALIDITY,
  resetUidValidityLogState,
  validityFailure,
} from "../mail/imap-uidvalidity.js";

describe("canonicalUidValidity", () => {
  it("renders a bigint (imapflow's type) as canonical decimal", () => {
    expect(canonicalUidValidity(1n)).toBe("1");
    expect(canonicalUidValidity(1_751_000_000n)).toBe("1751000000");
  });

  it("accepts the bounds 1 and 4294967295 and nothing outside them", () => {
    expect(canonicalUidValidity(1n)).toBe("1");
    expect(canonicalUidValidity(MAX_UID_VALIDITY)).toBe("4294967295");
    expect(canonicalUidValidity(0n)).toBeNull();
    expect(canonicalUidValidity(MAX_UID_VALIDITY + 1n)).toBeNull();
    expect(canonicalUidValidity(-5n)).toBeNull();
  });

  it("accepts an integer number and a canonical decimal string", () => {
    expect(canonicalUidValidity(42)).toBe("42");
    expect(canonicalUidValidity("42")).toBe("42");
  });

  it.each([
    undefined,
    null,
    false,
    true,
    {},
    [],
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "",
    " 7",
    "07",
    "+7",
    "-7",
    "7.0",
    "1e3",
    "0x10",
    "abc",
    "4294967296",
    "99999999999999999999",
  ])("rejects %j", (value) => {
    expect(canonicalUidValidity(value)).toBeNull();
  });
});

describe("liveUidValidity", () => {
  it("reads the selected mailbox's value", () => {
    expect(liveUidValidity({ uidValidity: 77n })).toBe("77");
  });

  it("is null when no mailbox is selected or the server reported nothing usable", () => {
    expect(liveUidValidity(false)).toBeNull();
    expect(liveUidValidity(undefined)).toBeNull();
    expect(liveUidValidity({})).toBeNull();
    expect(liveUidValidity({ uidValidity: 0n })).toBeNull();
  });
});

describe("compareUidValidity", () => {
  it("matches only identical values", () => {
    expect(compareUidValidity("5", "5")).toBe("match");
  });

  it("reports a change when both are known and differ", () => {
    expect(compareUidValidity("5", "6")).toBe("changed");
  });

  it("cannot verify without a stored value (fails closed)", () => {
    expect(compareUidValidity(null, "5")).toBe("unverified");
    expect(compareUidValidity(undefined, "5")).toBe("unverified");
  });

  it("cannot verify without a live value (fails closed)", () => {
    expect(compareUidValidity("5", null)).toBe("unverified");
    expect(compareUidValidity(null, null)).toBe("unverified");
  });
});

describe("classifyPollValidity", () => {
  it("baselines the first value it sees", () => {
    expect(classifyPollValidity(null, "5")).toBe("baseline");
    expect(classifyPollValidity(undefined, "5")).toBe("baseline");
  });

  it("does nothing when the value is unchanged", () => {
    expect(classifyPollValidity("5", "5")).toBe("same");
  });

  it("treats a different known value as a reset", () => {
    expect(classifyPollValidity("5", "6")).toBe("reset");
  });

  it("does nothing when the server reported no usable value", () => {
    expect(classifyPollValidity("5", null)).toBe("unknown");
    expect(classifyPollValidity(null, null)).toBe("unknown");
  });
});

describe("validityFailure", () => {
  it("tells the user to wait for a sync when nothing was verified yet", () => {
    expect(validityFailure("Naver", "unverified")).toEqual({
      error: expect.stringContaining("Naver"),
    });
    expect(validityFailure("Naver", "unverified").error).toMatch(/sync/i);
  });

  it("says the mailbox was renumbered when the value changed", () => {
    expect(validityFailure("iCloud", "changed").error).toMatch(/iCloud/);
    expect(validityFailure("iCloud", "changed").error).toMatch(/renumber|reset/i);
  });
});

describe("logValidityRefusalOnce", () => {
  beforeEach(() => {
    resetUidValidityLogState();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the first refusal for an account and change", () => {
    logValidityRefusalOnce("naver-imap", "row-1", "changed", "5", "6");
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("does not log the same refusal again", () => {
    logValidityRefusalOnce("naver-imap", "row-1", "changed", "5", "6");
    logValidityRefusalOnce("naver-imap", "row-1", "changed", "5", "6");
    logValidityRefusalOnce("naver-imap", "row-1", "changed", "5", "6");
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("logs again when the live value changes again, or for another account", () => {
    logValidityRefusalOnce("naver-imap", "row-1", "changed", "5", "6");
    logValidityRefusalOnce("naver-imap", "row-1", "changed", "5", "7");
    logValidityRefusalOnce("naver-imap", "row-2", "changed", "5", "6");
    expect(console.warn).toHaveBeenCalledTimes(3);
  });

  it("names the row and both values, never a message id or a credential", () => {
    logValidityRefusalOnce("naver-imap", "row-1", "changed", "5", "6");
    const line = String(
      (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0],
    );
    expect(line).toContain("row-1");
    expect(line).toContain("5");
    expect(line).toContain("6");
    expect(line).not.toMatch(/@/);
  });

  it("forgets everything on reset", () => {
    logValidityRefusalOnce("naver-imap", "row-1", "changed", "5", "6");
    resetUidValidityLogState();
    logValidityRefusalOnce("naver-imap", "row-1", "changed", "5", "6");
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
