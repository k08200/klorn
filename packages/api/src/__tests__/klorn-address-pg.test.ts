import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the KlornAddress table (step E1a, migration
// 20261021010000_klorn_mailbox_schema). A mock cannot show the parts that make a
// handle permanent: that deleting the account leaves the row behind with no owner
// (SET NULL, the tombstone of L5), that only lowercase is stored, and that an
// account holds one address. Skipped unless KLORN_TEST_PG_URL points at a
// database with every migration applied; set DATABASE_URL to the same URL.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import { deleteUserAndAllData, purgeAllUserData } from "../user-deletion.js";

const describePg = url ? describe : describe.skip;
const createdUsers: string[] = [];
const createdHandles: string[] = [];

async function newUser(): Promise<string> {
  const user = await prisma.user.create({ data: { email: `klorn-${randomUUID()}@test.local` } });
  createdUsers.push(user.id);
  return user.id;
}

function newHandle(): string {
  const handle = `h${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  createdHandles.push(handle);
  return handle;
}

afterAll(async () => {
  if (!url) return;
  await prisma.klornAddress.deleteMany({ where: { handle: { in: createdHandles } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.$disconnect();
});

describePg("KlornAddress (real Postgres)", () => {
  it("keeps the handle, with no owner, when the account is deleted", async () => {
    const userId = await newUser();
    const handle = newHandle();
    await prisma.klornAddress.create({ data: { handle, userId } });
    await deleteUserAndAllData(userId);
    const row = await prisma.klornAddress.findUnique({ where: { handle } });
    expect(row).toMatchObject({ handle, userId: null });
  });

  it("refuses the handle again once its account is gone", async () => {
    const userId = await newUser();
    const handle = newHandle();
    await prisma.klornAddress.create({ data: { handle, userId } });
    await deleteUserAndAllData(userId);
    const someoneElse = await newUser();
    await expect(
      prisma.klornAddress.create({ data: { handle, userId: someoneElse } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("keeps the address through a data wipe", async () => {
    const userId = await newUser();
    const handle = newHandle();
    await prisma.klornAddress.create({ data: { handle, userId } });
    await purgeAllUserData(userId);
    const row = await prisma.klornAddress.findUnique({ where: { handle } });
    expect(row).toMatchObject({ handle, userId });
  });

  it("keeps the address's mailbox through a data wipe, and deletes its mail and the other mailboxes", async () => {
    const userId = await newUser();
    const handle = newHandle();
    await prisma.klornAddress.create({ data: { handle, userId } });
    const klorn = await prisma.linkedInboxAccount.create({
      data: { userId, provider: "KLORN", email: `${handle}@klorn.test` },
    });
    await prisma.linkedInboxAccount.create({
      data: {
        userId,
        provider: "ICLOUD",
        email: `${handle}@icloud.test`,
        imapHost: "imap.mail.me.com",
      },
    });
    await prisma.emailMessage.create({
      data: {
        userId,
        gmailId: `klorn:${klorn.email}:${randomUUID()}`,
        linkedInboxAccountId: klorn.id,
        from: "a@example.com",
        to: klorn.email,
        subject: "s",
        receivedAt: new Date(),
      },
    });
    await purgeAllUserData(userId);
    const left = await prisma.linkedInboxAccount.findMany({ where: { userId } });
    expect(left.map((r) => r.provider)).toEqual(["KLORN"]);
    expect(await prisma.emailMessage.count({ where: { userId } })).toBe(0);
  });

  it("stores only a lowercase handle", async () => {
    const userId = await newUser();
    const handle = newHandle();
    await expect(
      prisma.$executeRaw`INSERT INTO "KlornAddress" ("handle", "userId") VALUES (${handle.toUpperCase()}, ${userId})`,
    ).rejects.toThrow(/KlornAddress_handle_lowercase/);
  });

  it("gives an account one address", async () => {
    const userId = await newUser();
    await prisma.klornAddress.create({ data: { handle: newHandle(), userId } });
    await expect(
      prisma.klornAddress.create({ data: { handle: newHandle(), userId } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("accepts KLORN as a linked inbox provider and stores authentication results", async () => {
    const userId = await newUser();
    const account = await prisma.linkedInboxAccount.create({
      data: { userId, provider: "KLORN", email: `${newHandle()}@klorn.test` },
    });
    expect(account.provider).toBe("KLORN");
    const email = await prisma.emailMessage.create({
      data: {
        userId,
        gmailId: `klorn:${account.email}:${randomUUID()}`,
        linkedInboxAccountId: account.id,
        from: "a@example.com",
        to: account.email,
        subject: "s",
        receivedAt: new Date(),
        authentication: { spf: "pass", dkim: "pass", dmarc: "fail" },
      },
    });
    expect(email.authentication).toEqual({ spf: "pass", dkim: "pass", dmarc: "fail" });
  });
});
