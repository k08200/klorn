import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));

vi.mock("googleapis", () => ({
  google: {
    gmail: vi.fn(() => ({ users: { messages: { list: m.listMock, get: m.getMock } } })),
  },
}));
vi.mock("../gmail.js", () => ({
  getAuthedClient: vi.fn(async () => ({})),
  isGoogleAuthError: () => false,
  isGoogleNotFoundError: () => false,
  markGoogleTokenForReconnect: vi.fn(async () => {}),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
// Stub heavy import chains pulled in by email-sync.ts but unused by reconcileEmails.
vi.mock("../email-firewall.js", () => ({ persistGmailEmail: vi.fn() }));
vi.mock("../gmail-fetch.js", () => ({ fetchGmailEmails: vi.fn(), fetchGmailEmailById: vi.fn() }));
vi.mock("../resolve-user-email.js", () => ({ resolveUserEmail: vi.fn() }));
vi.mock("../db.js", () => ({
  prisma: {
    emailMessage: { deleteMany: m.deleteMany, findMany: m.findMany, updateMany: m.updateMany },
  },
}));

import { reconcileEmails } from "../email-sync.js";

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

    expect(m.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", gmailId: { notIn: ["a", "b"] } },
    });
    expect(result.removed).toBe(3);
  });

  it("bounds the read-status refresh to the most recent RECONCILE_REFRESH_CAP rows", async () => {
    m.listMock.mockResolvedValue(inboxListing(["a", "b"]));

    await reconcileEmails("user-1");

    // After the stale delete, every remaining row is in INBOX, so the refresh
    // is a bounded most-recent-N query — no INBOX-sized IN clause.
    expect(m.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1" },
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
    m.findMany.mockResolvedValueOnce([{ id: "row-x", gmailId: "stale-1" }]);
    m.deleteMany.mockResolvedValue({ count: 1 });

    const result = await reconcileEmails("user-1");

    // Deleted by id (chunked), never via a 10k-param gmailId NOT IN.
    expect(m.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", id: { in: ["row-x"] } },
    });
    expect(m.deleteMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ gmailId: expect.anything() }),
      }),
    );
    expect(result.removed).toBe(1);
  });
});
