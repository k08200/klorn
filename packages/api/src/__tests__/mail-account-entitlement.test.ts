/**
 * Founder decision 2026-10-15 (LOCKED): a user's FIRST mailbox is free, whatever
 * the provider. Connecting a second one is Pro (multi_account). These tests pin
 * the one rule every connect route uses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ plan: "FREE", role: "USER" }));
const tokenFindFirst = vi.hoisted(() => vi.fn(async (_args?: unknown) => null as unknown));
const linkedFindFirst = vi.hoisted(() => vi.fn(async (_args?: unknown) => null as unknown));
const tokenDeleteMany = vi.hoisted(() => vi.fn(async (_args?: unknown) => ({ count: 1 })));
const linkedDeleteMany = vi.hoisted(() => vi.fn(async (_args?: unknown) => ({ count: 1 })));
const userFindUnique = vi.hoisted(() =>
  vi.fn(async (_args?: unknown) => ({ plan: state.plan, role: state.role }) as unknown),
);

vi.mock("../db.js", () => {
  const prisma = {
    user: { findUnique: userFindUnique },
    userToken: { findFirst: tokenFindFirst, deleteMany: tokenDeleteMany },
    linkedInboxAccount: { findFirst: linkedFindFirst, deleteMany: linkedDeleteMany },
  };
  return { prisma, db: prisma };
});

const ORIGINAL_PAYWALL = process.env.PAYWALL_ENABLED;

async function load(paywall: boolean) {
  if (paywall) process.env.PAYWALL_ENABLED = "true";
  else delete process.env.PAYWALL_ENABLED;
  vi.resetModules();
  return import("../billing/mail-account-entitlement.js");
}

const ICLOUD = { provider: "ICLOUD" as const, email: "me@icloud.com" };

beforeEach(() => {
  vi.clearAllMocks();
  state.plan = "FREE";
  state.role = "USER";
  tokenFindFirst.mockResolvedValue(null);
  linkedFindFirst.mockResolvedValue(null);
  userFindUnique.mockImplementation(async () => ({ plan: state.plan, role: state.role }));
});

afterEach(() => {
  if (ORIGINAL_PAYWALL === undefined) delete process.env.PAYWALL_ENABLED;
  else process.env.PAYWALL_ENABLED = ORIGINAL_PAYWALL;
  vi.resetModules();
});

describe("mayConnectMailAccount", () => {
  it("allows everything while the paywall is off, without reading the DB", async () => {
    const m = await load(false);
    tokenFindFirst.mockResolvedValue({ id: "t1" });
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(true);
    expect(userFindUnique).not.toHaveBeenCalled();
    expect(tokenFindFirst).not.toHaveBeenCalled();
  });

  it("allows a FREE user with no mail source at all (the first mailbox is free)", async () => {
    const m = await load(true);
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(true);
  });

  it("refuses a FREE user who already has a primary Google inbox", async () => {
    const m = await load(true);
    tokenFindFirst.mockResolvedValue({ id: "t1" });
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(false);
  });

  it("refuses a FREE user who already has another linked mailbox", async () => {
    const m = await load(true);
    linkedFindFirst.mockResolvedValue({ id: "naver-row" });
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(false);
  });

  it("excludes the SAME account from the count, so a FREE user can always repair it", async () => {
    const m = await load(true);
    await m.mayConnectMailAccount("user-1", ICLOUD);
    const where = (linkedFindFirst.mock.calls[0]?.[0] as { where: unknown }).where;
    expect(where).toEqual({
      userId: "user-1",
      NOT: { provider: "ICLOUD", email: "me@icloud.com" },
    });
  });

  it("scopes every lookup to the caller's userId", async () => {
    const m = await load(true);
    await m.mayConnectMailAccount("user-1", ICLOUD);
    expect(userFindUnique.mock.calls[0]?.[0]).toMatchObject({ where: { id: "user-1" } });
    expect(tokenFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: "user-1", provider: "google" },
    });
  });

  it("allows a PRO user with existing sources (multi_account)", async () => {
    state.plan = "PRO";
    const m = await load(true);
    tokenFindFirst.mockResolvedValue({ id: "t1" });
    linkedFindFirst.mockResolvedValue({ id: "row" });
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(true);
  });

  it("allows an ADMIN on the FREE plan (planHasFeature ADMIN bypass)", async () => {
    state.role = "ADMIN";
    const m = await load(true);
    tokenFindFirst.mockResolvedValue({ id: "t1" });
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(true);
  });

  it("treats a missing user as FREE (fails closed when a source exists)", async () => {
    userFindUnique.mockResolvedValue(null);
    const m = await load(true);
    tokenFindFirst.mockResolvedValue({ id: "t1" });
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(false);
  });

  it("propagates a DB failure instead of allowing", async () => {
    const m = await load(true);
    tokenFindFirst.mockRejectedValue(new Error("db down"));
    await expect(m.mayConnectMailAccount("user-1", ICLOUD)).rejects.toThrow("db down");
  });
});

describe("mayStartMailLink (OAuth start, address not known yet)", () => {
  it("ignores every row of the provider being linked (the callback re-checks exactly)", async () => {
    const m = await load(true);
    expect(await m.mayStartMailLink("user-1", "GOOGLE")).toBe(true);
    const where = (linkedFindFirst.mock.calls[0]?.[0] as { where: unknown }).where;
    expect(where).toEqual({ userId: "user-1", provider: { not: "GOOGLE" } });
  });

  it("refuses a FREE user whose primary Google inbox is their first mailbox", async () => {
    const m = await load(true);
    tokenFindFirst.mockResolvedValue({ id: "t1" });
    expect(await m.mayStartMailLink("user-1", "OUTLOOK")).toBe(false);
  });
});

describe("keepIfOnlyMailSource (check-after-insert race guard)", () => {
  const saved = { id: "new-row", ...ICLOUD };

  it("keeps the new row when it is the user's only mail source", async () => {
    const m = await load(true);
    expect(await m.keepIfOnlyMailSource("user-1", saved)).toBe(true);
    expect(linkedDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes the new row (scoped to the user) when another source appeared concurrently", async () => {
    const m = await load(true);
    linkedFindFirst.mockResolvedValue({ id: "parallel-row" });
    expect(await m.keepIfOnlyMailSource("user-1", saved)).toBe(false);
    expect(linkedDeleteMany).toHaveBeenCalledWith({ where: { id: "new-row", userId: "user-1" } });
  });

  it("never deletes for a PRO user", async () => {
    state.plan = "PRO";
    const m = await load(true);
    linkedFindFirst.mockResolvedValue({ id: "parallel-row" });
    expect(await m.keepIfOnlyMailSource("user-1", saved)).toBe(true);
    expect(linkedDeleteMany).not.toHaveBeenCalled();
  });

  it("never deletes while the paywall is off", async () => {
    const m = await load(false);
    linkedFindFirst.mockResolvedValue({ id: "parallel-row" });
    expect(await m.keepIfOnlyMailSource("user-1", saved)).toBe(true);
    expect(linkedDeleteMany).not.toHaveBeenCalled();
  });
});

describe("canConnectNewMailAccount (what the settings UI shows)", () => {
  it("is true for a FREE user with no source, false once one exists", async () => {
    const m = await load(true);
    expect(await m.canConnectNewMailAccount("user-1")).toBe(true);
    linkedFindFirst.mockResolvedValue({ id: "row" });
    expect(await m.canConnectNewMailAccount("user-1")).toBe(false);
  });

  it("is true for PRO and while the paywall is off", async () => {
    tokenFindFirst.mockResolvedValue({ id: "t1" });
    expect(await (await load(false)).canConnectNewMailAccount("user-1")).toBe(true);
    state.plan = "PRO";
    expect(await (await load(true)).canConnectNewMailAccount("user-1")).toBe(true);
  });
});

describe("primary Google slot (/google/start + integration callback)", () => {
  it("allows a FREE user with no linked mailbox (first connect or primary repair)", async () => {
    const m = await load(true);
    tokenFindFirst.mockResolvedValue({ id: "t1" }); // an existing primary is the same slot
    expect(await m.mayConnectPrimaryGoogle("user-1")).toBe(true);
    expect(linkedFindFirst.mock.calls[0]?.[0]).toMatchObject({ where: { userId: "user-1" } });
  });

  it("refuses a FREE user whose first mailbox is a linked one (iCloud, Naver, ...)", async () => {
    const m = await load(true);
    linkedFindFirst.mockResolvedValue({ id: "icloud-row" });
    expect(await m.mayConnectPrimaryGoogle("user-1")).toBe(false);
  });

  it("allows PRO and paywall-off regardless", async () => {
    linkedFindFirst.mockResolvedValue({ id: "icloud-row" });
    expect(await (await load(false)).mayConnectPrimaryGoogle("user-1")).toBe(true);
    state.plan = "PRO";
    expect(await (await load(true)).mayConnectPrimaryGoogle("user-1")).toBe(true);
  });

  it("check-after-write: removes a NEW primary token when a linked mailbox appeared", async () => {
    const m = await load(true);
    linkedFindFirst.mockResolvedValue({ id: "parallel-row" });
    expect(await m.keepPrimaryGoogleIfOnlyMailSource("user-1")).toBe(false);
    expect(tokenDeleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", provider: "google" },
    });
  });

  it("check-after-write keeps the token when it is the only source", async () => {
    const m = await load(true);
    expect(await m.keepPrimaryGoogleIfOnlyMailSource("user-1")).toBe(true);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
  });
});

describe("firstLinkedMailSourceId (which linked inbox a FREE user may sync)", () => {
  it("is the oldest linked row when there is no primary Google token", async () => {
    const m = await load(true);
    linkedFindFirst.mockResolvedValue({ id: "oldest" });
    expect(await m.firstLinkedMailSourceId("user-1")).toBe("oldest");
    expect(linkedFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: "user-1" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });

  it("is null when the primary Google token is the first mailbox", async () => {
    const m = await load(true);
    tokenFindFirst.mockResolvedValue({ id: "t1" });
    linkedFindFirst.mockResolvedValue({ id: "row" });
    expect(await m.firstLinkedMailSourceId("user-1")).toBeNull();
  });
});

describe("linkedInboxesToSync", () => {
  const inboxes = [{ id: "a" }, { id: "b" }];

  it("keeps every linked inbox with multi_account", async () => {
    const m = await load(true);
    expect(m.linkedInboxesToSync(inboxes, true, null)).toEqual(inboxes);
  });

  it("keeps only the first mailbox without multi_account", async () => {
    const m = await load(true);
    expect(m.linkedInboxesToSync(inboxes, false, "b")).toEqual([{ id: "b" }]);
  });

  it("keeps none without multi_account when the primary Google inbox is the first", async () => {
    const m = await load(true);
    expect(m.linkedInboxesToSync(inboxes, false, null)).toEqual([]);
  });
});
