import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the data-wipe fence (privacy/data-wipe-fence.ts and
// migration 20261019010000_data_wipe_fence). A mock cannot show what matters
// here: that the trigger and the wipe's account-row lock serialize, that the
// trigger sees a wipe committed while it waited, and that the app check runs
// inside interactive transactions. Skipped unless KLORN_TEST_PG_URL points at a
// database with every migration applied; set DATABASE_URL to the same URL, since
// setup.ts loads db.ts before this file runs.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import {
  DataWipeFenceError,
  isDataWipeFenceError,
  refreshDataWipes,
} from "../privacy/data-wipe-fence.js";
import { runDataWipeSweep } from "../privacy/data-wipe-sweep.js";
import { finishDataWipe, purgeAllUserData } from "../user-deletion.js";
import { runAsNewWork } from "../work-context.js";

const describePg = url ? describe : describe.skip;
const created: string[] = [];

async function newUser(): Promise<string> {
  const user = await prisma.user.create({ data: { email: `fence-${randomUUID()}@test.local` } });
  created.push(user.id);
  return user.id;
}

/** An insert that bypasses the app check, so only the trigger decides. */
function rawNote(userId: string, title = "raw") {
  return prisma.$executeRaw`
    INSERT INTO "Note" ("id", "userId", "title", "content", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${userId}, ${title}, '', now(), now())`;
}

function setWipe(userId: string, purgedAtSql: "null" | "past", fenceSeconds: number | null) {
  return prisma.$executeRaw`
    INSERT INTO "DataWipe" ("userId", "requestedAt", "purgedAt", "fenceUntil", "updatedAt")
    VALUES (
      ${userId},
      now() AT TIME ZONE 'UTC',
      CASE WHEN ${purgedAtSql} = 'past' THEN (now() AT TIME ZONE 'UTC') ELSE NULL END,
      CASE WHEN ${fenceSeconds}::int IS NULL THEN NULL
           ELSE (now() AT TIME ZONE 'UTC') + make_interval(secs => ${fenceSeconds}::int) END,
      now() AT TIME ZONE 'UTC')
    ON CONFLICT ("userId") DO UPDATE SET
      "purgedAt" = EXCLUDED."purgedAt", "fenceUntil" = EXCLUDED."fenceUntil"`;
}

const notes = (userId: string) => prisma.note.count({ where: { userId } });
const settledWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

