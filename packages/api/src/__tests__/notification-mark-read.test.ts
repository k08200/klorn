/**
 * Marking one bell row read while "Clear all" runs (#1767).
 *
 * Clear all deletes the user's rows older than the notified look-back and
 * hides the newer ones (clearedAt). A mark-read that looked its row up first
 * and then wrote it by id met a row Clear all had deleted in between: Prisma's
 * P2025, a 500 and a Sentry event for a click on the bell. markNotificationRead
 * now writes only a row that is still the user's live bell row, in one
 * conditional statement, and answers whether it did: a row cleared or deleted
 * first is "not found", the same as everywhere else the bell treats a cleared row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));

const { clearNotifications, markNotificationRead } = await import("../background.js");

const USER = "user-1";
const OTHER = "user-2";
const DAY = 24 * 60 * 60 * 1000;
const RECENT_ID = "11111111-1111-4111-8111-111111111111";
const OLD_ID = "22222222-2222-4222-8222-222222222222";

let db: FakeDb;

function bellRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    userId: USER,
    type: "info",
    title: "Board numbers",
    message: "Re: the board numbers",
    isRead: false,
    createdAt: new Date(),
    ...overrides,
  };
}

function followup(sourceId: string): Row {
  return {
    id: `item-${sourceId}`,
    userId: USER,
    source: "NOTIFICATION",
    sourceId,
    type: "FOLLOWUP",
    status: "OPEN",
    title: "Follow up",
  };
}

function row(id: string): Row | undefined {
  return db.tables.notification?.find((r) => r.id === id);
}

beforeEach(() => {
  db = createFakeDb({
    notification: [
      bellRow(RECENT_ID),
      // Older than the notified look-back (7 days): Clear all deletes it.
      bellRow(OLD_ID, { createdAt: new Date(Date.now() - 30 * DAY) }),
    ],
    attentionItem: [followup(RECENT_ID)],
  });
  dbHolder.current = db;
});

describe("markNotificationRead", () => {
  it("marks the user's live bell row read and dismisses its follow-up", async () => {
    await expect(markNotificationRead(USER, RECENT_ID)).resolves.toBe(true);
    expect(row(RECENT_ID)?.isRead).toBe(true);
    expect(db.tables.attentionItem?.[0]?.status).toBe("DISMISSED");
  });

  it("a row Clear all deleted first: not found, no throw, nothing written", async () => {
    await clearNotifications(USER);
    expect(row(OLD_ID)).toBeUndefined();
    await expect(markNotificationRead(USER, OLD_ID)).resolves.toBe(false);
  });

  it("a row Clear all hid first: not found, and it stays as Clear all left it", async () => {
    await clearNotifications(USER);
    const cleared = { ...row(RECENT_ID) };
    expect(cleared.clearedAt).toBeInstanceOf(Date);
    await expect(markNotificationRead(USER, RECENT_ID)).resolves.toBe(false);
    expect(row(RECENT_ID)).toEqual(cleared);
  });

  it("Clear all landing just before the write: not found, no throw, nothing marked", async () => {
    // The fake runs this at the start of the write, before its where is matched:
    // the moment the old lookup-then-update by id met a row that was gone.
    db = createFakeDb(
      { notification: [bellRow(OLD_ID, { createdAt: new Date(Date.now() - 30 * DAY) })] },
      {
        beforeUpdateMany: (model) => {
          if (model === "notification") db.tables.notification = [];
        },
      },
    );
    dbHolder.current = db;
    await expect(markNotificationRead(USER, OLD_ID)).resolves.toBe(false);
    expect(db.writes.attentionItem).toBeUndefined();
  });

  it("Clear all racing the click: never throws, whichever lands first", async () => {
    // Both start before either finishes; the fake database interleaves their
    // statements at each await, as two requests on one pool would.
    const [marked] = await Promise.all([
      markNotificationRead(USER, OLD_ID),
      clearNotifications(USER),
    ]);
    expect(typeof marked).toBe("boolean");
    expect(row(OLD_ID)).toBeUndefined();
  });

  it("another user's row: not found, and it is not touched", async () => {
    const before = { ...row(RECENT_ID) };
    await expect(markNotificationRead(OTHER, RECENT_ID)).resolves.toBe(false);
    expect(row(RECENT_ID)).toEqual(before);
    expect(db.tables.attentionItem?.[0]?.status).toBe("OPEN");
  });

  it("a hidden claim row is not a bell row: not found", async () => {
    db.tables.notification = [bellRow(RECENT_ID, { type: "claim" })];
    await expect(markNotificationRead(USER, RECENT_ID)).resolves.toBe(false);
    expect(row(RECENT_ID)?.isRead).toBe(false);
  });

  it("a missing id: not found", async () => {
    await expect(markNotificationRead(USER, "33333333-3333-4333-8333-333333333333")).resolves.toBe(
      false,
    );
  });
});
