import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wiring: when a Google token is invalidated (invalid_grant / revoked /
// undecryptable) or a linked inbox is flagged for re-link, the user must be
// actively told — not just have the token row silently emptied. These tests
// prove markGoogleTokenForReconnect / markLinkedInboxForReconnect fire the
// reconnect notification, and that a notify failure never breaks invalidation.
const state = vi.hoisted(() => ({
  tokenRow: { id: "tok-1", userId: "user-1" } as { id: string; userId: string } | null,
  linkedUpdateCount: 1,
}));

vi.mock("../db.js", () => ({
  prisma: {
    userToken: {
      findFirst: vi.fn(async () => state.tokenRow),
      update: vi.fn(async () => ({})),
    },
    linkedInboxAccount: {
      updateMany: vi.fn(async () => ({ count: state.linkedUpdateCount })),
    },
  },
}));

const ensureSpy = vi.hoisted(() => vi.fn(async () => ({ id: "n-1", createdAt: new Date() })));
vi.mock("../notify/reconnect-notification.js", () => ({
  ensureGmailReconnectNotification: ensureSpy,
}));

import { prisma } from "../db.js";
import { markGoogleTokenForReconnect, markLinkedInboxForReconnect } from "../mail/gmail.js";

beforeEach(() => {
  state.tokenRow = { id: "tok-1", userId: "user-1" };
  state.linkedUpdateCount = 1;
  vi.clearAllMocks();
  // invalidateGoogleToken only mutates (and therefore only notifies) in prod —
  // the non-prod guard protects the founder's real token from env-mismatch
  // scripts. Simulate the Render prod environment.
  vi.stubEnv("RENDER", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("markGoogleTokenForReconnect — reconnect notification wiring", () => {
  it("invalidates the token AND fires the reconnect notification for the user", async () => {
    await markGoogleTokenForReconnect("user-1");
    expect(vi.mocked(prisma.userToken.update)).toHaveBeenCalledTimes(1);
    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expect(ensureSpy).toHaveBeenCalledWith("user-1");
  });

  it("does nothing when the user has no google token row", async () => {
    state.tokenRow = null;
    await markGoogleTokenForReconnect("user-1");
    expect(vi.mocked(prisma.userToken.update)).not.toHaveBeenCalled();
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("non-prod env guard: skips BOTH the DB write and the notification (no false alarms)", async () => {
    vi.unstubAllEnvs(); // NODE_ENV=test, RENDER unset → guard path
    await markGoogleTokenForReconnect("user-1");
    expect(vi.mocked(prisma.userToken.update)).not.toHaveBeenCalled();
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("best-effort: a notification failure never fails the invalidation itself", async () => {
    ensureSpy.mockRejectedValueOnce(new Error("push infra down"));
    await expect(markGoogleTokenForReconnect("user-1")).resolves.toBeUndefined();
    expect(vi.mocked(prisma.userToken.update)).toHaveBeenCalledTimes(1);
  });
});

describe("markLinkedInboxForReconnect — reconnect notification wiring", () => {
  it("flags the linked row AND fires the reconnect notification scoped to that account", async () => {
    await markLinkedInboxForReconnect("user-1", "linked-1");
    expect(vi.mocked(prisma.linkedInboxAccount.updateMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "linked-1", userId: "user-1" } }),
    );
    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expect(ensureSpy).toHaveBeenCalledWith("user-1", { linkedInboxAccountId: "linked-1" });
  });

  it("does not notify when the {id, userId} scope matched no row", async () => {
    state.linkedUpdateCount = 0;
    await markLinkedInboxForReconnect("user-1", "someone-elses-inbox");
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("best-effort: a notification failure never fails the reconnect flagging", async () => {
    ensureSpy.mockRejectedValueOnce(new Error("push infra down"));
    await expect(markLinkedInboxForReconnect("user-1", "linked-1")).resolves.toBeUndefined();
    expect(vi.mocked(prisma.linkedInboxAccount.updateMany)).toHaveBeenCalledTimes(1);
  });
});
