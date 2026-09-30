/**
 * Which items the auto-mode sweep may answer unattended. Only mail that can
 * actually leave today qualifies: the primary Google account or a linked
 * GOOGLE inbox. NAVER / ICLOUD / OUTLOOK / IMAP rows are excluded until a
 * separate founder decision enables unattended replies from them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface ItemRow {
  id: string;
  sourceId: string;
}
interface EmailRow {
  id: string;
  userId: string;
  linkedInboxAccountId: string | null;
}
interface InboxRow {
  id: string;
  userId: string;
  provider: "GOOGLE" | "NAVER" | "ICLOUD" | "OUTLOOK" | "IMAP";
}

const fixtures = vi.hoisted(() => ({
  items: [] as ItemRow[],
  emails: [] as EmailRow[],
  inboxes: [] as InboxRow[],
}));

vi.mock("../db.js", () => ({
  prisma: {
    attentionItem: {
      findMany: vi.fn(async (args: { take: number }) => fixtures.items.slice(0, args.take)),
    },
    emailMessage: {
      findMany: vi.fn(async (args: { where: { userId: string; id: { in: string[] } } }) =>
        fixtures.emails.filter(
          (e) => e.userId === args.where.userId && args.where.id.in.includes(e.id),
        ),
      ),
    },
    linkedInboxAccount: {
      findMany: vi.fn(async (args: { where: { userId: string; provider: string } }) =>
        fixtures.inboxes.filter(
          (i) => i.userId === args.where.userId && i.provider === args.where.provider,
        ),
      ),
    },
  },
}));

import {
  AUTO_MODE_CANDIDATE_SCAN_MAX,
  canAutoSendFromMailbox,
  findAutoModeCandidates,
} from "../agentcore/auto-mode-candidates.js";
import { prisma } from "../db.js";

const USER = "u1";
const SINCE = new Date("2026-09-30T00:00:00.000Z");

function item(n: number): ItemRow {
  return { id: `item-${n}`, sourceId: `row-${n}` };
}
function email(n: number, linkedInboxAccountId: string | null, userId = USER): EmailRow {
  return { id: `row-${n}`, userId, linkedInboxAccountId };
}

beforeEach(() => {
  fixtures.items = [];
  fixtures.emails = [];
  fixtures.inboxes = [
    { id: "acc-google", userId: USER, provider: "GOOGLE" },
    { id: "acc-naver", userId: USER, provider: "NAVER" },
    { id: "acc-icloud", userId: USER, provider: "ICLOUD" },
    { id: "acc-outlook", userId: USER, provider: "OUTLOOK" },
    { id: "acc-imap", userId: USER, provider: "IMAP" },
    { id: "acc-other-user-google", userId: "someone-else", provider: "GOOGLE" },
  ];
  vi.clearAllMocks();
});

describe("canAutoSendFromMailbox (the named predicate)", () => {
  const googleIds = new Set(["acc-google"]);

  it("allows the primary account (no linked tag)", () => {
    expect(canAutoSendFromMailbox(null, googleIds)).toBe(true);
  });

  it("allows a linked GOOGLE inbox", () => {
    expect(canAutoSendFromMailbox("acc-google", googleIds)).toBe(true);
  });

  it("refuses any other linked account, including a stale tag for an unlinked inbox", () => {
    expect(canAutoSendFromMailbox("acc-naver", googleIds)).toBe(false);
    expect(canAutoSendFromMailbox("acc-unlinked-long-ago", googleIds)).toBe(false);
    expect(canAutoSendFromMailbox("acc-google", new Set())).toBe(false);
  });
});

describe("findAutoModeCandidates", () => {
  it("returns primary and linked-GOOGLE items, in the sweep's newest-first order", async () => {
    fixtures.items = [item(1), item(2)];
    fixtures.emails = [email(1, null), email(2, "acc-google")];

    await expect(findAutoModeCandidates(USER, SINCE, 5)).resolves.toEqual([
      { id: "item-1", sourceId: "row-1" },
      { id: "item-2", sourceId: "row-2" },
    ]);
  });

  it("never returns a NAVER-account item", async () => {
    fixtures.items = [item(1)];
    fixtures.emails = [email(1, "acc-naver")];

    await expect(findAutoModeCandidates(USER, SINCE, 5)).resolves.toEqual([]);
  });

  it.each([
    "acc-icloud",
    "acc-outlook",
    "acc-imap",
  ])("never returns an item from the non-Google linked account %s", async (accountId) => {
    fixtures.items = [item(1)];
    fixtures.emails = [email(1, accountId)];

    await expect(findAutoModeCandidates(USER, SINCE, 5)).resolves.toEqual([]);
  });

  it("fails closed on a stale linked tag (inbox unlinked, mail kept) — the send would fall back to the primary", async () => {
    fixtures.items = [item(1)];
    fixtures.emails = [email(1, "acc-unlinked-long-ago")];

    await expect(findAutoModeCandidates(USER, SINCE, 5)).resolves.toEqual([]);
  });

  it("never treats another user's Google linked account as sendable", async () => {
    fixtures.items = [item(1)];
    fixtures.emails = [email(1, "acc-other-user-google")];

    await expect(findAutoModeCandidates(USER, SINCE, 5)).resolves.toEqual([]);
  });

  it("drops an item whose email row is gone", async () => {
    fixtures.items = [item(1), item(2)];
    fixtures.emails = [email(2, null)];

    await expect(findAutoModeCandidates(USER, SINCE, 5)).resolves.toEqual([
      { id: "item-2", sourceId: "row-2" },
    ]);
  });

  it("applies `take` AFTER exclusion so excluded items cannot starve sendable ones", async () => {
    // Five newest items are NAVER; the only sendable item is the sixth.
    fixtures.items = [item(1), item(2), item(3), item(4), item(5), item(6)];
    fixtures.emails = [
      email(1, "acc-naver"),
      email(2, "acc-naver"),
      email(3, "acc-naver"),
      email(4, "acc-naver"),
      email(5, "acc-naver"),
      email(6, null),
    ];

    await expect(findAutoModeCandidates(USER, SINCE, 5)).resolves.toEqual([
      { id: "item-6", sourceId: "row-6" },
    ]);
  });

  it("honours `take` when more sendable items exist", async () => {
    fixtures.items = [item(1), item(2), item(3)];
    fixtures.emails = [email(1, null), email(2, null), email(3, null)];

    const result = await findAutoModeCandidates(USER, SINCE, 2);
    expect(result.map((r) => r.id)).toEqual(["item-1", "item-2"]);
  });

  it("keeps the original selection filter and bounds the scan", async () => {
    await findAutoModeCandidates(USER, SINCE, 5);

    expect(prisma.attentionItem.findMany).toHaveBeenCalledWith({
      where: {
        userId: USER,
        source: "EMAIL",
        status: "OPEN",
        autoEligible: true,
        tier: { in: ["QUEUE", "MEETING"] },
        isManualOverride: false,
        createdAt: { gte: SINCE },
      },
      orderBy: { createdAt: "desc" },
      take: AUTO_MODE_CANDIDATE_SCAN_MAX,
      select: { id: true, sourceId: true },
    });
  });

  it("issues no email or inbox lookups when there are no items", async () => {
    await expect(findAutoModeCandidates(USER, SINCE, 5)).resolves.toEqual([]);
    expect(prisma.emailMessage.findMany).not.toHaveBeenCalled();
    expect(prisma.linkedInboxAccount.findMany).not.toHaveBeenCalled();
  });

  it("skips the linked-inbox lookup when every item is on the primary account", async () => {
    fixtures.items = [item(1)];
    fixtures.emails = [email(1, null)];

    await findAutoModeCandidates(USER, SINCE, 5);
    expect(prisma.linkedInboxAccount.findMany).not.toHaveBeenCalled();
  });

  it("scopes the GOOGLE-inbox lookup to this user", async () => {
    fixtures.items = [item(1)];
    fixtures.emails = [email(1, "acc-google")];

    await findAutoModeCandidates(USER, SINCE, 5);
    expect(prisma.linkedInboxAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER, provider: "GOOGLE" } }),
    );
  });
});
