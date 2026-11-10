/**
 * The B2b protections (docs/providers/unified-platform-plan.md, step B2b) key on
 * "is this stored message id an IMAP id?" (`isImapMessageId`). That list is DERIVED
 * from the provider registry, so the generic provider (step B4, ids
 * `generic-imap:<email>:<uid>`) is covered the moment it is registered, with no second
 * list to forget. These pin that, at the level of the primitives, and that Gmail and
 * Outlook ids stay outside every one of them:
 *   - the detection itself, tombstones included;
 *   - the re-ingested-history cutoff and its lookup;
 *   - the PUSH and urgent-sweep dedupe floors (`markerCountsFor`, `urgentDedupeKey`).
 * The end-to-end behaviour (the poll, the repair, the sweeps, the firewall) runs for a
 * generic mailbox in imap-generic-reset.test.ts and, parameterised over a generic id
 * head, in firewall-push-imap-dedupe, automation-urgent-sweep-history and
 * auto-mode-candidates.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

let db: FakeDb;

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => db);
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { findReingestedHistory, findReingestedHistoryFailClosed, isReingestedHistory } =
  await import("../mail/imap-history.js");
const { formatImapMessageId, imapMessageIdHead, isImapMessageId } = await import(
  "../mail/imap-message-id.js"
);
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { isTombstonedId, tombstoneSuffix } = await import("../mail/imap-tombstone.js");
const { markerCountsFor, unnotifiedEmails, urgentDedupeKey } = await import(
  "../notify/urgent-dedup.js"
);

const USER = "u1";
const GENERIC_HEAD = "generic-imap:me@example.com";
const GENERIC_ID = `${GENERIC_HEAD}:101`;
const TOMBSTONE = `${GENERIC_ID}${tombstoneSuffix("1000", new Date("2026-09-30T10:05:00Z"))}`;
const GMAIL_ID = "18c2f0a1b2c3d4e5";
const OUTLOOK_ID = "outlook:me@outlook.com:AAMkAGI2THVSAAA=";

const RESET_AT = new Date("2026-09-30T10:05:00Z");
const BEFORE = new Date(RESET_AT.getTime() - 1);

describe("isImapMessageId covers every registered IMAP provider, generic included", () => {
  it("the generic provider's ids are IMAP ids, a tombstone of one too", () => {
    expect(isImapMessageId(GENERIC_ID)).toBe(true);
    expect(isImapMessageId(TOMBSTONE)).toBe(true);
    expect(isImapMessageId(formatImapMessageId("generic-imap", "me@example.com", 7))).toBe(true);
    expect(isTombstonedId(TOMBSTONE)).toBe(true);
    expect(isTombstonedId(GENERIC_ID)).toBe(false);
  });

  it.each(
    Object.values(IMAP_PROVIDERS).map((p) => [p.provider, p.idPrefix] as const),
  )("%s (%s): the id the poll writes is recognised, so a provider added to the registry needs no second list", (_provider, idPrefix) => {
    expect(isImapMessageId(formatImapMessageId(idPrefix, "me@example.com", 1))).toBe(true);
    expect(isImapMessageId(`${imapMessageIdHead(idPrefix, "me@example.com")}9#uv1.2`)).toBe(true);
  });

  it.each([
    ["a Gmail id", GMAIL_ID],
    ["an Outlook id", OUTLOOK_ID],
    ["an empty id", ""],
    ["the prefix without its colon", "generic-imap"],
    ["a prefix inside another word", "xgeneric-imap:me@example.com:1"],
    ["a prefix in other case", "GENERIC-IMAP:me@example.com:1"],
    ["a look-alike prefix", "generic-imap2:me@example.com:1"],
    ["an id that only contains one", `18c2:${GENERIC_ID}`],
  ])("%s is not an IMAP id", (_label, id) => {
    expect(isImapMessageId(id)).toBe(false);
  });
});

describe("the re-ingested-history cutoff for generic ids", () => {
  const row = (gmailId: string, receivedAt: Date) => ({ gmailId, receivedAt });

  it.each([
    ["received before the reset", row(GENERIC_ID, BEFORE), RESET_AT, true],
    ["received at the reset (during the hold)", row(GENERIC_ID, RESET_AT), RESET_AT, false],
    ["of an account that was never reset", row(GENERIC_ID, BEFORE), null, false],
    ["a tombstone, whatever the reset", row(TOMBSTONE, RESET_AT), null, true],
    ["a Gmail row, whatever the reset", row(GMAIL_ID, BEFORE), RESET_AT, false],
    ["an Outlook row, whatever the reset", row(OUTLOOK_ID, BEFORE), RESET_AT, false],
  ])("%s", (_label, r, resetAt, expected) => {
    expect(isReingestedHistory(r, resetAt)).toBe(expected);
  });

  const account = (over: Row = {}): Row => ({
    id: "acc-generic",
    userId: USER,
    provider: "IMAP",
    email: "me@example.com",
    inboxUidValidityResetAt: RESET_AT,
    ...over,
  });
  const candidate = (id: string, gmailId: string, receivedAt: Date, acc: string | null) => ({
    id,
    gmailId,
    receivedAt,
    linkedInboxAccountId: acc,
  });

  beforeEach(() => {
    db = createFakeDb({
      linkedInboxAccount: [
        account(),
        account({ id: "acc-other-user", userId: "someone-else" }),
        { id: "acc-outlook", userId: USER, provider: "OUTLOOK", email: "me@outlook.com" },
      ],
    });
  });

  it("finds the history of a generic account's rows, and only those", async () => {
    const found = await findReingestedHistory(USER, [
      candidate("history", `${GENERIC_HEAD}:1`, BEFORE, "acc-generic"),
      candidate("during-hold", `${GENERIC_HEAD}:2`, RESET_AT, "acc-generic"),
      candidate("tombstone", TOMBSTONE, RESET_AT, null),
      candidate("gmail", GMAIL_ID, BEFORE, null),
      candidate("outlook", OUTLOOK_ID, BEFORE, "acc-outlook"),
    ]);
    expect([...found].sort()).toEqual(["history", "tombstone"]);
  });

  it("does not use another user's reset", async () => {
    const found = await findReingestedHistory(USER, [
      candidate("theirs", `${GENERIC_HEAD}:1`, BEFORE, "acc-other-user"),
    ]);
    expect([...found]).toEqual([]);
  });

  it("costs Gmail and Outlook rows no account query at all", async () => {
    db.reads.length = 0;
    const found = await findReingestedHistory(USER, [
      candidate("gmail", GMAIL_ID, BEFORE, null),
      candidate("outlook", OUTLOOK_ID, BEFORE, "acc-outlook"),
    ]);
    expect([...found]).toEqual([]);
    expect(db.reads).not.toContain("linkedInboxAccount");
  });

  it("fails closed for generic rows when the lookup fails, and leaves Gmail and Outlook alone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    db = undefined as unknown as FakeDb; // every query now throws
    const found = await findReingestedHistoryFailClosed(
      USER,
      [
        candidate("generic", `${GENERIC_HEAD}:1`, RESET_AT, "acc-generic"),
        candidate("gmail", GMAIL_ID, BEFORE, null),
        candidate("outlook", OUTLOOK_ID, BEFORE, "acc-outlook"),
      ],
      "auto-mode",
    );
    expect([...found]).toEqual(["generic"]);
  });
});

describe("the PUSH and urgent-sweep dedupe floors for generic ids", () => {
  const createdAt = new Date("2026-09-30T09:00:00Z");
  const email = (gmailId: string) => ({ id: "row-1", gmailId, createdAt });
  const hour = 3_600_000;

  it("a marker counts for a generic id only from the row's creation on", () => {
    const e = email(GENERIC_ID);
    expect(markerCountsFor(e, new Date(createdAt.getTime() - hour))).toBe(false);
    expect(markerCountsFor(e, createdAt)).toBe(true);
    expect(markerCountsFor(e, new Date(createdAt.getTime() + hour))).toBe(true);
  });

  it("Gmail and Outlook ids keep counting every marker, as before", () => {
    for (const id of [GMAIL_ID, OUTLOOK_ID]) {
      expect(markerCountsFor(email(id), new Date(createdAt.getTime() - 99 * hour))).toBe(true);
    }
  });

  it("unnotifiedEmails lets a NEW generic message through whose reused id an older row was notified under", () => {
    const old = new Date(createdAt.getTime() - hour);
    const notified = new Map([
      [GENERIC_ID, old],
      [GMAIL_ID, old],
    ]);
    const emails = [email(GENERIC_ID), email(GMAIL_ID)].map((e, i) => ({ ...e, id: `r${i}` }));
    expect(unnotifiedEmails(emails, notified).map((e) => e.gmailId)).toEqual([GENERIC_ID]);
  });

  it("the batch key of a generic lead carries the row id; Gmail and Outlook keys are unchanged", () => {
    expect(urgentDedupeKey({ id: "row-9", gmailId: GENERIC_ID })).toBe(
      `urgent:${GENERIC_ID}@row-9`,
    );
    expect(urgentDedupeKey({ id: "row-9", gmailId: GMAIL_ID })).toBe(`urgent:${GMAIL_ID}`);
    expect(urgentDedupeKey({ id: "row-9", gmailId: OUTLOOK_ID })).toBe(`urgent:${OUTLOOK_ID}`);
  });
});
