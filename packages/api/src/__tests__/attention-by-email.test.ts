/**
 * Done / Later keyed by the EmailMessage id (attention-by-email.ts). The mail
 * list knows an email id, not an attention id, and only OPEN items in the
 * firewall's newest-200 window carry one to a client. These pin:
 *   - the email row is resolved by id AND owner, from any inbox (primary or a
 *     linked one) — another user's id resolves to not_found and nothing runs;
 *   - an OPEN or SNOOZED item goes through the existing dismiss / snooze
 *     functions (so their learning side effects are unchanged);
 *   - an item already DISMISSED / RESOLVED, or mail that has no attention item
 *     yet, answers alreadyClear and creates or changes nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const emailFindFirst = vi.hoisted(() => vi.fn());
const attentionFindFirst = vi.hoisted(() => vi.fn());
const attentionCreate = vi.hoisted(() => vi.fn());
const attentionUpsert = vi.hoisted(() => vi.fn());
const dismissAttentionItem = vi.hoisted(() => vi.fn());
const snoozeAttentionItem = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = {
    emailMessage: { findFirst: emailFindFirst },
    attentionItem: {
      findFirst: attentionFindFirst,
      create: attentionCreate,
      upsert: attentionUpsert,
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../judge/attention-dismiss.js", () => ({ dismissAttentionItem }));
vi.mock("../judge/attention-snooze.js", () => ({ snoozeAttentionItem }));

const { dismissEmailAttention, snoozeEmailAttention } = await import(
  "../judge/attention-by-email.js"
);

const UNTIL = new Date("2030-01-01T09:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  emailFindFirst.mockResolvedValue({ id: "email-1" });
  attentionFindFirst.mockResolvedValue({ id: "item-1", status: "OPEN" });
  dismissAttentionItem.mockResolvedValue({ ok: true });
  snoozeAttentionItem.mockResolvedValue({ ok: true });
});

describe("ownership", () => {
  it("resolves the email by id and owner, with no inbox constraint (primary or linked)", async () => {
    await dismissEmailAttention("user-1", "email-1");
    expect(emailFindFirst).toHaveBeenCalledWith({
      where: { id: "email-1", userId: "user-1" },
      select: { id: true },
    });
    expect(attentionFindFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", source: "EMAIL", sourceId: "email-1" },
      select: { id: true, status: true },
    });
  });

  it("works for a row from a linked inbox — the lookup never filters by account", async () => {
    emailFindFirst.mockResolvedValue({ id: "email-linked", linkedInboxAccountId: "li-1" });
    const result = await dismissEmailAttention("user-1", "email-linked");
    expect(result).toEqual({ ok: true, itemId: "item-1", alreadyClear: false });
    const where = (emailFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).not.toHaveProperty("linkedInboxAccountId");
  });

  it("another user's (or an unknown) email id is not_found and nothing else runs", async () => {
    emailFindFirst.mockResolvedValue(null);
    expect(await dismissEmailAttention("user-1", "theirs")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await snoozeEmailAttention("user-1", "theirs", UNTIL)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(attentionFindFirst).not.toHaveBeenCalled();
    expect(dismissAttentionItem).not.toHaveBeenCalled();
    expect(snoozeAttentionItem).not.toHaveBeenCalled();
  });
});

describe("dismissEmailAttention (Done)", () => {
  it.each([
    "OPEN",
    "SNOOZED",
  ])("a %s item is dismissed through dismissAttentionItem", async (status) => {
    attentionFindFirst.mockResolvedValue({ id: "item-1", status });
    expect(await dismissEmailAttention("user-1", "email-1")).toEqual({
      ok: true,
      itemId: "item-1",
      alreadyClear: false,
    });
    expect(dismissAttentionItem).toHaveBeenCalledWith("user-1", "item-1");
  });

  it.each([
    "DISMISSED",
    "RESOLVED",
  ])("a %s item is already clear: no write, no learning signal", async (status) => {
    attentionFindFirst.mockResolvedValue({ id: "item-1", status });
    expect(await dismissEmailAttention("user-1", "email-1")).toEqual({
      ok: true,
      itemId: "item-1",
      alreadyClear: true,
    });
    expect(dismissAttentionItem).not.toHaveBeenCalled();
  });

  it("mail with no attention item yet creates nothing and answers alreadyClear", async () => {
    attentionFindFirst.mockResolvedValue(null);
    expect(await dismissEmailAttention("user-1", "email-1")).toEqual({
      ok: true,
      itemId: null,
      alreadyClear: true,
    });
    expect(dismissAttentionItem).not.toHaveBeenCalled();
    expect(attentionCreate).not.toHaveBeenCalled();
    expect(attentionUpsert).not.toHaveBeenCalled();
  });

  it("an item that vanished between lookup and write is not_found", async () => {
    dismissAttentionItem.mockResolvedValue({ ok: false, reason: "not_found" });
    expect(await dismissEmailAttention("user-1", "email-1")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("snoozeEmailAttention (Later)", () => {
  it.each([
    "OPEN",
    "SNOOZED",
  ])("a %s item is (re-)snoozed through snoozeAttentionItem", async (status) => {
    attentionFindFirst.mockResolvedValue({ id: "item-1", status });
    expect(await snoozeEmailAttention("user-1", "email-1", UNTIL)).toEqual({
      ok: true,
      itemId: "item-1",
      alreadyClear: false,
    });
    expect(snoozeAttentionItem).toHaveBeenCalledWith("user-1", "item-1", UNTIL);
  });

  it.each([
    "DISMISSED",
    "RESOLVED",
  ])("a %s item is never pulled back into SNOOZED", async (status) => {
    attentionFindFirst.mockResolvedValue({ id: "item-1", status });
    expect(await snoozeEmailAttention("user-1", "email-1", UNTIL)).toEqual({
      ok: true,
      itemId: "item-1",
      alreadyClear: true,
    });
    expect(snoozeAttentionItem).not.toHaveBeenCalled();
  });

  it("mail with no attention item yet creates nothing and answers alreadyClear", async () => {
    attentionFindFirst.mockResolvedValue(null);
    expect(await snoozeEmailAttention("user-1", "email-1", UNTIL)).toEqual({
      ok: true,
      itemId: null,
      alreadyClear: true,
    });
    expect(snoozeAttentionItem).not.toHaveBeenCalled();
    expect(attentionCreate).not.toHaveBeenCalled();
    expect(attentionUpsert).not.toHaveBeenCalled();
  });
});
