/**
 * Step B4, design D5: a per-user cap on generic-IMAP connect attempts, so the
 * connect route cannot be used to scan hosts or to stuff credentials at third-party
 * servers. Fixed window anchored at the first attempt, in-process (same trade-offs
 * as security/login-throttle.ts), bounded memory.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  GENERIC_IMAP_ATTEMPT_WINDOW_MS,
  GENERIC_IMAP_ATTEMPTS_MAX_TRACKED,
  GENERIC_IMAP_ATTEMPTS_PER_WINDOW,
  resetGenericImapAttempts,
  takeGenericImapAttempt,
} from "../mail/generic-imap-attempts.js";

const T0 = 1_800_000_000_000;

beforeEach(() => {
  resetGenericImapAttempts();
});

describe("takeGenericImapAttempt", () => {
  it("allows 10 attempts an hour and refuses the 11th", () => {
    expect(GENERIC_IMAP_ATTEMPTS_PER_WINDOW).toBe(10);
    expect(GENERIC_IMAP_ATTEMPT_WINDOW_MS).toBe(60 * 60 * 1000);
    for (let i = 0; i < 10; i++) {
      expect(takeGenericImapAttempt("u1", T0 + i)).toEqual({ allowed: true });
    }
    expect(takeGenericImapAttempt("u1", T0 + 10)).toEqual({
      allowed: false,
      retryAfterMs: GENERIC_IMAP_ATTEMPT_WINDOW_MS - 10,
    });
  });

  it("counts per user", () => {
    for (let i = 0; i < 10; i++) takeGenericImapAttempt("u1", T0);
    expect(takeGenericImapAttempt("u1", T0).allowed).toBe(false);
    expect(takeGenericImapAttempt("u2", T0)).toEqual({ allowed: true });
  });

  it("anchors the window at the first attempt: refused attempts do not extend it", () => {
    for (let i = 0; i < 10; i++) takeGenericImapAttempt("u1", T0);
    // Hammering while locked must not push the reset further away.
    for (let i = 0; i < 50; i++) takeGenericImapAttempt("u1", T0 + 30 * 60 * 1000);
    expect(takeGenericImapAttempt("u1", T0 + GENERIC_IMAP_ATTEMPT_WINDOW_MS - 1).allowed).toBe(
      false,
    );
    expect(takeGenericImapAttempt("u1", T0 + GENERIC_IMAP_ATTEMPT_WINDOW_MS)).toEqual({
      allowed: true,
    });
  });

  it("starts a fresh window after the old one ends", () => {
    for (let i = 0; i < 10; i++) takeGenericImapAttempt("u1", T0);
    const later = T0 + GENERIC_IMAP_ATTEMPT_WINDOW_MS + 1;
    for (let i = 0; i < 10; i++) {
      expect(takeGenericImapAttempt("u1", later)).toEqual({ allowed: true });
    }
    expect(takeGenericImapAttempt("u1", later).allowed).toBe(false);
  });

  it("reports how long until the user may try again", () => {
    for (let i = 0; i < 10; i++) takeGenericImapAttempt("u1", T0);
    const denied = takeGenericImapAttempt("u1", T0 + 20 * 60 * 1000);
    expect(denied).toEqual({ allowed: false, retryAfterMs: 40 * 60 * 1000 });
  });

  it("keeps memory bounded: past the cap the oldest window is dropped (fails open, never grows)", () => {
    for (let i = 0; i < GENERIC_IMAP_ATTEMPTS_MAX_TRACKED + 5; i++) {
      takeGenericImapAttempt(`user-${i}`, T0);
    }
    // user-0 was evicted: a fresh window, so it may take all ten again.
    for (let i = 0; i < 10; i++) {
      expect(takeGenericImapAttempt("user-0", T0)).toEqual({ allowed: true });
    }
    // The newest user is still tracked: one attempt used, nine left.
    for (let i = 0; i < 9; i++) {
      expect(
        takeGenericImapAttempt(`user-${GENERIC_IMAP_ATTEMPTS_MAX_TRACKED + 4}`, T0).allowed,
      ).toBe(true);
    }
    expect(
      takeGenericImapAttempt(`user-${GENERIC_IMAP_ATTEMPTS_MAX_TRACKED + 4}`, T0).allowed,
    ).toBe(false);
  });
});
