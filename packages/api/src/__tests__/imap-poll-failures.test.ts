/**
 * Step B4 review fix: a generic poll that keeps failing must not flood Sentry (one
 * event per tick per account is hundreds a day). A failure is classified into a short
 * kind; an account reports a kind once, until it changes or a poll succeeds.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPollFailure,
  MAX_TRACKED_POLL_FAILURES,
  pollFailureKind,
  resetPollFailureState,
  shouldReportPollFailure,
} from "../mail/imap-poll-failures.js";
import { PinnedAddressError } from "../mail/pinned-address.js";

beforeEach(() => {
  resetPollFailureState();
});

describe("pollFailureKind", () => {
  it("a rejected login is 'auth', by either of imapflow's signals", () => {
    expect(pollFailureKind(Object.assign(new Error("x"), { authenticationFailed: true }))).toBe(
      "auth",
    );
    expect(
      pollFailureKind(
        Object.assign(new Error("x"), { serverResponseCode: "AUTHENTICATIONFAILED" }),
      ),
    ).toBe("auth");
  });

  it("a refused name is its own code", () => {
    expect(pollFailureKind(new PinnedAddressError("blocked-address", ["10.0.0.1"]))).toBe(
      "blocked-address",
    );
    expect(pollFailureKind(new PinnedAddressError("unresolvable"))).toBe("unresolvable");
  });

  it.each([
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "LiteralTooLarge",
    "CONNECT_TIMEOUT",
  ])("a library error code is kept: %s", (code) => {
    expect(pollFailureKind(Object.assign(new Error("x"), { code }))).toBe(code);
  });

  it.each([
    ["no code", new Error("x")],
    ["a string", "boom"],
    ["null", null],
    ["a code with a newline", Object.assign(new Error("x"), { code: "E\nFORGED" })],
    ["a code with a space", Object.assign(new Error("x"), { code: "E FORGED" })],
    ["a numeric code", Object.assign(new Error("x"), { code: 1 })],
    ["an over-long code", Object.assign(new Error("x"), { code: "E".repeat(200) })],
  ])("everything else is 'error': %s", (_label, error) => {
    expect(pollFailureKind(error)).toBe("error");
  });
});

describe("shouldReportPollFailure", () => {
  it("reports the first failure and stays quiet while the same kind persists", () => {
    expect(shouldReportPollFailure("row-1", "ECONNREFUSED")).toBe(true);
    expect(shouldReportPollFailure("row-1", "ECONNREFUSED")).toBe(false);
    expect(shouldReportPollFailure("row-1", "ECONNREFUSED")).toBe(false);
  });

  it("reports again when the kind changes, and again when it changes back", () => {
    expect(shouldReportPollFailure("row-1", "ECONNREFUSED")).toBe(true);
    expect(shouldReportPollFailure("row-1", "auth")).toBe(true);
    expect(shouldReportPollFailure("row-1", "auth")).toBe(false);
    expect(shouldReportPollFailure("row-1", "ECONNREFUSED")).toBe(true);
  });

  it("counts each account on its own", () => {
    expect(shouldReportPollFailure("row-1", "auth")).toBe(true);
    expect(shouldReportPollFailure("row-2", "auth")).toBe(true);
    expect(shouldReportPollFailure("row-1", "auth")).toBe(false);
  });

  it("a success (clearPollFailure) re-arms the report", () => {
    shouldReportPollFailure("row-1", "auth");
    clearPollFailure("row-1");
    expect(shouldReportPollFailure("row-1", "auth")).toBe(true);
  });

  it("clearing an account that never failed is harmless", () => {
    expect(() => clearPollFailure("never-failed")).not.toThrow();
  });

  it("keeps memory bounded: past the cap the oldest account is forgotten (it reports again)", () => {
    for (let i = 0; i < MAX_TRACKED_POLL_FAILURES + 5; i++)
      shouldReportPollFailure(`row-${i}`, "x");
    expect(shouldReportPollFailure("row-0", "x")).toBe(true); // evicted
    expect(shouldReportPollFailure(`row-${MAX_TRACKED_POLL_FAILURES + 4}`, "x")).toBe(false); // kept
  });
});