afterAll(async () => {
  if (!url) return;
  await prisma.user.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

describePg("the fence trigger", () => {
  it("accepts inserts for an account that was never wiped", async () => {
    const userId = await newUser();
    await rawNote(userId);
    expect(await notes(userId)).toBe(1);
  });

  it("rejects an insert while the wipe is pending, with a recognizable error", async () => {
    const userId = await newUser();
    await setWipe(userId, "null", null);
    const error = await rawNote(userId).catch((err: unknown) => err);
    expect(isDataWipeFenceError(error)).toBe(true);
    expect(await notes(userId)).toBe(0);
  });

  it("rejects until fenceUntil and accepts after it", async () => {
    const userId = await newUser();
    await setWipe(userId, "past", 3600);
    expect(isDataWipeFenceError(await rawNote(userId).catch((err: unknown) => err))).toBe(true);
    await setWipe(userId, "past", -1);
    await rawNote(userId);
    expect(await notes(userId)).toBe(1);
  });

  it("makes the wipe wait for an insert already in flight, which commits first", async () => {
    const userId = await newUser();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted: () => void = () => {};
    const insertedSignal = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const writer = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "Note" ("id", "userId", "title", "content", "createdAt", "updatedAt")
          VALUES (${randomUUID()}, ${userId}, 'in flight', '', now(), now())`;
        inserted();
        await held;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    await insertedSignal;
    const wipe = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        await tx.$executeRaw`
          INSERT INTO "DataWipe" ("userId", "requestedAt", "updatedAt")
          VALUES (${userId}, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

    expect(await settledWithin(wipe, 500)).toBe(false);
    release();
    await writer;
    await wipe;

    // The in-flight row committed before the wipe began: the purge takes it.
    expect(await notes(userId)).toBe(1);
    expect(isDataWipeFenceError(await rawNote(userId).catch((err: unknown) => err))).toBe(true);
  });

  it("makes an insert wait for a wipe holding the lock, then sees its record", async () => {
    const userId = await newUser();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const lockedSignal = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const wipe = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        locked();
        await held;
        await tx.$executeRaw`
          INSERT INTO "DataWipe" ("userId", "requestedAt", "updatedAt")
          VALUES (${userId}, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    await lockedSignal;
    const insert = rawNote(userId).catch((err: unknown) => err);

    expect(await settledWithin(insert, 500)).toBe(false);
    release();
    await wipe;

    // The trigger waited on the account row, then read the committed record.
    expect(isDataWipeFenceError(await insert)).toBe(true);
    expect(await notes(userId)).toBe(0);
  });
});

describePg("the app check, after the trigger's window", () => {
  it("rejects work that began before fenceUntil, inside interactive transactions too", async () => {
    const userId = await newUser();
    await runAsNewWork(async () => {
      // The wipe finished and its window already ended, so the trigger lets
      // inserts through again; this work began before the window ended.
      await prisma.$executeRaw`
        INSERT INTO "DataWipe" ("userId", "requestedAt", "purgedAt", "fenceUntil", "updatedAt")
        VALUES (${userId}, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC',
                (now() AT TIME ZONE 'UTC') + interval '200 milliseconds', now() AT TIME ZONE 'UTC')`;
      await refreshDataWipes();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await rawNote(userId, "trigger allows it now");

      await expect(
        prisma.note.create({ data: { userId, title: "stale", content: "" } }),
      ).rejects.toBeInstanceOf(DataWipeFenceError);
      await expect(
        prisma.$transaction(async (tx) =>
          tx.note.create({ data: { userId, title: "stale in tx", content: "" } }),
        ),
      ).rejects.toBeInstanceOf(DataWipeFenceError);
    });
    expect(await notes(userId)).toBe(1);
  });

  it("lets work that began after fenceUntil write", async () => {
    const userId = await newUser();
    await setWipe(userId, "past", -1);
    await refreshDataWipes();
    await runAsNewWork(() => prisma.note.create({ data: { userId, title: "fresh", content: "" } }));
    expect(await notes(userId)).toBe(1);
  });
});

describePg("purgeAllUserData against the real schema", () => {
  it("purges, stamps the fence, and rejects an insert right after", async () => {
    const userId = await newUser();
    await rawNote(userId);
    await expect(purgeAllUserData(userId)).resolves.toBe("purged");

    const record = await prisma.dataWipe.findUnique({ where: { userId } });
    expect(record?.purgedAt).toBeInstanceOf(Date);
    expect(record?.fenceUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(await notes(userId)).toBe(0);
    expect(isDataWipeFenceError(await rawNote(userId).catch((err: unknown) => err))).toBe(true);
  });
});

describePg("rows without a userId", () => {
  it("rejects a message into a wiped account's conversation, found through the parent", async () => {
    const userId = await newUser();
    const conversation = await prisma.conversation.create({ data: { userId, title: "c" } });
    await setWipe(userId, "null", null);
    const error = await prisma.$executeRaw`
      INSERT INTO "Message" ("id", "conversationId", "role", "content", "createdAt")
      VALUES (${randomUUID()}, ${conversation.id}, 'ASSISTANT', 'old mail', now())`.catch(
      (err: unknown) => err,
    );
    expect(isDataWipeFenceError(error)).toBe(true);
    // The same insert for an account without a wipe goes through.
    const other = await newUser();
    const open = await prisma.conversation.create({ data: { userId: other, title: "c" } });
    await prisma.$executeRaw`
      INSERT INTO "Message" ("id", "conversationId", "role", "content", "createdAt")
      VALUES (${randomUUID()}, ${open.id}, 'ASSISTANT', 'fine', now())`;
    expect(await prisma.message.count({ where: { conversationId: open.id } })).toBe(1);
  });
});

describePg("purgeAllUserData under a concurrent writer", () => {
  it("waits for a write in flight, then purges it with the rest", async () => {
    const userId = await newUser();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted: () => void = () => {};
    const insertedSignal = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const writer = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "Note" ("id", "userId", "title", "content", "createdAt", "updatedAt")
          VALUES (${randomUUID()}, ${userId}, 'stale sync', '', now(), now())`;
        inserted();
        await held;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    await insertedSignal;
    const wipe = purgeAllUserData(userId);

    expect(await settledWithin(wipe, 500)).toBe(false);
    release();
    await writer;
    await expect(wipe).resolves.toBe("purged");
    expect(await notes(userId)).toBe(0);
  });

  it("leaves a wipe that already finished alone, so data created since survives", async () => {
    const userId = await newUser();
    await expect(purgeAllUserData(userId)).resolves.toBe("purged");
    // The fence ended; the user created a note with new work.
    await prisma.$executeRaw`UPDATE "DataWipe" SET "fenceUntil" = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE "userId" = ${userId}`;
    await rawNote(userId, "after the wipe");
    await expect(finishDataWipe(userId)).resolves.toBe("not-pending");
    expect(await notes(userId)).toBe(1);
  });
});

describePg("the data-wipe sweep against the real schema", () => {
  it("finishes a pending wipe whose request never purged", async () => {
    const userId = await newUser();
    await rawNote(userId, "before the wipe");
    await prisma.$executeRaw`
      INSERT INTO "DataWipe" ("userId", "requestedAt", "updatedAt")
      VALUES (${userId}, (now() AT TIME ZONE 'UTC') - interval '10 minutes', now() AT TIME ZONE 'UTC')`;
    const result = await runDataWipeSweep();
    expect(result.finished).toBeGreaterThanOrEqual(1);
    expect(await notes(userId)).toBe(0);
    const record = await prisma.dataWipe.findUnique({ where: { userId } });
    expect(record?.purgedAt).toBeInstanceOf(Date);
  });
});
