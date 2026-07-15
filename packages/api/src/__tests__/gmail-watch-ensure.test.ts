/**
 * ensureFreshGmailWatch — activity-driven self-heal for the 7-day Gmail
 * watch. The hourly renewal tick dies whenever the dyno sleeps; this hook
 * runs on user activity instead, so an expired watch heals on app open.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tokenFindFirst = vi.hoisted(() => vi.fn());
const captureError = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: tokenFindFirst },
  };
  return { prisma, db: prisma };
});

vi.mock("../sentry.js", () => ({ captureError }));

import { ensureFreshGmailWatch } from "../mail/gmail.js";

const HOUR_MS = 60 * 60 * 1000;
let userSeq = 0;
/** Unique user per test — the debounce map is module-level state. */
const freshUser = () => `ensure-user-${userSeq++}`;

beforeEach(() => {
  vi.stubEnv("GMAIL_PUBSUB_TOPIC", "projects/test/topics/gmail");
  tokenFindFirst.mockReset();
  captureError.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ensureFreshGmailWatch", () => {
  it("does nothing when GMAIL_PUBSUB_TOPIC is not configured", async () => {
    vi.stubEnv("GMAIL_PUBSUB_TOPIC", "");
    const register = vi.fn();
    await ensureFreshGmailWatch(freshUser(), register);
    expect(register).not.toHaveBeenCalled();
    expect(tokenFindFirst).not.toHaveBeenCalled();
  });

  it("does not resurrect a watch the user stopped (expiresAt null)", async () => {
    tokenFindFirst.mockResolvedValue({ gmailWatchExpiresAt: null });
    const register = vi.fn();
    await ensureFreshGmailWatch(freshUser(), register);
    expect(register).not.toHaveBeenCalled();
  });

  it("leaves a healthy watch (expiring in >24h) alone", async () => {
    tokenFindFirst.mockResolvedValue({
      gmailWatchExpiresAt: new Date(Date.now() + 48 * HOUR_MS),
    });
    const register = vi.fn();
    await ensureFreshGmailWatch(freshUser(), register);
    expect(register).not.toHaveBeenCalled();
  });

  it("re-registers a watch that already expired", async () => {
    tokenFindFirst.mockResolvedValue({
      gmailWatchExpiresAt: new Date(Date.now() - 24 * HOUR_MS),
    });
    const register = vi.fn(async () => ({ historyId: "1", expiration: "2" }));
    await ensureFreshGmailWatch(freshUser(), register);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("re-registers a watch expiring within the 24h margin", async () => {
    tokenFindFirst.mockResolvedValue({
      gmailWatchExpiresAt: new Date(Date.now() + 1 * HOUR_MS),
    });
    const register = vi.fn(async () => ({ historyId: "1", expiration: "2" }));
    await ensureFreshGmailWatch(freshUser(), register);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("debounces per user — a second call within 10 min is a no-op", async () => {
    const userId = freshUser();
    tokenFindFirst.mockResolvedValue({
      gmailWatchExpiresAt: new Date(Date.now() - HOUR_MS),
    });
    const register = vi.fn(async () => ({ historyId: "1", expiration: "2" }));
    await ensureFreshGmailWatch(userId, register);
    await ensureFreshGmailWatch(userId, register);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("captures registration failures to Sentry without throwing", async () => {
    tokenFindFirst.mockResolvedValue({
      gmailWatchExpiresAt: new Date(Date.now() - HOUR_MS),
    });
    const register = vi.fn(async () => ({ error: "watch failed" }));
    await expect(ensureFreshGmailWatch(freshUser(), register)).resolves.toBeUndefined();
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  it("swallows DB errors (fire-and-forget contract)", async () => {
    tokenFindFirst.mockRejectedValue(new Error("db down"));
    const register = vi.fn();
    await expect(ensureFreshGmailWatch(freshUser(), register)).resolves.toBeUndefined();
    expect(register).not.toHaveBeenCalled();
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});
