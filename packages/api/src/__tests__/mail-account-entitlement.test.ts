/**
 * Founder decision 2026-10-15 (LOCKED): a user's FIRST mailbox is free, whatever
 * the provider. Connecting a second one is Pro (multi_account). Re-connecting a
 * mailbox the user already owns is never gated. These tests pin the one rule
 * every connect route uses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Where = Record<string, unknown>;

const state = vi.hoisted(() => ({
  plan: "FREE",
  role: "USER",
  primary: false,
  /** Rows the user owns: { provider, email }. */
  rows: [] as Array<{ id: string; provider: string; email: string }>,
}));
const captureError = vi.hoisted(() => vi.fn());
const tokenFindFirst = vi.hoisted(() =>
  vi.fn(async (_args?: unknown) => (state.primary ? { id: "t1" } : null) as unknown),
);
const tokenDeleteMany = vi.hoisted(() => vi.fn(async (_args?: unknown) => ({ count: 1 })));
const linkedDeleteMany = vi.hoisted(() => vi.fn(async (_args?: unknown) => ({ count: 1 })));
const userFindUnique = vi.hoisted(() =>
  vi.fn(async (_args?: unknown) => ({ plan: state.plan, role: state.role }) as unknown),
);

/** A tiny evaluator for the filters this module builds. */
function matches(row: { provider: string; email: string }, where: Where): boolean {
  if (where.NOT && matches(row, where.NOT as Where)) return false;
  const provider = where.provider as unknown;
  if (typeof provider === "string" && row.provider !== provider) return false;
  if (provider && typeof provider === "object" && "not" in provider) {
    if (row.provider === (provider as { not: string }).not) return false;
  }
  if (provider && typeof provider === "object" && "notIn" in provider) {
    if ((provider as { notIn: string[] }).notIn.includes(row.provider)) return false;
  }
  const email = where.email as { equals?: string; mode?: string } | undefined;
  if (email?.equals !== undefined && row.email.toLowerCase() !== email.equals.toLowerCase()) {
    return false;
  }
  return true;
}
const linkedFindFirst = vi.hoisted(() =>
  vi.fn(async (args?: unknown) => {
    const where = (args as { where: Where }).where;
    const { userId: _userId, ...rest } = where;
    return state.rows.find((r) => matches(r, rest)) ?? null;
  }),
);

vi.mock("../db.js", () => {
  const prisma = {
    user: { findUnique: userFindUnique },
    userToken: { findFirst: tokenFindFirst, deleteMany: tokenDeleteMany },
    linkedInboxAccount: { findFirst: linkedFindFirst, deleteMany: linkedDeleteMany },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError }));

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
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.plan = "FREE";
  state.role = "USER";
  state.primary = false;
  state.rows = [];
  userFindUnique.mockImplementation(async () => ({ plan: state.plan, role: state.role }));
  tokenFindFirst.mockImplementation(async () => (state.primary ? { id: "t1" } : null));
});

