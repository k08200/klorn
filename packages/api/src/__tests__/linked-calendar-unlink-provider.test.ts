/**
 * C4: unlinkCalendarAccount serves more than one provider. Each caller names the
 * provider of the surface it belongs to, and the lookup and the delete are both
 * scoped by it, so a Google route can never remove an Outlook account by id and
 * vice versa. The events and their mirrored AttentionItems still go first, in
 * the same transaction, as for Google (see routes-auth-unlink-calendar.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  log: [] as string[],
  accountFindFirst: vi.fn(),
  accountDeleteMany: vi.fn(),
  eventFindMany: vi.fn(),
  eventDeleteMany: vi.fn(),
  attentionDeleteMany: vi.fn(),
  txStarts: 0,
}));

vi.mock("../db.js", () => {
  const log =
    (name: string, fn: (...a: never[]) => unknown) =>
    (...args: never[]) => {
      m.log.push(name);
      return fn(...args);
    };
  const tx = {
    linkedCalendarAccount: {
      findFirst: log("account.findFirst", m.accountFindFirst),
      deleteMany: log("account.deleteMany", m.accountDeleteMany),
    },
    calendarEvent: {
      findMany: log("event.findMany", m.eventFindMany),
      deleteMany: log("event.deleteMany", m.eventDeleteMany),
    },
    attentionItem: { deleteMany: log("attention.deleteMany", m.attentionDeleteMany) },
  };
  const prisma = {
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => {
      m.txStarts += 1;
      return cb(tx);
    },
  };
  return { prisma, db: prisma, INTERACTIVE_TX_OPTIONS: { maxWait: 1, timeout: 1 } };
});

import { unlinkCalendarAccount } from "../pim/linked-calendar-unlink.js";

beforeEach(() => {
  vi.clearAllMocks();
  m.log.length = 0;
  m.txStarts = 0;
  m.accountFindFirst.mockResolvedValue({ id: "acct-o" });
  m.accountDeleteMany.mockResolvedValue({ count: 1 });
  m.eventFindMany.mockResolvedValue([{ id: "ev-1" }, { id: "ev-2" }]);
  m.eventDeleteMany.mockResolvedValue({ count: 2 });
  m.attentionDeleteMany.mockResolvedValue({ count: 2 });
});

describe("unlinkCalendarAccount(userId, id, provider)", () => {
  it("unlinks an OUTLOOK account: events and attention items first, then the account, in one transaction", async () => {
    const removed = await unlinkCalendarAccount("u1", "acct-o", "OUTLOOK");

    expect(removed).toBe(true);
    expect(m.txStarts).toBe(1);
    expect(m.log).toEqual([
      "account.findFirst",
      "event.findMany",
      "attention.deleteMany",
      "event.deleteMany",
      "account.deleteMany",
    ]);
    expect(m.accountFindFirst).toHaveBeenCalledWith({
      where: { id: "acct-o", userId: "u1", provider: "OUTLOOK" },
      select: { id: true },
    });
    expect(m.attentionDeleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", source: "CALENDAR_EVENT", sourceId: { in: ["ev-1", "ev-2"] } },
    });
    expect(m.eventDeleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", sourceAccountId: "acct-o" },
    });
    expect(m.accountDeleteMany).toHaveBeenCalledWith({
      where: { id: "acct-o", userId: "u1", provider: "OUTLOOK" },
    });
  });

  it("defaults to GOOGLE, so the existing Google route is unchanged", async () => {
    await unlinkCalendarAccount("u1", "acct-g");

    expect(m.accountFindFirst).toHaveBeenCalledWith({
      where: { id: "acct-g", userId: "u1", provider: "GOOGLE" },
      select: { id: true },
    });
    expect(m.accountDeleteMany).toHaveBeenCalledWith({
      where: { id: "acct-g", userId: "u1", provider: "GOOGLE" },
    });
  });

  it("answers false and deletes nothing when the id is another provider's account", async () => {
    m.accountFindFirst.mockResolvedValue(null);

    const removed = await unlinkCalendarAccount("u1", "acct-g", "OUTLOOK");

    expect(removed).toBe(false);
    expect(m.eventFindMany).not.toHaveBeenCalled();
    expect(m.eventDeleteMany).not.toHaveBeenCalled();
    expect(m.attentionDeleteMany).not.toHaveBeenCalled();
    expect(m.accountDeleteMany).not.toHaveBeenCalled();
  });

  it("a concurrent unlink that got there first (delete count 0) answers false", async () => {
    m.accountDeleteMany.mockResolvedValue({ count: 0 });

    expect(await unlinkCalendarAccount("u1", "acct-o", "OUTLOOK")).toBe(false);
  });

  it("skips the attention-item delete when the account synced no events", async () => {
    m.eventFindMany.mockResolvedValue([]);

    expect(await unlinkCalendarAccount("u1", "acct-o", "OUTLOOK")).toBe(true);
    expect(m.attentionDeleteMany).not.toHaveBeenCalled();
  });
});
