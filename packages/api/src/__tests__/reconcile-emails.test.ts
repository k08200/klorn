import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// reconcileEmails used to load the user's ENTIRE EmailMessage table into Node to
// diff it against the Gmail INBOX every tick (unbounded memory), and an empty
// INBOX listing (a transient Gmail hiccup) would mark every row "stale" and wipe
// the local mirror. These tests pin the bounded, DB-side, mass-wipe-safe rewrite.

const m = vi.hoisted(() => ({
  listMock: vi.fn(),
  getMock: vi.fn(),
  deleteMany: vi.fn(async () => ({ count: 0 })),
  findMany: vi.fn(async () => [] as { gmailId: string }[]),
  updateMany: vi.fn(async () => ({ count: 0 })),
  attentionUpdateMany: vi.fn(async () => ({ count: 0 })),
  getLinkedInboxClients: vi.fn(async () => [] as { client: object; id: string; email: string }[]),
  captureError: vi.fn(),
  isGoogleAuthError: vi.fn(() => false),
  markGoogleReconnect: vi.fn(async () => {}),
  markLinkedReconnect: vi.fn(async () => {}),
  noteProviderArchives: vi.fn(async () => 0),
}));

vi.mock("googleapis", () => ({
  google: {
    gmail: vi.fn(() => ({ users: { messages: { list: m.listMock, get: m.getMock } } })),
  },
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(async () => ({})),
  getLinkedInboxClients: m.getLinkedInboxClients,
  isGoogleAuthError: m.isGoogleAuthError,
  isGoogleNotFoundError: () => false,
  markGoogleTokenForReconnect: m.markGoogleReconnect,
  markLinkedInboxForReconnect: m.markLinkedReconnect,
}));
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));
vi.mock("../mail/provider-archives.js", () => ({ noteProviderArchives: m.noteProviderArchives }));
// Stub heavy import chains pulled in by email-sync.ts but unused by reconcileEmails.
vi.mock("../judge/email-firewall.js", () => ({ persistGmailEmail: vi.fn() }));
vi.mock("../mail/gmail-fetch.js", () => ({
  fetchGmailEmails: vi.fn(),
  fetchGmailEmailById: vi.fn(),
}));
vi.mock("../resolve-user-email.js", () => ({ resolveUserEmail: vi.fn() }));
vi.mock("../db.js", () => ({
  prisma: {
    emailMessage: { deleteMany: m.deleteMany, findMany: m.findMany, updateMany: m.updateMany },
    attentionItem: { updateMany: m.attentionUpdateMany },
  },
}));

import { reconcileEmails, reconcileLinkedInboxes } from "../mail/email-sync.js";

function inboxListing(ids: string[]) {
  return { data: { messages: ids.map((id) => ({ id })), nextPageToken: undefined } };
}

