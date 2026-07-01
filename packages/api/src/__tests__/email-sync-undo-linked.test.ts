import { beforeEach, describe, expect, it, vi } from "vitest";

// syncEmailByGmailId re-syncs ONE message after an undo (untrash/unarchive). For
// a LINKED secondary inbox the message id only exists in that account, so the
// fetch, self-detection address, and stored tag must all use the linked account
// — not the primary, where a plain fetch would 404. These tests pin that routing.

const m = vi.hoisted(() => ({
  getAuthedInboxAccount: vi.fn(),
  fetchGmailEmailById: vi.fn(),
  persistGmailEmail: vi.fn(async () => ({ emailId: "e1", isNew: true })),
}));

vi.mock("../gmail.js", () => ({
  getAuthedClient: vi.fn(async () => ({})),
  getAuthedInboxAccount: m.getAuthedInboxAccount,
  isGoogleAuthError: () => false,
  isGoogleNotFoundError: () => false,
  markGoogleTokenForReconnect: vi.fn(async () => {}),
}));
vi.mock("../gmail-fetch.js", () => ({
  fetchGmailEmailById: m.fetchGmailEmailById,
  fetchGmailEmails: vi.fn(),
}));
vi.mock("../email-firewall.js", () => ({ persistGmailEmail: m.persistGmailEmail }));
vi.mock("../resolve-user-email.js", () => ({ resolveUserEmail: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../db.js", () => ({ prisma: {} }));

import { syncEmailByGmailId } from "../email-sync.js";

const RAW = { gmailId: "g1" } as never;

describe("syncEmailByGmailId — linked-inbox undo routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.fetchGmailEmailById.mockResolvedValue(RAW);
    m.persistGmailEmail.mockResolvedValue({ emailId: "e1", isNew: true });
  });

  it("routes fetch + persist through the LINKED account when linkedInboxAccountId is set", async () => {
    const linkedClient = { linked: true };
    m.getAuthedInboxAccount.mockResolvedValue({
      client: linkedClient,
      id: "link-1",
      email: "second@work.com",
    });

    await syncEmailByGmailId("user-1", "g1", "link-1");

    expect(m.getAuthedInboxAccount).toHaveBeenCalledWith("user-1", "link-1");
    // Fetch must use the linked client, or it 404s against the primary account.
    expect(m.fetchGmailEmailById).toHaveBeenCalledWith("user-1", "g1", linkedClient);
    // Persist stamps the linked tag + uses the linked address for self-detection.
    expect(m.persistGmailEmail).toHaveBeenCalledWith("user-1", RAW, {
      userEmail: "second@work.com",
      linkedInboxAccountId: "link-1",
    });
  });

  it("uses the primary account (null client + tag) when no linkedInboxAccountId is given", async () => {
    await syncEmailByGmailId("user-1", "g1");

    expect(m.getAuthedInboxAccount).not.toHaveBeenCalled();
    expect(m.fetchGmailEmailById).toHaveBeenCalledWith("user-1", "g1", null);
    expect(m.persistGmailEmail).toHaveBeenCalledWith("user-1", RAW, {
      userEmail: null,
      linkedInboxAccountId: null,
    });
  });

  it("throws (not silently primary-fetches) when the linked account token is unusable", async () => {
    m.getAuthedInboxAccount.mockResolvedValue(null);

    await expect(syncEmailByGmailId("user-1", "g1", "link-1")).rejects.toThrow(
      "Gmail not connected",
    );
    // Must NOT fall back to a primary fetch of an id that only exists in the linked account.
    expect(m.fetchGmailEmailById).not.toHaveBeenCalled();
  });
});
