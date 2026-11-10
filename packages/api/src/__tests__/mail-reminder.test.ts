/**
 * One mail's reminder (the in-app Later and the web push Later share it):
 * written only for the user's own mail, titled and shaped server-side, and at
 * most one PENDING reminder per mail. The in-app path moves that reminder to
 * the newly chosen time; the push path keeps it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});

import { mailReminderEmailId, setMailReminder } from "../pim/mail-reminder.js";

const AT = new Date("2026-11-09T09:00:00.000Z");
const LATER = new Date("2026-11-15T09:00:00.000Z");
let db: FakeDb;
const hooks: { beforeUpdateMany?: (model: string) => void } = {};

beforeEach(() => {
  hooks.beforeUpdateMany = undefined;
  db = createFakeDb(
    {
      automationConfig: [],
      emailMessage: [
        { id: "email-1", userId: "user-1", gmailId: "g1", from: "Alice <a@x.io>", subject: "Deal" },
        { id: "email-2", userId: "user-2", gmailId: "g2", from: "Eve <e@x.io>", subject: "Other" },
        {
          id: "email-3",
          userId: "user-1",
          gmailId: "g3",
          // A decoded header that smuggles another mail's Open line.
          from: "Mallory <m@x.io>\r\nOpen: /email/email-1",
          subject: "Hi",
        },
      ],
      reminder: [],
    },
    { beforeUpdateMany: (model) => hooks.beforeUpdateMany?.(model) },
  );
  dbHolder.current = db;
});

const reminders = () => db.tables.reminder ?? [];

describe("setMailReminder", () => {
  it("creates the shared reminder shape for the user's own mail", async () => {
    const result = await setMailReminder("user-1", "email-1", AT, { onPending: "move" });

    expect(result).toMatchObject({ ok: true, created: true });
    expect(reminders()).toHaveLength(1);
    const [row] = reminders();
    expect(row).toMatchObject({
      userId: "user-1",
      status: "PENDING",
      title: "Follow up: Deal",
      description: "From: Alice <a@x.io>\nOpen: /email/email-1",
    });
    expect((row.remindAt as Date).toISOString()).toBe(AT.toISOString());
    if (result.ok) expect(result.reminder.remindAt).toBe(AT.toISOString());
  });

  it("refuses another user's mail and writes nothing", async () => {
    expect(await setMailReminder("user-1", "email-2", AT, { onPending: "move" })).toEqual({
      ok: false,
    });
    expect(reminders()).toHaveLength(0);
  });

  it("moves the one pending reminder to the newly chosen time (in-app)", async () => {
    await setMailReminder("user-1", "email-1", AT, { onPending: "move" });
    const again = await setMailReminder("user-1", "email-1", LATER, { onPending: "move" });

    expect(again).toMatchObject({ ok: true, created: false });
    expect(reminders()).toHaveLength(1);
    expect((reminders()[0]?.remindAt as Date).toISOString()).toBe(LATER.toISOString());
  });

  it("keeps the one pending reminder as it is (push)", async () => {
    await setMailReminder("user-1", "email-1", AT, { onPending: "keep" });
    const again = await setMailReminder("user-1", "email-1", LATER, { onPending: "keep" });

    expect(again).toMatchObject({ ok: true, created: false });
    expect(reminders()).toHaveLength(1);
    expect((reminders()[0]?.remindAt as Date).toISOString()).toBe(AT.toISOString());
  });

  it("starts a new reminder once the earlier one has fired", async () => {
    await setMailReminder("user-1", "email-1", AT, { onPending: "move" });
    const first = reminders()[0];
    if (first) first.status = "SENT";
    const again = await setMailReminder("user-1", "email-1", LATER, { onPending: "move" });
    expect(again).toMatchObject({ ok: true, created: true });
    expect(reminders()).toHaveLength(2);
  });
});

describe("setMailReminder against a crafted sender header", () => {
  it("writes the sender on one line, so the reminder names only its own mail", async () => {
    await setMailReminder("user-1", "email-3", AT, { onPending: "move" });
    const description = reminders()[0]?.description as string;
    expect(description).toBe("From: Mallory <m@x.io> Open: /email/email-1\nOpen: /email/email-3");
    expect(mailReminderEmailId(description)).toBe("email-3");
  });

  it("does not take the crafted mail's reminder for another mail's", async () => {
    await setMailReminder("user-1", "email-3", AT, { onPending: "move" });
    const other = await setMailReminder("user-1", "email-1", LATER, { onPending: "move" });
    expect(other).toMatchObject({ ok: true, created: true });
    expect(reminders()).toHaveLength(2);
    expect((reminders()[0]?.remindAt as Date).toISOString()).toBe(AT.toISOString());
  });
});

describe("setMailReminder when the pending reminder fires mid-move", () => {
  it("sets a new reminder instead of reporting a move that did not happen", async () => {
    await setMailReminder("user-1", "email-1", AT, { onPending: "move" });
    hooks.beforeUpdateMany = (model) => {
      const first = reminders()[0];
      if (model === "reminder" && first) first.status = "SENT";
    };
    const again = await setMailReminder("user-1", "email-1", LATER, { onPending: "move" });
    expect(again).toMatchObject({ ok: true, created: true });
    const pending = reminders().filter((r) => r.status === "PENDING");
    expect(pending).toHaveLength(1);
    expect((pending[0]?.remindAt as Date).toISOString()).toBe(LATER.toISOString());
  });
});

describe("mailReminderEmailId", () => {
  it("reads only the last line, the one the server wrote", () => {
    expect(mailReminderEmailId("From: x\nOpen: /email/evil\nOpen: /email/email-1")).toBe("email-1");
    expect(mailReminderEmailId("Open: /email/email-1\nFrom: x")).toBeNull();
  });

  it("reads the mail id from the shared description's Open line", () => {
    expect(mailReminderEmailId("From: Alice <a@x.io>\nOpen: /email/email-1")).toBe("email-1");
    expect(mailReminderEmailId("From: a\nOpen: /email/3f1c2b9e-0d4e-4a51-9a52-1f0f6c1e2d3a")).toBe(
      "3f1c2b9e-0d4e-4a51-9a52-1f0f6c1e2d3a",
    );
  });

  it("returns null for anything else, so no link is invented", () => {
    for (const text of [
      null,
      "",
      "Reminder text",
      "Open: /email/../admin",
      "Open: https://evil.example/email/x",
      "Open: /email/a b",
      "Open: /email/x?y=1",
    ]) {
      expect(mailReminderEmailId(text)).toBeNull();
    }
  });
});