describe("reconcileEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findMany.mockResolvedValue([]);
    m.deleteMany.mockResolvedValue({ count: 0 });
  });

  it("skips reconciliation when the INBOX listing is empty (never mass-deletes the mirror)", async () => {
    m.listMock.mockResolvedValue(inboxListing([]));

    const result = await reconcileEmails("user-1");

    expect(result).toEqual({ removed: 0, updated: 0 });
    expect(m.deleteMany).not.toHaveBeenCalled();
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("removes stale rows in the DB via notIn(INBOX), without loading the whole table", async () => {
    m.listMock.mockResolvedValue(inboxListing(["a", "b"]));
    m.deleteMany.mockResolvedValue({ count: 3 });

    const result = await reconcileEmails("user-1");

    // Scoped to PRIMARY-account rows (linkedInboxAccountId: null): inboxIdList
    // came from the primary INBOX, so linked-inbox rows must be excluded from
    // the notIn wipe or they would ALL match and be deleted.
    // Spam-lane rows are never in the INBOX listing — the label exclusion is
    // what keeps them alive between reconcile ticks (2026-08-18).
    expect(m.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        linkedInboxAccountId: null,
        gmailId: { notIn: ["a", "b"] },
        NOT: { labels: { has: "SPAM" } },
        syncedAt: { lt: expect.any(Date) },
      },
    });
    expect(result.removed).toBe(3);
  });

  it("never deletes linked-inbox rows: every reconcile query is scoped to linkedInboxAccountId: null", async () => {
    m.listMock.mockResolvedValue(inboxListing(["a", "b"]));
    m.findMany.mockResolvedValueOnce([{ id: "row-1" }] as never);
    m.deleteMany.mockResolvedValue({ count: 1 });

    await reconcileEmails("user-1");

    // The stale-lookup, the delete, AND the read-status refresh must all carry
    // linkedInboxAccountId: null — a single unscoped query would wipe or
    // mis-refresh secondary-inbox mail once MULTI_INBOX_SYNC_ENABLED is on.
    for (const call of m.findMany.mock.calls) {
      expect((call[0] as { where: Record<string, unknown> }).where).toMatchObject({
        linkedInboxAccountId: null,
      });
    }
    for (const call of m.deleteMany.mock.calls) {
      expect((call[0] as { where: Record<string, unknown> }).where).toMatchObject({
        linkedInboxAccountId: null,
      });
    }
  });

  it("bounds the read-status refresh to the most recent RECONCILE_REFRESH_CAP rows", async () => {
    m.listMock.mockResolvedValue(inboxListing(["a", "b"]));

    await reconcileEmails("user-1");

    // After the stale delete, every remaining row is in INBOX, so the refresh
    // is a bounded most-recent-N query — no INBOX-sized IN clause.
    expect(m.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", linkedInboxAccountId: null },
        orderBy: { receivedAt: "desc" },
        take: 500,
      }),
    );
  });

  it("falls back to an in-Node diff + chunked id-delete for a very large INBOX", async () => {
    // > INBOX_PARAM_CAP (10000) ids would overflow a single NOT IN's bind params.
    const bigInbox = Array.from({ length: 10_001 }, (_, i) => `m${i}`);
    m.listMock.mockResolvedValue(inboxListing(bigInbox));
    // First findMany = the in-Node "load stored gmailIds" branch; one stale row.
    m.findMany.mockResolvedValueOnce([{ id: "row-x", gmailId: "stale-1", labels: ["INBOX"] }]);
    m.deleteMany.mockResolvedValue({ count: 1 });

    const result = await reconcileEmails("user-1");

    // Deleted by id (chunked), never via a 10k-param gmailId NOT IN — and still
    // account-scoped (linkedInboxAccountId: null on the primary path) so the
    // large-mailbox fallback can't cross accounts either.
    expect(m.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", linkedInboxAccountId: null, id: { in: ["row-x"] } },
    });
    expect(m.deleteMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ gmailId: expect.anything() }),
      }),
    );
    expect(result.removed).toBe(1);
  });

  describe("mail synced while the INBOX listing runs", () => {
    // The listing pages through the whole INBOX newest-first and can take
    // minutes; reconcile runs detached from the scheduler's per-user cycle, so a
    // sync (the next tick's, or Gmail push) can store new mail meanwhile. Mail
    // that arrived after page 1 is not in the listing, and nothing re-fetches it
    // once the history watermark has moved past it, so it must never count as
    // stale.
    const LISTING_STARTED = new Date("2026-11-11T11:07:00.000Z");
    const LISTING_ENDED = new Date("2026-11-11T11:09:00.000Z");

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(LISTING_STARTED);
      m.listMock.mockImplementation(async () => {
        vi.setSystemTime(LISTING_ENDED);
        return inboxListing(["a", "b"]);
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      // The clock-moving listing above must not outlive this block.
      m.listMock.mockReset();
    });

    it("counts as stale only rows synced before the listing started", async () => {
      await reconcileEmails("user-1");

      const staleWhere = {
        userId: "user-1",
        linkedInboxAccountId: null,
        gmailId: { notIn: ["a", "b"] },
        NOT: { labels: { has: "SPAM" } },
        syncedAt: { lt: LISTING_STARTED },
      };
      expect(m.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: staleWhere }));
      expect(m.deleteMany).toHaveBeenCalledWith({ where: staleWhere });
    });

    it("applies the same cut-off on the large-INBOX path", async () => {
      const bigInbox = Array.from({ length: 10_001 }, (_, i) => `m${i}`);
      m.listMock.mockImplementation(async () => {
        vi.setSystemTime(LISTING_ENDED);
        return inboxListing(bigInbox);
      });

      await reconcileEmails("user-1");

      expect(m.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: "user-1",
            linkedInboxAccountId: null,
            syncedAt: { lt: LISTING_STARTED },
          },
          select: expect.objectContaining({ gmailId: true, labels: true }),
        }),
      );
    });
  });

  it("resolves the attention items of archived/trashed emails so they don't orphan as stale PUSH", async () => {
    m.listMock.mockResolvedValue(inboxListing(["a", "b"]));
    // First findMany = the stale-rows lookup (ids about to be deleted).
    m.findMany.mockResolvedValueOnce([{ id: "row-1" }, { id: "row-2" }] as never);
    m.deleteMany.mockResolvedValue({ count: 2 });

    await reconcileEmails("user-1");

    // The mirror row is deleted AND its OPEN/SNOOZED attention item is RESOLVED,
    // so the priority amplifier can't keep surfacing a handled email forever.
    expect(m.attentionUpdateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        source: "EMAIL",
        sourceId: { in: ["row-1", "row-2"] },
        status: { in: ["OPEN", "SNOOZED"] },
      },
      data: expect.objectContaining({ status: "RESOLVED" }),
    });
  });
});

