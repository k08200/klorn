/**
 * C7: a linked calendar's row carries the account's email as `sourceLabel`, so a
 * client can say which account an event comes from. One lookup for all rows, and
 * none at all when no row is linked (the primary calendar's JSON stays byte-identical).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("../db.js", () => {
  const prisma = { linkedCalendarAccount: { findMany: m.findMany } };
  return { prisma, db: prisma };
});

import { withSourceLabels } from "../pim/calendar-source-label.js";

const primary = { id: "p", title: "Primary", sourceAccountId: null };
const linkedA = { id: "a", title: "A", sourceAccountId: "acct-1", readOnly: true as const };
const linkedB = { id: "b", title: "B", sourceAccountId: "acct-2", readOnly: true as const };

beforeEach(() => {
  m.findMany.mockReset();
  m.findMany.mockResolvedValue([]);
});

describe("withSourceLabels", () => {
  it("does no lookup and returns the same rows when none is linked", async () => {
    const rows = [primary, { ...primary, id: "p2" }];

    const out = await withSourceLabels("u1", rows);

    expect(m.findMany).not.toHaveBeenCalled();
    expect(out).toEqual(rows);
    expect(JSON.stringify(out)).toBe(JSON.stringify(rows));
  });

  it("labels linked rows with the account email and leaves other rows untouched", async () => {
    m.findMany.mockResolvedValue([
      { id: "acct-1", email: "work@company.com" },
      { id: "acct-2", email: "team@other.org" },
    ]);

    const out = await withSourceLabels("u1", [linkedA, primary, linkedB]);

    expect(out).toEqual([
      { ...linkedA, sourceLabel: "work@company.com" },
      primary,
      { ...linkedB, sourceLabel: "team@other.org" },
    ]);
    expect("sourceLabel" in (out[1] ?? {})).toBe(false);
  });

  it("asks once, for this user's accounts and the distinct ids only, reading nothing but the label", async () => {
    await withSourceLabels("u1", [linkedA, { ...linkedA, id: "a2" }, linkedB]);

    expect(m.findMany).toHaveBeenCalledTimes(1);
    expect(m.findMany.mock.calls[0]?.[0]).toEqual({
      where: { userId: "u1", id: { in: ["acct-1", "acct-2"] } },
      select: { id: true, email: true, displayName: true },
    });
  });

  it("labels a device calendar's row with the calendar's title, never its device key (C6)", async () => {
    m.findMany.mockResolvedValue([
      { id: "acct-1", email: `device:${"a".repeat(64)}`, displayName: "Family" },
      { id: "acct-2", email: "team@other.org", displayName: null },
    ]);

    const out = await withSourceLabels("u1", [linkedA, linkedB]);

    expect(out[0]).toHaveProperty("sourceLabel", "Family");
    expect(out[1]).toHaveProperty("sourceLabel", "team@other.org");
    expect(JSON.stringify(out)).not.toContain("device:");
  });

  it("a device calendar with no title stored is labelled with nothing, never with its key", async () => {
    m.findMany.mockResolvedValue([
      { id: "acct-1", email: `device:${"a".repeat(64)}`, displayName: null },
    ]);

    const out = await withSourceLabels("u1", [linkedA]);

    expect("sourceLabel" in (out[0] ?? {})).toBe(false);
  });

  it("leaves a row unlabelled when its account is gone (the client falls back to 'Linked')", async () => {
    m.findMany.mockResolvedValue([{ id: "acct-1", email: "work@company.com" }]);

    const out = await withSourceLabels("u1", [linkedA, linkedB]);

    expect(out[0]).toHaveProperty("sourceLabel", "work@company.com");
    expect("sourceLabel" in (out[1] ?? {})).toBe(false);
  });

  it("never fails the list because the label lookup failed", async () => {
    m.findMany.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await withSourceLabels("u1", [linkedA, primary]);

    expect(out).toEqual([linkedA, primary]);
    warn.mockRestore();
  });

  it("does not mutate its input", async () => {
    m.findMany.mockResolvedValue([{ id: "acct-1", email: "work@company.com" }]);
    const input = [{ ...linkedA }];

    await withSourceLabels("u1", input);

    expect(input[0]).toEqual(linkedA);
  });
});
