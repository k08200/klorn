/**
 * Re-ingested history after an IMAP UIDVALIDITY repair (step B2b of
 * docs/providers/unified-platform-plan.md): the rows that are stored and judged but
 * must not push, ring the urgent sweep or get an unattended reply.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

let db: FakeDb;

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => db);
  return { prisma, db: prisma };
});

const { findReingestedHistory, isReingestedHistory } = await import("../mail/imap-history.js");

const USER = "u1";
const RESET_AT = new Date("2026-09-30T10:05:00Z");
const BEFORE = new Date(RESET_AT.getTime() - 1);
const IMAP = "naver-imap:me@naver.com";

const row = (id: string, gmailId: string, receivedAt: Date, account: string | null = "acc-1") => ({
  id,
  gmailId,
  receivedAt,
  linkedInboxAccountId: account,
});

beforeEach(() => {
  db = createFakeDb({
    linkedInboxAccount: [
      {
        id: "acc-1",
        userId: USER,
        provider: "NAVER",
        email: "me@naver.com",
        inboxUidValidityResetAt: RESET_AT,
      },
      { id: "acc-2", userId: USER, provider: "NAVER", email: "two@naver.com" },
      {
        id: "acc-x",
        userId: "someone-else",
        provider: "NAVER",
        email: "x@naver.com",
        inboxUidValidityResetAt: RESET_AT,
      },
    ] as Row[],
  });
});

describe("isReingestedHistory", () => {
  it.each([
    ["an IMAP row received before the reset", row("a", `${IMAP}:1`, BEFORE), RESET_AT, true],
    [
      "an IMAP row received at the reset (during the hold)",
      row("a", `${IMAP}:1`, RESET_AT),
      RESET_AT,
      false,
    ],
    ["an IMAP row of an account never reset", row("a", `${IMAP}:1`, BEFORE), null, false],
    [
      "a tombstone, whatever its account",
      row("a", `${IMAP}:1#uv1000.17`, RESET_AT, null),
      null,
      true,
    ],
    ["a Gmail row, whatever the reset", row("a", "18abc", BEFORE), RESET_AT, false],
  ])("%s", (_name, r, resetAt, expected) => {
    expect(isReingestedHistory(r, resetAt)).toBe(expected);
  });
});

describe("findReingestedHistory", () => {
  it("reads nothing for Gmail and Outlook rows (the Gmail path is unchanged)", async () => {
    const found = await findReingestedHistory(USER, [
      row("g", "18abc", BEFORE, null),
      row("o", "AAMkAGI2THVSAAA=", BEFORE, "acc-1"),
    ]);

    expect(found).toEqual(new Set());
    expect(db.reads).toEqual([]);
  });

  it("looks the accounts up in ONE query, for this user only", async () => {
    const found = await findReingestedHistory(USER, [
      row("h1", `${IMAP}:1`, BEFORE),
      row("h2", `${IMAP}:2`, BEFORE),
      row("live", `${IMAP}:3`, RESET_AT),
      row("never-reset", "naver-imap:two@naver.com:1", BEFORE, "acc-2"),
      row("foreign", "naver-imap:x@naver.com:1", BEFORE, "acc-x"),
      row("no-account", `${IMAP}:4`, BEFORE, null),
      row("tomb", `${IMAP}:5#uv1000.17`, BEFORE, null),
    ]);

    expect([...found].sort()).toEqual(["h1", "h2", "tomb"]);
    expect(db.reads).toEqual(["linkedInboxAccount"]);
  });
});