describe("reconcile → provider-side archive stamps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findMany.mockResolvedValue([]);
    m.deleteMany.mockResolvedValue({ count: 0 });
    m.getLinkedInboxClients.mockResolvedValue([]);
  });

  const at = new Date("2026-11-10T09:00:00Z");

  it("hands the rows that left the INBOX to the provider-archive stamp, with this account's client", async () => {
    m.listMock.mockResolvedValue(inboxListing(["a", "b"]));
    m.findMany.mockResolvedValueOnce([
      { id: "row-1", gmailId: "g1", receivedAt: at },
      { id: "row-2", gmailId: "g2", receivedAt: at },
    ] as never);
    m.deleteMany.mockResolvedValue({ count: 2 });

    await reconcileEmails("user-1");

    // The stale lookup now reads gmailId + receivedAt: the stamp re-checks each
    // message in Gmail (spam, back in inbox) and keeps the newest mail first.
    expect(m.findMany.mock.calls[0][0]).toMatchObject({
      select: { id: true, gmailId: true, receivedAt: true },
    });
    expect(m.noteProviderArchives).toHaveBeenCalledTimes(1);
    const [userId, gmail, rows] = m.noteProviderArchives.mock.calls[0] as unknown as [
      string,
      { users: { messages: { get: unknown } } },
      unknown[],
    ];
    expect(userId).toBe("user-1");
    expect(gmail.users.messages.get).toBe(m.getMock);
    expect(rows).toEqual([
      { id: "row-1", gmailId: "g1", receivedAt: at },
      { id: "row-2", gmailId: "g2", receivedAt: at },
    ]);
  });

  it("hands the large-INBOX fallback's stale rows too", async () => {
    const bigInbox = Array.from({ length: 10_001 }, (_, i) => `m${i}`);
    m.listMock.mockResolvedValue(inboxListing(bigInbox));
    m.findMany.mockResolvedValueOnce([
      { id: "row-x", gmailId: "stale-1", labels: ["INBOX"], receivedAt: at },
      { id: "row-in", gmailId: "m5", labels: ["INBOX"], receivedAt: at },
    ] as never);
    m.deleteMany.mockResolvedValue({ count: 1 });

    await reconcileEmails("user-1");

    expect(m.noteProviderArchives.mock.calls[0]?.[2]).toEqual([
      { id: "row-x", gmailId: "stale-1", receivedAt: at },
    ]);
  });

  it("makes no stamp call when nothing left the INBOX, nor on the empty-listing skip", async () => {
    m.listMock.mockResolvedValue(inboxListing(["a"]));
    await reconcileEmails("user-1");
    m.listMock.mockResolvedValue(inboxListing([]));
    await reconcileEmails("user-1");
    expect(m.noteProviderArchives).not.toHaveBeenCalled();
  });
});

