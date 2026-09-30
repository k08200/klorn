/**
 * The one way a tool turns an `email_id` argument into the caller's OWN email row
 * (used by mark_read, set_tier and create_draft). The id may be Klorn's row id or
 * the provider's message id, and the lookup is always scoped to the user, so an id
 * that belongs to someone else can never resolve.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});

import {
  findUserEmail,
  MAX_EMAIL_ID_LENGTH,
  parseEmailIdArg,
  userEmailWhere,
} from "../mail/email-lookup.js";
import { MAX_TARGET_ID_LENGTH } from "../mcp/write-audit.js";

let db: FakeDb;

beforeEach(() => {
  db = createFakeDb({
    emailMessage: [
      { id: "row-1", userId: "u1", gmailId: "g-1", linkedInboxAccountId: null },
      { id: "row-2", userId: "u1", gmailId: "g-2", linkedInboxAccountId: "acct-2" },
      { id: "row-x", userId: "u2", gmailId: "g-x", linkedInboxAccountId: null },
    ],
  });
  dbHolder.current = db;
});

describe("parseEmailIdArg", () => {
  it("returns the trimmed id", () => {
    expect(parseEmailIdArg("g-1")).toBe("g-1");
    expect(parseEmailIdArg("  g-1 \n")).toBe("g-1");
  });

  it("accepts exactly the maximum length and refuses one over", () => {
    expect(parseEmailIdArg("g".repeat(MAX_EMAIL_ID_LENGTH))).toBe("g".repeat(MAX_EMAIL_ID_LENGTH));
    expect(parseEmailIdArg("g".repeat(MAX_EMAIL_ID_LENGTH + 1))).toBeNull();
  });

  it("refuses anything that is not a non-empty string", () => {
    for (const raw of [undefined, null, "", "   ", 7, {}, [], ["g-1"], true]) {
      expect(parseEmailIdArg(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("keeps the argument bound in lockstep with the audit's target id bound", () => {
    expect(MAX_EMAIL_ID_LENGTH).toBe(MAX_TARGET_ID_LENGTH);
  });
});

describe("userEmailWhere", () => {
  it("scopes to the user and matches the Klorn id OR the provider id", () => {
    expect(userEmailWhere("u1", "g-1")).toEqual({
      userId: "u1",
      OR: [{ id: "g-1" }, { gmailId: "g-1" }],
    });
  });
});

describe("findUserEmail", () => {
  it("finds the caller's row by Klorn id and by provider id, returning only the selected columns", async () => {
    const select = { gmailId: true, linkedInboxAccountId: true } as const;
    expect(await findUserEmail("u1", "row-2", select)).toEqual({
      gmailId: "g-2",
      linkedInboxAccountId: "acct-2",
    });
    expect(await findUserEmail("u1", "g-2", select)).toEqual({
      gmailId: "g-2",
      linkedInboxAccountId: "acct-2",
    });
  });

  it("never resolves another user's row, by either id", async () => {
    expect(await findUserEmail("u1", "row-x", { id: true })).toBeNull();
    expect(await findUserEmail("u1", "g-x", { id: true })).toBeNull();
    expect(await findUserEmail("u2", "g-x", { id: true })).toEqual({ id: "row-x" });
  });

  it("is null for an unknown id", async () => {
    expect(await findUserEmail("u1", "nope", { id: true })).toBeNull();
  });
});
