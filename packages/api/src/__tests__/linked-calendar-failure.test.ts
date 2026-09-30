/**
 * One failure policy for a linked calendar account, shared by the conflict
 * checks and the linked sync. A Google auth error is an account condition (the
 * token was revoked), not a bug: it flags the account for reconnect, warns once
 * per account per window and never reaches Sentry. Anything else is captured,
 * with the domain only (never the full address).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  markLinkedCalendarForReconnect: vi.fn(async () => {}),
  captureError: vi.fn(),
}));

vi.mock("../mail/gmail.js", () => ({
  isGoogleAuthError: (e: { response?: { status?: number } }) => e?.response?.status === 401,
  markLinkedCalendarForReconnect: m.markLinkedCalendarForReconnect,
}));
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));

import {
  _resetLinkedCalendarFailureLogForTests,
  handleLinkedCalendarFailure,
  LINKED_AUTH_WARN_WINDOW_MS,
} from "../pim/linked-calendar-failure.js";

const AUTH_ERROR = { response: { status: 401 }, message: "invalid_grant" };
const failure = (overrides: Partial<Parameters<typeof handleLinkedCalendarFailure>[0]> = {}) => ({
  userId: "u1",
  linkedAccountId: "acct-1",
  email: "me@work.com",
  err: new Error("boom"),
  scope: "calendar.linked_sync_failed",
  action: "sync",
  ...overrides,
});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  _resetLinkedCalendarFailureLogForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("handleLinkedCalendarFailure — a Google auth error", () => {
  it("flags the account for reconnect and never sends the error to Sentry", async () => {
    await handleLinkedCalendarFailure(failure({ err: AUTH_ERROR }));

    expect(m.markLinkedCalendarForReconnect).toHaveBeenCalledWith("u1", "acct-1");
    expect(m.captureError).not.toHaveBeenCalled();
  });

  it("warns once per account per window, however often it fails", async () => {
    await handleLinkedCalendarFailure(failure({ err: AUTH_ERROR }));
    await handleLinkedCalendarFailure(failure({ err: AUTH_ERROR }));
    await handleLinkedCalendarFailure(failure({ err: AUTH_ERROR }));

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns again once the window has passed", async () => {
    await handleLinkedCalendarFailure(failure({ err: AUTH_ERROR }));
    vi.setSystemTime(new Date(Date.now() + LINKED_AUTH_WARN_WINDOW_MS + 1));
    await handleLinkedCalendarFailure(failure({ err: AUTH_ERROR }));

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("keeps a separate window per account", async () => {
    await handleLinkedCalendarFailure(failure({ err: AUTH_ERROR, linkedAccountId: "acct-1" }));
    await handleLinkedCalendarFailure(failure({ err: AUTH_ERROR, linkedAccountId: "acct-2" }));

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not let a failing flag write hide the condition or abort the caller", async () => {
    m.markLinkedCalendarForReconnect.mockRejectedValueOnce(new Error("db blip"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      handleLinkedCalendarFailure(failure({ err: AUTH_ERROR })),
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalled();
    // The DB blip is captured (it is a bug worth seeing); the auth error is not.
    expect(m.captureError).toHaveBeenCalledTimes(1);
    expect(m.captureError.mock.calls[0]?.[1]).toMatchObject({
      tags: { scope: "calendar.linked.mark-reconnect" },
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("handleLinkedCalendarFailure — any other error", () => {
  it("is warned on every occurrence and captured under the caller's scope, with the domain only", async () => {
    await handleLinkedCalendarFailure(failure());
    await handleLinkedCalendarFailure(failure());

    expect(warn).toHaveBeenCalledTimes(2);
    expect(m.captureError).toHaveBeenCalledTimes(2);
    const [, options] = m.captureError.mock.calls[0] as [
      unknown,
      { tags: { scope: string }; extra: Record<string, unknown> },
    ];
    expect(options.tags.scope).toBe("calendar.linked_sync_failed");
    expect(options.extra).toEqual({ userId: "u1", accountDomain: "work.com" });
    expect(JSON.stringify(m.captureError.mock.calls)).not.toContain("me@work.com");
  });

  it("does not flag the account for reconnect: a transient failure must not demand a re-link", async () => {
    await handleLinkedCalendarFailure(failure());

    expect(m.markLinkedCalendarForReconnect).not.toHaveBeenCalled();
  });

  it("names the action in the log line", async () => {
    await handleLinkedCalendarFailure(failure({ action: "free/busy" }));

    expect(String(warn.mock.calls[0]?.[0])).toContain("free/busy");
  });

  it("uses 'unknown' when the address has no domain", async () => {
    await handleLinkedCalendarFailure(failure({ email: "nodomain" }));

    expect(m.captureError.mock.calls[0]?.[1]).toMatchObject({
      extra: { accountDomain: "unknown" },
    });
  });
});