afterEach(() => {
  if (ORIGINAL_PAYWALL === undefined) delete process.env.PAYWALL_ENABLED;
  else process.env.PAYWALL_ENABLED = ORIGINAL_PAYWALL;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("mayConnectMailAccount", () => {
  it("allows everything while the paywall is off, without reading the DB", async () => {
    const m = await load(false);
    state.primary = true;
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(true);
    expect(userFindUnique).not.toHaveBeenCalled();
    expect(linkedFindFirst).not.toHaveBeenCalled();
  });

  it("allows a FREE user with no mail source at all (the first mailbox is free)", async () => {
    const m = await load(true);
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(true);
  });

  it("refuses a FREE user who already has a primary Google inbox", async () => {
    const m = await load(true);
    state.primary = true;
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(false);
  });

  it("refuses a FREE user who already has another linked mailbox (even one needing reconnect)", async () => {
    const m = await load(true);
    state.rows = [{ id: "naver-row", provider: "NAVER", email: "me@naver.com" }];
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(false);
  });

  it("always allows re-connecting an account the user already owns, even with other sources", async () => {
    const m = await load(true);
    state.primary = true;
    state.rows = [
      { id: "icloud-row", provider: "ICLOUD", email: "me@icloud.com" },
      { id: "naver-row", provider: "NAVER", email: "me@naver.com" },
    ];
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(true);
  });

  it("compares the email trimmed and case-insensitively", async () => {
    const m = await load(true);
    state.rows = [{ id: "icloud-row", provider: "ICLOUD", email: "Me@iCloud.com" }];
    state.primary = true;
    expect(await m.mayConnectMailAccount("user-1", { ...ICLOUD, email: "  ME@icloud.COM " })).toBe(
      true,
    );
  });

  it("does not treat the same address on ANOTHER provider as owned", async () => {
    const m = await load(true);
    state.rows = [{ id: "imap-row", provider: "IMAP", email: "me@icloud.com" }];
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(false);
  });

  it("scopes every lookup to the caller's userId", async () => {
    const m = await load(true);
    await m.mayConnectMailAccount("user-1", ICLOUD);
    expect(userFindUnique.mock.calls[0]?.[0]).toMatchObject({ where: { id: "user-1" } });
    expect(tokenFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: "user-1", provider: "google" },
    });
    for (const call of linkedFindFirst.mock.calls) {
      expect(call[0]).toMatchObject({ where: { userId: "user-1" } });
    }
  });

  it("allows a PRO user with existing sources (multi_account)", async () => {
    state.plan = "PRO";
    const m = await load(true);
    state.primary = true;
    state.rows = [{ id: "row", provider: "NAVER", email: "x@naver.com" }];
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(true);
  });

  it("allows an ADMIN on the FREE plan (planHasFeature ADMIN bypass)", async () => {
    state.role = "ADMIN";
    const m = await load(true);
    state.primary = true;
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(true);
  });

  it("treats a missing user as FREE (fails closed when a source exists)", async () => {
    userFindUnique.mockResolvedValue(null);
    const m = await load(true);
    state.primary = true;
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
  });

  it("refuses a FREE user whose primary Google inbox is their first mailbox", async () => {
    const m = await load(true);
    state.primary = true;
    expect(await m.mayStartMailLink("user-1", "OUTLOOK")).toBe(false);
  });

  it("lets a FREE user who owns a row of that provider start (it may be a repair)", async () => {
    const m = await load(true);
    state.primary = true;
    state.rows = [{ id: "o", provider: "OUTLOOK", email: "me@outlook.com" }];
    expect(await m.mayStartMailLink("user-1", "OUTLOOK")).toBe(true);
  });
});