describe("reconcileLinkedInboxes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findMany.mockResolvedValue([]);
    m.deleteMany.mockResolvedValue({ count: 0 });
    m.getLinkedInboxClients.mockResolvedValue([]);
  });

  it("reconciles each linked inbox scoped to ITS OWN account id (never null/primary)", async () => {
    m.getLinkedInboxClients.mockResolvedValue([{ client: {}, id: "link-1", email: "a@b.com" }]);
    m.listMock.mockResolvedValue(inboxListing(["a", "b"]));
    m.deleteMany.mockResolvedValue({ count: 2 });

    const result = await reconcileLinkedInboxes("user-1");

    // The delete must be scoped to this linked account — NOT linkedInboxAccountId:
    // null (that is the primary reconcile's job) and NOT unscoped.
    expect(m.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        linkedInboxAccountId: "link-1",
        gmailId: { notIn: ["a", "b"] },
        NOT: { labels: { has: "SPAM" } },
        syncedAt: { lt: expect.any(Date) },
      },
    });
    expect(result.removed).toBe(2);
  });

  it("isolates a failing linked inbox so the others still reconcile, and reports it", async () => {
    m.getLinkedInboxClients.mockResolvedValue([
      { client: {}, id: "link-bad", email: "bad@b.com" },
      { client: {}, id: "link-ok", email: "ok@b.com" },
    ]);
    // First account's INBOX list throws; second returns a normal listing.
    m.listMock.mockRejectedValueOnce(new Error("revoked")).mockResolvedValue(inboxListing(["a"]));
    m.deleteMany.mockResolvedValue({ count: 1 });

    const result = await reconcileLinkedInboxes("user-1");

    // The bad inbox is captured, not swallowed silently...
    expect(m.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: { linkedInboxAccountId: "link-bad" } }),
    );
    // ...and the healthy inbox still reconciled.
    expect(m.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        linkedInboxAccountId: "link-ok",
        gmailId: { notIn: ["a"] },
        NOT: { labels: { has: "SPAM" } },
        syncedAt: { lt: expect.any(Date) },
      },
    });
    expect(result.removed).toBe(1);
  });

  it("is a no-op when the user has no linked inboxes", async () => {
    m.getLinkedInboxClients.mockResolvedValue([]);

    const result = await reconcileLinkedInboxes("user-1");

    expect(result).toEqual({ removed: 0, updated: 0 });
    expect(m.listMock).not.toHaveBeenCalled();
    expect(m.deleteMany).not.toHaveBeenCalled();
  });

  it("flags a revoked linked inbox for reconnect on auth error — never poisons the primary token", async () => {
    m.getLinkedInboxClients.mockResolvedValue([{ client: {}, id: "link-1", email: "a@b.com" }]);
    m.listMock.mockRejectedValue({ response: { status: 401 } });
    m.isGoogleAuthError.mockReturnValueOnce(true);

    // Per-account isolation swallows the throw at the reconcileLinkedInboxes level.
    const result = await reconcileLinkedInboxes("user-1");

    // The linked row is durably flagged for reconnect...
    expect(m.markLinkedReconnect).toHaveBeenCalledWith("user-1", "link-1");
    // ...and the primary token is NEVER touched by a linked failure.
    expect(m.markGoogleReconnect).not.toHaveBeenCalled();
    expect(result).toEqual({ removed: 0, updated: 0 });
  });
});
