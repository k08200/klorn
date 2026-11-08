/**
 * "Later" from a web push notification: the same reminder the web reader's
 * Later sets (later today, four hours out; a Reminder row the reminder
 * scheduler delivers), created server-side for the one mail the capability
 * token names, and only when that mail is the token user's own.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});

import { PUSH_LATER_HOURS, remindLaterFromPush } from "../notify/push-later.js";

const NOW = new Date("2026-11-08T09:00:00.000Z");
let db: FakeDb;

function seed(language?: string) {
  db = createFakeDb({
    automationConfig: language
      ? [{ id: "cfg", userId: "user-1", notificationLanguage: language }]
      : [],
    emailMessage: [
      {
        id: "email-1",
        userId: "user-1",
        gmailId: "g1",
        from: "Alice <a@x.io>",
        to: "me@x.io",
        subject: "Contract",
      },
      {
        id: "email-2",
        userId: "user-2",
        gmailId: "g2",
        from: "Eve <e@x.io>",
        to: "u2@x.io",
        subject: "Other",
      },
      {
        id: "email-3",
        userId: "user-1",
        gmailId: "g3",
        from: "Bob <b@x.io>",
        to: "me@x.io",
        subject: "",
      },
    ],
    reminder: [],
  });
  dbHolder.current = db;
}

const reminders = () => db.tables.reminder ?? [];

beforeEach(() => seed());

describe("remindLaterFromPush", () => {
  it("sets a later-today reminder for the user's own mail", async () => {
    const result = await remindLaterFromPush({ userId: "user-1", emailId: "email-1" }, NOW);

    expect(result).toMatchObject({ ok: true, created: true });
    expect(reminders()).toHaveLength(1);
    const [row] = reminders();
    expect(row.userId).toBe("user-1");
    expect(row.status).toBe("PENDING");
    expect((row.remindAt as Date).getTime()).toBe(NOW.getTime() + PUSH_LATER_HOURS * 3_600_000);
    expect(row.title).toBe("Follow up: Contract");
    expect(row.description).toBe("From: Alice <a@x.io>\nOpen: /email/email-1");
  });

  it("titles the reminder in the user's notification language, with the no-subject stand-in", async () => {
    seed("ko");
    await remindLaterFromPush({ userId: "user-1", emailId: "email-3" }, NOW);
    expect(reminders()[0]?.title).toBe("다시 보기: (제목 없음)");
  });

  it("refuses another user's mail and writes nothing", async () => {
    const result = await remindLaterFromPush({ userId: "user-1", emailId: "email-2" }, NOW);
    expect(result).toEqual({ ok: false });
    expect(reminders()).toHaveLength(0);
  });

  it("refuses a mail that no longer exists", async () => {
    expect(await remindLaterFromPush({ userId: "user-1", emailId: "gone" }, NOW)).toEqual({
      ok: false,
    });
  });

  it("is idempotent: a second tap (or a replayed token) keeps the one pending reminder", async () => {
    await remindLaterFromPush({ userId: "user-1", emailId: "email-1" }, NOW);
    const again = await remindLaterFromPush({ userId: "user-1", emailId: "email-1" }, NOW);
    expect(again).toMatchObject({ ok: true, created: false });
    expect(reminders()).toHaveLength(1);
  });
});
