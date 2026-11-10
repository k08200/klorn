/**
 * checkAutoReplyRules must only ever see reply-capable rules. A PIN_TIER
 * domain pin stores no condition key the matcher recognizes, and the matcher
 * treats an absent key as "unrestricted" — unfiltered, a single domain pin
 * would vacuously match EVERY email, shadow real AUTO_REPLY/DRAFT_REPLY
 * rules (first-match return over undefined row order), and corrupt its own
 * triggerCount. The fix is at the query: this function's job is reply rules,
 * so only reply rules may reach the loop.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type SeedRule = {
  id: string;
  name: string;
  actionType: string;
  actionValue: string;
  conditions: Record<string, unknown>;
};

const seeded = vi.hoisted(() => ({ rules: [] as SeedRule[] }));
const ruleFindMany = vi.hoisted(() => vi.fn());
const ruleUpdate = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../db.js", () => {
  const prisma = { emailRule: { findMany: ruleFindMany, update: ruleUpdate } };
  return { prisma, db: prisma };
});

import { checkAutoReplyRules } from "../mail/email-reply.js";

beforeEach(() => {
  ruleUpdate.mockClear();
  ruleFindMany.mockReset();
  // Honor the where clause the code sends: the mock must not hand back rows
  // a real Prisma query would have excluded, or the test proves nothing.
  ruleFindMany.mockImplementation((args: { where?: { actionType?: { in?: string[] } } }) => {
    const allowed = args?.where?.actionType?.in;
    return Promise.resolve(
      allowed ? seeded.rules.filter((r) => allowed.includes(r.actionType)) : seeded.rules,
    );
  });
  seeded.rules = [
    // A domain pin lists FIRST so an unfiltered query would return it as the
    // first vacuous match.
    {
      id: "pin-1",
      name: "Pin: @acme.com",
      actionType: "PIN_TIER",
      actionValue: "SILENT",
      conditions: { fromDomain: ["acme.com"] },
    },
    {
      id: "reply-1",
      name: "Boss auto-reply",
      actionType: "AUTO_REPLY",
      actionValue: "On it.",
      conditions: { from: ["boss@acme.com"] },
    },
  ];
});

describe("checkAutoReplyRules — reply rules only", () => {
  it("returns the real AUTO_REPLY rule, never the domain pin, for a matching sender", async () => {
    const matched = await checkAutoReplyRules("u1", {
      from: "Boss <boss@acme.com>",
      subject: "hi",
    });
    expect(matched?.ruleId).toBe("reply-1");
  });

  it("matches nothing for an unrelated sender (the domain pin must not vacuously match)", async () => {
    const matched = await checkAutoReplyRules("u1", {
      from: "stranger@other.com",
      subject: "hi",
    });
    expect(matched).toBeNull();
    expect(ruleUpdate).not.toHaveBeenCalled();
  });

  it("asks the DB for reply-capable actionTypes only", async () => {
    await checkAutoReplyRules("u1", { from: "a@b.com", subject: "s" });
    expect(ruleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          actionType: { in: ["AUTO_REPLY", "DRAFT_REPLY"] },
        }),
      }),
    );
  });
});

describe("checkAutoReplyRules — sender conditions", () => {
  it("never matches an AUTO_REPLY rule that names no sender", async () => {
    seeded.rules = [
      {
        id: "r1",
        name: "everyone",
        actionType: "AUTO_REPLY",
        actionValue: "hi",
        conditions: { subjectContains: ["invoice"] },
      },
    ];
    expect(
      await checkAutoReplyRules("u1", { from: "a@b.example", subject: "Invoice 42" }),
    ).toBeNull();
  });

  it("does not fire on a display name that spells the rule's address", async () => {
    seeded.rules = [
      {
        id: "r1",
        name: "boss",
        actionType: "AUTO_REPLY",
        actionValue: "hi",
        conditions: { from: ["boss@company.com"] },
      },
    ];
    expect(
      await checkAutoReplyRules("u1", {
        from: '"boss@company.com" <attacker@evil.com>',
        subject: "x",
      }),
    ).toBeNull();
    expect(
      await checkAutoReplyRules("u1", { from: "Boss <boss@company.com>", subject: "x" }),
    ).not.toBeNull();
  });
});
