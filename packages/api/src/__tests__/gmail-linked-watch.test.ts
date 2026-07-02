import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * P3 landmine guard: renewExpiringGmailWatches must ALSO renew/register the
 * Gmail push watches for LINKED secondary inboxes. If it only queried the
 * primary UserToken (as it did before), every linked inbox's real-time push
 * would silently expire ~7 days after it was set up and degrade to polling
 * with no signal. Gated on MULTI_INBOX_SYNC_ENABLED.
 */

const m = vi.hoisted(() => ({
  userTokenFindMany: vi.fn(async () => [] as unknown[]),
  linkedFindMany: vi.fn(),
  linkedFindFirst: vi.fn(),
  linkedUpdateMany: vi.fn(async () => ({ count: 1 })),
  watch: vi.fn(async () => ({
    data: { historyId: "1", expiration: String(Date.now() + 7 * 86_400_000) },
  })),
}));

vi.mock("../db.js", () => ({
  prisma: {
    userToken: { findMany: m.userTokenFindMany },
    linkedInboxAccount: {
      findMany: m.linkedFindMany,
      findFirst: m.linkedFindFirst,
      updateMany: m.linkedUpdateMany,
    },
  },
}));
vi.mock("../crypto-tokens.js", () => ({
  decryptToken: (v: string) => `p:${v}`,
  decryptOptional: (v: string | null) => (v ? `p:${v}` : null),
  encryptToken: (v: string) => `e:${v}`,
  encryptOptional: (v: string | null) => (v ? `e:${v}` : null),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
        on() {}
      },
    },
    gmail: () => ({ users: { watch: m.watch } }),
  },
}));

const ORIGINAL_FLAG = process.env.MULTI_INBOX_SYNC_ENABLED;
const ORIGINAL_TOPIC = process.env.GMAIL_PUBSUB_TOPIC;

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.MULTI_INBOX_SYNC_ENABLED;
  else process.env.MULTI_INBOX_SYNC_ENABLED = ORIGINAL_FLAG;
  if (ORIGINAL_TOPIC === undefined) delete process.env.GMAIL_PUBSUB_TOPIC;
  else process.env.GMAIL_PUBSUB_TOPIC = ORIGINAL_TOPIC;
  vi.resetModules();
  vi.clearAllMocks();
});

describe("renewExpiringGmailWatches — linked inboxes", () => {
  it("registers/renews LINKED inbox watches when the feature is on (not just primary)", async () => {
    process.env.MULTI_INBOX_SYNC_ENABLED = "true";
    process.env.GMAIL_PUBSUB_TOPIC = "projects/p/topics/t";
    m.userTokenFindMany.mockResolvedValue([]); // no primary watches to renew
    m.linkedFindMany.mockResolvedValue([{ id: "acc1", userId: "u1" }]); // one needs a watch
    m.linkedFindFirst.mockResolvedValue({
      id: "acc1",
      email: "w@x.com",
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: null,
    });
    vi.resetModules();
    const { renewExpiringGmailWatches } = await import("../gmail.js");
    const result = await renewExpiringGmailWatches();

    expect(m.linkedFindMany).toHaveBeenCalled(); // the landmine fix: linked queried
    expect(m.watch).toHaveBeenCalled(); // a watch was registered for the linked inbox
    expect(m.linkedUpdateMany).toHaveBeenCalled(); // expiry persisted on the linked row
    expect(result.renewed).toBe(1);
  });

  it("does NOT touch linked inbox watches when the feature is off", async () => {
    process.env.MULTI_INBOX_SYNC_ENABLED = "false";
    process.env.GMAIL_PUBSUB_TOPIC = "projects/p/topics/t";
    m.userTokenFindMany.mockResolvedValue([]);
    vi.resetModules();
    const { renewExpiringGmailWatches } = await import("../gmail.js");
    await renewExpiringGmailWatches();
    expect(m.linkedFindMany).not.toHaveBeenCalled();
    expect(m.watch).not.toHaveBeenCalled();
  });

  it("skips inboxes already flagged needsReconnect (no hourly retry storm on revoked tokens)", async () => {
    process.env.MULTI_INBOX_SYNC_ENABLED = "true";
    process.env.GMAIL_PUBSUB_TOPIC = "projects/p/topics/t";
    m.userTokenFindMany.mockResolvedValue([]);
    m.linkedFindMany.mockResolvedValue([]);
    vi.resetModules();
    const { renewExpiringGmailWatches } = await import("../gmail.js");
    await renewExpiringGmailWatches();

    // The renewal query must exclude reconnect-flagged inboxes — otherwise a
    // revoked linked token retries watch registration every tick forever.
    expect(m.linkedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ needsReconnect: false }),
      }),
    );
  });

  it("flags a linked inbox for reconnect when its watch registration hits an auth error", async () => {
    process.env.MULTI_INBOX_SYNC_ENABLED = "true";
    process.env.GMAIL_PUBSUB_TOPIC = "projects/p/topics/t";
    m.userTokenFindMany.mockResolvedValue([]);
    m.linkedFindMany.mockResolvedValue([{ id: "acc1", userId: "u1" }]);
    m.linkedFindFirst.mockResolvedValue({
      id: "acc1",
      email: "w@x.com",
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: null,
    });
    m.watch.mockRejectedValueOnce({ response: { status: 401 } });
    vi.resetModules();
    const { renewExpiringGmailWatches } = await import("../gmail.js");
    const result = await renewExpiringGmailWatches();

    // A 401 on renewal durably flags the inbox (so the UI prompts a re-link and
    // the next tick skips it), rather than silently failing every hour.
    expect(m.linkedUpdateMany).toHaveBeenCalledWith({
      where: { id: "acc1", userId: "u1" },
      data: { needsReconnect: true },
    });
    expect(result.failed).toBe(1);
  });
});
