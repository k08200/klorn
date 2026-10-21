/**
 * Which linked Google inboxes a sync pass may touch — the same billing rule as
 * connecting them: paywall off or multi_account → all; otherwise only the
 * user's first mailbox when it is a linked row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tokenFindFirst = vi.hoisted(() => vi.fn(async (_a?: unknown) => null as unknown));
const linkedFindFirst = vi.hoisted(() => vi.fn(async (_a?: unknown) => null as unknown));

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: tokenFindFirst },
    linkedInboxAccount: { findFirst: linkedFindFirst },
  };
  return { prisma, db: prisma };
});

const ORIGINAL_PAYWALL = process.env.PAYWALL_ENABLED;

async function load(paywall: boolean) {
  if (paywall) process.env.PAYWALL_ENABLED = "true";
  else delete process.env.PAYWALL_ENABLED;
  vi.resetModules();
  return import("../billing/mail-sync-scope.js");
}

const inboxes = [{ id: "a" }, { id: "b" }];

beforeEach(() => {
  vi.clearAllMocks();
  tokenFindFirst.mockResolvedValue(null);
  linkedFindFirst.mockResolvedValue(null);
});

afterEach(() => {
  if (ORIGINAL_PAYWALL === undefined) delete process.env.PAYWALL_ENABLED;
  else process.env.PAYWALL_ENABLED = ORIGINAL_PAYWALL;
  vi.resetModules();
});

describe("syncsEveryLinkedInbox", () => {
  it("is true while the paywall is off, for every plan (same as connect)", async () => {
    const m = await load(false);
    expect(m.syncsEveryLinkedInbox("FREE", "USER")).toBe(true);
  });

  it("follows multi_account when the paywall is on", async () => {
    const m = await load(true);
    expect(m.syncsEveryLinkedInbox("FREE", "USER")).toBe(false);
    expect(m.syncsEveryLinkedInbox("PRO", "USER")).toBe(true);
    expect(m.syncsEveryLinkedInbox("FREE", "ADMIN")).toBe(true);
  });
});

describe("firstLinkedMailSourceId", () => {
  it("is the oldest linked row when there is no primary Google token", async () => {
    const m = await load(true);
    linkedFindFirst.mockResolvedValue({ id: "oldest" });
    expect(await m.firstLinkedMailSourceId("user-1")).toBe("oldest");
    expect(linkedFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: "user-1" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });

  it("leaves the Klorn address out: it is part of the account, not the first mailbox (E1a)", async () => {
    const m = await load(true);
    linkedFindFirst.mockResolvedValue({ id: "oldest" });
    await m.firstLinkedMailSourceId("user-1");
    expect(linkedFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: "user-1", provider: { not: "KLORN" } },
    });
  });

  it("is null when the primary Google token is the first mailbox", async () => {
    const m = await load(true);
    tokenFindFirst.mockResolvedValue({ id: "t1" });
    linkedFindFirst.mockResolvedValue({ id: "row" });
    expect(await m.firstLinkedMailSourceId("user-1")).toBeNull();
  });
});

describe("scopeLinkedInboxes", () => {
  it("keeps every inbox with multi_account, without a lookup", async () => {
    const m = await load(true);
    expect(await m.scopeLinkedInboxes("user-1", "PRO", "USER", inboxes)).toEqual(inboxes);
    expect(linkedFindFirst).not.toHaveBeenCalled();
  });

  it("keeps only the first mailbox on FREE", async () => {
    const m = await load(true);
    linkedFindFirst.mockResolvedValue({ id: "b" });
    expect(await m.scopeLinkedInboxes("user-1", "FREE", "USER", inboxes)).toEqual([{ id: "b" }]);
  });

  it("keeps none on FREE when the primary Google inbox is the first", async () => {
    const m = await load(true);
    tokenFindFirst.mockResolvedValue({ id: "t1" });
    linkedFindFirst.mockResolvedValue({ id: "a" });
    expect(await m.scopeLinkedInboxes("user-1", "FREE", "USER", inboxes)).toEqual([]);
  });

  it("keeps every inbox on FREE while the paywall is off", async () => {
    const m = await load(false);
    expect(await m.scopeLinkedInboxes("user-1", "FREE", "USER", inboxes)).toEqual(inboxes);
  });
});
