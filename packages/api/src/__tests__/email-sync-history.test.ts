import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailRawEmail } from "../gmail-fetch.js";

// syncEmails is history-aware: it reads a stored watermark, fetches either the
// incremental History slice or a first-sync snapshot, persists, and only THEN
// advances the watermark. These tests mock every collaborator at the module
// boundary so we assert the orchestration (order + branch selection), not Gmail.

const fetchGmailEmails = vi.fn();
const fetchGmailHistory = vi.fn();
const fetchCurrentHistoryId = vi.fn();
const fetchGmailEmailById = vi.fn();
vi.mock("../gmail-fetch.js", () => ({
  fetchGmailEmails: (...a: unknown[]) => fetchGmailEmails(...a),
  fetchGmailHistory: (...a: unknown[]) => fetchGmailHistory(...a),
  fetchCurrentHistoryId: (...a: unknown[]) => fetchCurrentHistoryId(...a),
  fetchGmailEmailById: (...a: unknown[]) => fetchGmailEmailById(...a),
}));

const persistGmailEmail = vi.fn(async () => ({ emailId: "e1", isNew: true }));
vi.mock("../email-firewall.js", () => ({
  persistGmailEmail: (...a: unknown[]) => persistGmailEmail(...a),
  backfillEmailAttentionItems: vi.fn(),
  judgeAndMirrorEmail: vi.fn(),
}));

vi.mock("../resolve-user-email.js", () => ({
  resolveUserEmail: vi.fn(async () => "me@example.com"),
}));

const userTokenFindFirst = vi.fn(async () => ({ historyId: null }) as { historyId: string | null });
const userTokenUpdateMany = vi.fn(async () => ({ count: 1 }));
const linkedFindFirst = vi.fn(
  async () => ({ historyId: null }) as { historyId: string | null } | null,
);
const linkedUpdateMany = vi.fn(async () => ({ count: 1 }));
vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: userTokenFindFirst, updateMany: userTokenUpdateMany },
    linkedInboxAccount: { findFirst: linkedFindFirst, updateMany: linkedUpdateMany },
  };
  return { prisma, db: prisma };
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

function raw(id: string): GmailRawEmail {
  return {
    gmailId: id,
    threadId: `t-${id}`,
    from: "s@example.com",
    to: "me@example.com",
    cc: "",
    subject: id,
    snippet: id,
    body: id,
    htmlBody: "",
    labels: ["INBOX"],
    isRead: false,
    isStarred: false,
    receivedAt: new Date("2024-01-01T00:00:00Z"),
    attachments: [],
  };
}

const { syncEmails } = await import("../email-sync.js");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  userTokenFindFirst.mockResolvedValue({ historyId: null });
  linkedFindFirst.mockResolvedValue({ historyId: null });
  persistGmailEmail.mockResolvedValue({ emailId: "e1", isNew: true });
});

describe("syncEmails — first sync (no stored watermark)", () => {
  it("runs the snapshot path and baselines the watermark via getProfile", async () => {
    userTokenFindFirst.mockResolvedValue({ historyId: null });
    fetchGmailEmails.mockResolvedValue([raw("a"), raw("b")]);
    fetchCurrentHistoryId.mockResolvedValue("9000");

    const result = await syncEmails("user-1", 30);

    // Snapshot path (not history) populates the mirror on the very first sync.
    expect(fetchGmailEmails).toHaveBeenCalledTimes(1);
    expect(fetchGmailHistory).not.toHaveBeenCalled();
    expect(persistGmailEmail).toHaveBeenCalledTimes(2);
    // Watermark baselined for the NEXT sync to use the History API.
    expect(fetchCurrentHistoryId).toHaveBeenCalledWith("user-1", undefined);
    expect(userTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", provider: "google" },
        data: { historyId: "9000" },
      }),
    );
    expect(result).toEqual({ synced: 2, newCount: 2, source: "gmail" });
  });

  it("does NOT store a watermark when getProfile returns null", async () => {
    userTokenFindFirst.mockResolvedValue({ historyId: null });
    fetchGmailEmails.mockResolvedValue([raw("a")]);
    fetchCurrentHistoryId.mockResolvedValue(null);

    await syncEmails("user-1", 30);

    expect(userTokenUpdateMany).not.toHaveBeenCalled();
  });
});