describe("keepIfOnlyMailSource (check-after-insert race guard)", () => {
  const saved = { id: "new-row", ...ICLOUD };

  it("keeps the new row when it is the user's only mail source", async () => {
    const m = await load(true);
    state.rows = [{ id: "new-row", provider: "ICLOUD", email: "me@icloud.com" }];
    expect(await m.keepIfOnlyMailSource("user-1", saved)).toBe(true);
    expect(linkedDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes the new row (scoped to the user) when another source appeared concurrently", async () => {
    const m = await load(true);
    state.rows = [
      { id: "new-row", provider: "ICLOUD", email: "me@icloud.com" },
      { id: "parallel-row", provider: "NAVER", email: "me@naver.com" },
    ];
    expect(await m.keepIfOnlyMailSource("user-1", saved)).toBe(false);
    expect(linkedDeleteMany).toHaveBeenCalledWith({ where: { id: "new-row", userId: "user-1" } });
  });

  it("fails closed when the re-check throws: deletes the row, refuses, reports", async () => {
    const m = await load(true);
    tokenFindFirst.mockRejectedValue(new Error("db blip"));
    expect(await m.keepIfOnlyMailSource("user-1", saved)).toBe(false);
    expect(linkedDeleteMany).toHaveBeenCalledWith({ where: { id: "new-row", userId: "user-1" } });
    expect(captureError).toHaveBeenCalled();
  });

  it("still refuses (and reports) when the rollback delete throws too", async () => {
    const m = await load(true);
    tokenFindFirst.mockRejectedValue(new Error("db blip"));
    linkedDeleteMany.mockRejectedValueOnce(new Error("db still down"));
    expect(await m.keepIfOnlyMailSource("user-1", saved)).toBe(false);
    expect(captureError).toHaveBeenCalledTimes(2);
  });

  it("never deletes for a PRO user", async () => {
    state.plan = "PRO";
    const m = await load(true);
    state.rows = [{ id: "parallel-row", provider: "NAVER", email: "me@naver.com" }];
    expect(await m.keepIfOnlyMailSource("user-1", saved)).toBe(true);
    expect(linkedDeleteMany).not.toHaveBeenCalled();
  });

  it("never deletes while the paywall is off", async () => {
    const m = await load(false);
    state.rows = [{ id: "parallel-row", provider: "NAVER", email: "me@naver.com" }];
    expect(await m.keepIfOnlyMailSource("user-1", saved)).toBe(true);
    expect(linkedDeleteMany).not.toHaveBeenCalled();
  });
});

describe("canConnectNewMailAccount (what the settings UI shows)", () => {
  it("is true for a FREE user with no source, false once one exists", async () => {
    const m = await load(true);
    expect(await m.canConnectNewMailAccount("user-1")).toBe(true);
    state.rows = [{ id: "row", provider: "NAVER", email: "me@naver.com" }];
    expect(await m.canConnectNewMailAccount("user-1")).toBe(false);
  });

  it("is true for PRO and while the paywall is off", async () => {
    state.primary = true;
    expect(await (await load(false)).canConnectNewMailAccount("user-1")).toBe(true);
    state.plan = "PRO";
    expect(await (await load(true)).canConnectNewMailAccount("user-1")).toBe(true);
  });
});

describe("primary Google slot (/google/start + integration callback)", () => {
  it("allows a FREE user with no linked mailbox (a first connect)", async () => {
    const m = await load(true);
    expect(await m.mayConnectPrimaryGoogle("user-1")).toBe(true);
  });

  it("always allows repairing an existing primary token, even with linked rows", async () => {
    const m = await load(true);
    state.primary = true;
    state.rows = [{ id: "icloud-row", provider: "ICLOUD", email: "me@icloud.com" }];
    expect(await m.mayConnectPrimaryGoogle("user-1")).toBe(true);
  });

  it("refuses a FREE user whose first mailbox is a linked one (iCloud, Naver, ...)", async () => {
    const m = await load(true);
    state.rows = [{ id: "icloud-row", provider: "ICLOUD", email: "me@icloud.com" }];
    expect(await m.mayConnectPrimaryGoogle("user-1")).toBe(false);
  });

  it("allows PRO and paywall-off regardless", async () => {
    state.rows = [{ id: "icloud-row", provider: "ICLOUD", email: "me@icloud.com" }];
    expect(await (await load(false)).mayConnectPrimaryGoogle("user-1")).toBe(true);
    state.plan = "PRO";
    expect(await (await load(true)).mayConnectPrimaryGoogle("user-1")).toBe(true);
  });

  it("check-after-write: deletes exactly the NEW token, by id, when a linked mailbox appeared", async () => {
    const m = await load(true);
    state.primary = true; // the token this request just wrote
    state.rows = [{ id: "parallel-row", provider: "ICLOUD", email: "me@icloud.com" }];
    expect(await m.keepPrimaryGoogleIfOnlyMailSource("user-1", "tok-new")).toBe(false);
    expect(tokenDeleteMany).toHaveBeenCalledWith({ where: { id: "tok-new", userId: "user-1" } });
  });

  it("check-after-write keeps the token when it is the only source", async () => {
    const m = await load(true);
    state.primary = true;
    expect(await m.keepPrimaryGoogleIfOnlyMailSource("user-1", "tok-new")).toBe(true);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
  });

  it("check-after-write fails closed on a throw", async () => {
    const m = await load(true);
    linkedFindFirst.mockRejectedValueOnce(new Error("db blip"));
    expect(await m.keepPrimaryGoogleIfOnlyMailSource("user-1", "tok-new")).toBe(false);
    expect(tokenDeleteMany).toHaveBeenCalledWith({ where: { id: "tok-new", userId: "user-1" } });
    expect(captureError).toHaveBeenCalled();
  });
});

describe("the Klorn address (step E1a): part of the account, not a mail source", () => {
  const KLORN_ROW = { id: "klorn-row", provider: "KLORN", email: "me@klorn.ai" };

  it("does not take the free account slot", async () => {
    const m = await load(true);
    state.rows = [KLORN_ROW];
    expect(await m.canConnectNewMailAccount("user-1")).toBe(true);
    expect(await m.mayConnectMailAccount("user-1", ICLOUD)).toBe(true);
    expect(await m.mayStartMailLink("user-1", "OUTLOOK")).toBe(true);
    expect(await m.mayConnectPrimaryGoogle("user-1")).toBe(true);
  });

  it("never rolls back a free user's first real mailbox because of the Klorn address", async () => {
    const m = await load(true);
    state.rows = [KLORN_ROW, { id: "new-row", provider: "ICLOUD", email: "me@icloud.com" }];
    expect(await m.keepIfOnlyMailSource("user-1", { id: "new-row", ...ICLOUD })).toBe(true);
    expect(linkedDeleteMany).not.toHaveBeenCalled();
    state.rows = [KLORN_ROW];
    state.primary = true;
    expect(await m.keepPrimaryGoogleIfOnlyMailSource("user-1", "t1")).toBe(true);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
  });

  it("leaves every other mailbox counted as before", async () => {
    const m = await load(true);
    state.rows = [KLORN_ROW, { id: "icloud-row", provider: "ICLOUD", email: "me@icloud.com" }];
    expect(await m.canConnectNewMailAccount("user-1")).toBe(false);
    expect(await m.mayConnectPrimaryGoogle("user-1")).toBe(false);
    expect(await m.mayStartMailLink("user-1", "OUTLOOK")).toBe(false);
  });
});
