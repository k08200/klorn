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
  gmailId: string;
  userId: string;
  linkedInboxAccountId: string | null;
  receivedAt?: Date;
}
interface InboxRow {
  id: string;
  userId: string;
  provider: "GOOGLE" | "NAVER" | "ICLOUD" | "OUTLOOK" | "IMAP";
  needsReconnect: boolean;
  inboxUidValidityResetAt?: Date | null;
}
interface LedgerRow {
  userId: string;
  dedupeKey: string;
}

const fixtures = vi.hoisted(() => ({
  items: [] as ItemRow[],
  emails: [] as EmailRow[],
  inboxes: [] as InboxRow[],
  ledgers: [] as LedgerRow[],
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
      findMany: vi.fn(async (args: { where: { userId: string } }) =>
        fixtures.inboxes.filter((i) => i.userId === args.where.userId),
      ),
    },
    notification: {
      findMany: vi.fn(async (args: { where: { userId: string; dedupeKey: { in: string[] } } }) =>
        fixtures.ledgers.filter(
          (l) => l.userId === args.where.userId && args.where.dedupeKey.in.includes(l.dedupeKey),
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
  return { id: `row-${n}`, gmailId: `g-${n}`, userId, linkedInboxAccountId };
}
function inboxes(
  ...rows: InboxRow[]
): ReadonlyMap<string, { provider: string; needsReconnect: boolean }> {
  return new Map(
    rows.map((r) => [r.id, { provider: r.provider, needsReconnect: r.needsReconnect }]),
  );
}

beforeEach(() => {
  fixtures.items = [];
  fixtures.emails = [];
  fixtures.ledgers = [];
  fixtures.inboxes = [
    { id: "acc-google", userId: USER, provider: "GOOGLE", needsReconnect: false },
    { id: "acc-google-revoked", userId: USER, provider: "GOOGLE", needsReconnect: true },
    { id: "acc-naver", userId: USER, provider: "NAVER", needsReconnect: false },
    { id: "acc-icloud", userId: USER, provider: "ICLOUD", needsReconnect: false },
    { id: "acc-outlook", userId: USER, provider: "OUTLOOK", needsReconnect: false },
    { id: "acc-imap", userId: USER, provider: "IMAP", needsReconnect: false },
    {
      id: "acc-other-user-google",
      userId: "someone-else",
      provider: "GOOGLE",
      needsReconnect: false,
    },
  ];
  vi.clearAllMocks();
});

describe("canAutoSendFromMailbox (the named predicate)", () => {
  const linked = inboxes(
    { id: "acc-google", userId: USER, provider: "GOOGLE", needsReconnect: false },
    { id: "acc-google-revoked", userId: USER, provider: "GOOGLE", needsReconnect: true },
    { id: "acc-naver", userId: USER, provider: "NAVER", needsReconnect: false },
  );

  it("allows the primary account (no linked tag)", () => {
    expect(canAutoSendFromMailbox(null, linked)).toBe(true);
  });

  it("allows a connected linked GOOGLE inbox", () => {
    expect(canAutoSendFromMailbox("acc-google", linked)).toBe(true);
  });

  it("refuses a linked GOOGLE inbox flagged needsReconnect — its send can only fail", () => {
    expect(canAutoSendFromMailbox("acc-google-revoked", linked)).toBe(false);
  });

  it("refuses any non-Google linked account, and a stale tag for an unlinked inbox", () => {
    expect(canAutoSendFromMailbox("acc-naver", linked)).toBe(false);
    expect(canAutoSendFromMailbox("acc-unlinked-long-ago", linked)).toBe(false);
    expect(canAutoSendFromMailbox("acc-google", new Map())).toBe(false);
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

  it("never returns an item from a linked GOOGLE inbox that needs reconnect", async () => {
    fixtures.items = [item(1)];
    fixtures.emails = [email(1, "acc-google-revoked")];

    await expect(findAutoModeCandidates(USER, SINCE, 5)).resolves.toEqual([]);
  });

  it("excludes items whose mail already has an auto-mode or rule ledger, so ledger-failed items cannot starve sendable ones", async () => {
    // Six ledger-failed items (still OPEN, newest first) + one sendable item.
    fixtures.items = [item(1), item(2), item(3), item(4), item(5), item(6), item(7)];
    fixtures.emails = [1, 2, 3, 4, 5, 6, 7].map((n) => email(n, null));
    fixtures.ledgers = [
      { userId: USER, dedupeKey: "auto-mode-reply:g-1" },
      { userId: USER, dedupeKey: "auto-mode-reply:g-2" },
      { userId: USER, dedupeKey: "auto-mode-reply:g-3" },
      { userId: USER, dedupeKey: "auto-reply:g-4" },
      { userId: USER, dedupeKey: "auto-reply:g-5" },
      { userId: USER, dedupeKey: "auto-reply:g-6" },
    ];

    await expect(findAutoModeCandidates(USER, SINCE, 5)).resolves.toEqual([
      { id: "item-7", sourceId: "row-7" },
    ]);
  });

  it("ignores another user's ledger rows", async () => {
    fixtures.items = [item(1)];
    fixtures.emails = [email(1, null)];
    fixtures.ledgers = [{ userId: "someone-else", dedupeKey: "auto-mode-reply:g-1" }];

    await expect(findAutoModeCandidates(USER, SINCE, 5)).resolves.toHaveLength(1);
  });

  it("looks ledgers up by both key namespaces, scoped to this user", async () => {
    fixtures.items = [item(1)];
    fixtures.emails = [email(1, null)];

    await findAutoModeCandidates(USER, SINCE, 5);
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER, dedupeKey: { in: ["auto-reply:g-1", "auto-mode-reply:g-1"] } },
      }),
    );
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

  it("issues no email, ledger or inbox lookups when there are no items", async () => {
    await expect(findAutoModeCandidates(USER, SINCE, 5)).resolves.toEqual([]);
    expect(prisma.emailMessage.findMany).not.toHaveBeenCalled();
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
    expect(prisma.linkedInboxAccount.findMany).not.toHaveBeenCalled();
  });

  it("skips the linked-inbox lookup when every item is on the primary account", async () => {
    fixtures.items = [item(1)];
    fixtures.emails = [email(1, null)];

    await findAutoModeCandidates(USER, SINCE, 5);
    expect(prisma.linkedInboxAccount.findMany).not.toHaveBeenCalled();
  });

  it("scopes the linked-inbox lookup to this user", async () => {
    fixtures.items = [item(1)];
    fixtures.emails = [email(1, "acc-google")];

    await findAutoModeCandidates(USER, SINCE, 5);
    expect(prisma.linkedInboxAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER } }),
    );
  });
});

/**
 * Step B2b: rows re-ingested after an IMAP UIDVALIDITY repair, and the re-keyed
 * tombstones, are history and never get an unattended reply. Today no IMAP account
 * is sendable (canAutoSendFromMailbox), so the fixture pairs an IMAP id with a
 * sendable account to show the guard holds on its own, for the day IMAP mailboxes
 * become sendable.
 */
describe("re-ingested history after an IMAP repair (B2b)", () => {
  const RESET_AT = new Date("2026-09-30T10:00:00.000Z");
  const imapEmail = (n: number, gmailId: string, receivedAt: Date): EmailRow => ({
    id: `row-${n}`,
    gmailId,
    userId: USER,
    linkedInboxAccountId: "acc-google",
    receivedAt,
  });

  it("skips history and tombstones, keeps mail received during the hold", async () => {
    fixtures.inboxes = fixtures.inboxes.map((inbox) =>
      inbox.id === "acc-google" ? { ...inbox, inboxUidValidityResetAt: RESET_AT } : inbox,
    );
    fixtures.items = [item(1), item(2), item(3)];
    fixtures.emails = [
      imapEmail(1, "naver-imap:me@naver.com:1", new Date(RESET_AT.getTime() - 1)),
      imapEmail(2, "naver-imap:me@naver.com:2", RESET_AT),
      imapEmail(3, "naver-imap:me@naver.com:3#uv1000.1727690000000", RESET_AT),
    ];

    const found = await findAutoModeCandidates(USER, SINCE, 5);

    expect(found.map((c) => c.id)).toEqual(["item-2"]);
  });
});