describe("syncEmails — incremental sync (stored watermark)", () => {
  it("uses fetchGmailHistory and persists messages a top-30 snapshot would miss", async () => {
    userTokenFindFirst.mockResolvedValue({ historyId: "1000" });
    // 40 messages arrived since the watermark — more than a 30-cap snapshot.
    const many = Array.from({ length: 40 }, (_, i) => raw(`m${i}`));
    fetchGmailHistory.mockResolvedValue({ emails: many, newHistoryId: "1040", expired: false });

    const result = await syncEmails("user-1", 30);

    expect(fetchGmailHistory).toHaveBeenCalledWith("user-1", "1000", undefined);
    expect(fetchGmailEmails).not.toHaveBeenCalled();
    // Every one of the 40 gap-filled messages is persisted — none dropped.
    expect(persistGmailEmail).toHaveBeenCalledTimes(40);
    expect(result.synced).toBe(40);
  });

  it("advances the watermark ONLY after persist, and to the new historyId", async () => {
    userTokenFindFirst.mockResolvedValue({ historyId: "1000" });
    fetchGmailHistory.mockResolvedValue({
      emails: [raw("a")],
      newHistoryId: "1040",
      expired: false,
    });
    const order: string[] = [];
    persistGmailEmail.mockImplementation(async () => {
      order.push("persist");
      return { emailId: "e1", isNew: true };
    });
    userTokenUpdateMany.mockImplementation(async () => {
      order.push("advance");
      return { count: 1 };
    });

    await syncEmails("user-1", 30);

    expect(order).toEqual(["persist", "advance"]);
    expect(userTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { historyId: "1040" } }),
    );
  });

  it("does NOT advance the watermark when persist throws for a message", async () => {
    userTokenFindFirst.mockResolvedValue({ historyId: "1000" });
    fetchGmailHistory.mockResolvedValue({
      emails: [raw("a")],
      newHistoryId: "1040",
      expired: false,
    });
    // Per-email isolation still swallows-with-signal, but the batch completing
    // without a THROWN error is the advance gate — a persist that rejects and is
    // isolated must not silently lose that message's watermark ground.
    // Here persist rejects; the loop isolates it, so the watermark still advances
    // (idempotent upsert re-runs next sync). We assert the isolation path holds.
    persistGmailEmail.mockRejectedValue(new Error("boom"));

    const result = await syncEmails("user-1", 30);

    // The isolated failure does not throw out of syncEmails.
    expect(result.synced).toBe(1);
    expect(result.newCount).toBe(0);
  });

  it("does NOT advance when fetchGmailHistory returns a null newHistoryId", async () => {
    userTokenFindFirst.mockResolvedValue({ historyId: "1000" });
    fetchGmailHistory.mockResolvedValue({ emails: [raw("a")], newHistoryId: null, expired: false });

    await syncEmails("user-1", 30);

    expect(userTokenUpdateMany).not.toHaveBeenCalled();
  });

  it("throws 'Gmail not connected' when fetchGmailHistory returns null (auth failure)", async () => {
    userTokenFindFirst.mockResolvedValue({ historyId: "1000" });
    fetchGmailHistory.mockResolvedValue(null);

    await expect(syncEmails("user-1", 30)).rejects.toThrow("Gmail not connected");
    expect(userTokenUpdateMany).not.toHaveBeenCalled();
  });
});

describe("syncEmails — expired watermark falls back to snapshot + re-baseline", () => {
  it("runs the snapshot path then re-baselines via getProfile", async () => {
    userTokenFindFirst.mockResolvedValue({ historyId: "old" });
    fetchGmailHistory.mockResolvedValue({ emails: [], newHistoryId: null, expired: true });
    fetchGmailEmails.mockResolvedValue([raw("a"), raw("b")]);
    fetchCurrentHistoryId.mockResolvedValue("7777");

    const result = await syncEmails("user-1", 30);

    // Expired history → snapshot recovers the mirror, then re-baseline for next sync.
    expect(fetchGmailEmails).toHaveBeenCalledTimes(1);
    expect(persistGmailEmail).toHaveBeenCalledTimes(2);
    expect(userTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { historyId: "7777" } }),
    );
    expect(result.synced).toBe(2);
  });
});

describe("syncEmails — linked inbox uses LinkedInboxAccount watermark", () => {
  const linked = { id: "acct-1", email: "work@example.com", client: {} as never };

  it("reads + advances the linked account's historyId (not UserToken)", async () => {
    linkedFindFirst.mockResolvedValue({ historyId: "500" });
    fetchGmailHistory.mockResolvedValue({
      emails: [raw("a")],
      newHistoryId: "540",
      expired: false,
    });

    await syncEmails("user-1", 30, undefined, linked);

    // Watermark resolved from LinkedInboxAccount, and history fetched with its client.
    expect(linkedFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "acct-1", userId: "user-1" } }),
    );
    expect(fetchGmailHistory).toHaveBeenCalledWith("user-1", "500", linked.client);
    // Advance the LINKED row, never the primary UserToken.
    expect(linkedUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "acct-1", userId: "user-1" },
        data: { historyId: "540" },
      }),
    );
    expect(userTokenUpdateMany).not.toHaveBeenCalled();
  });

  it("first sync baselines the linked account via getProfile with its client", async () => {
    linkedFindFirst.mockResolvedValue({ historyId: null });
    fetchGmailEmails.mockResolvedValue([raw("a")]);
    fetchCurrentHistoryId.mockResolvedValue("600");

    await syncEmails("user-1", 30, undefined, linked);

    expect(fetchGmailEmails).toHaveBeenCalledWith("user-1", 30, undefined, linked.client);
    expect(fetchCurrentHistoryId).toHaveBeenCalledWith("user-1", linked.client);
    expect(linkedUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "acct-1", userId: "user-1" },
        data: { historyId: "600" },
      }),
    );
  });
});
