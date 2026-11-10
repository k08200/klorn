import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of migration 20261101000000_sent_message_origin_backfill.
// The pinned-text test cannot show what matters here: which rows the regexes,
// joins and windows actually label. CI applies the migration to an empty
// database, so this seeds rows and runs the migration's statements again (they
// fill NULLs only, so a second run is what production sees on first deploy).
// Skipped unless KLORN_TEST_PG_URL points at a database with every migration
// applied; DATABASE_URL is set to the same URL because setup.ts loads db.ts first.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";

const describePg = url ? describe : describe.skip;
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  here,
  "..",
  "..",
  "prisma",
  "migrations",
  "20261101000000_sent_message_origin_backfill",
  "migration.sql",
);

const created: string[] = [];
const T = new Date("2026-10-20T10:00:00Z");
const at = (seconds: number) => new Date(T.getTime() + seconds * 1000);

async function newUser(): Promise<string> {
  const user = await prisma.user.create({ data: { email: `origin-${randomUUID()}@test.local` } });
  created.push(user.id);
  return user.id;
}

async function inbound(
  userId: string,
  fields: { gmailId?: string; from?: string; subject?: string; mailto?: string; receivedAt?: Date },
) {
  await prisma.emailMessage.create({
    data: {
      userId,
      gmailId: fields.gmailId ?? `in-${randomUUID()}`,
      from: fields.from ?? "News <news@list.example>",
      to: "me@test.local",
      subject: fields.subject ?? "Weekly digest",
      receivedAt: fields.receivedAt ?? at(-86_400),
      listUnsubscribeMailto: fields.mailto ?? null,
    },
  });
}

async function claim(
  userId: string,
  fields: { gmailId: string; to: string; title?: string; createdAt?: Date },
) {
  const title = fields.title ?? "Klorn replied for you";
  const message =
    title === "Auto-reply failed"
      ? `Auto-reply to ${fields.to} (rule: "r") was not sent — the mail is still in your inbox [${fields.gmailId}]`
      : `Auto-mode replied to ${fields.to} [${fields.gmailId}]`;
  await prisma.notification.create({
    data: {
      userId,
      type: "email",
      title,
      message,
      dedupeKey: `auto-reply:${fields.gmailId}`,
      createdAt: fields.createdAt ?? T,
    },
  });
}

async function sent(
  userId: string,
  fields: {
    to: string;
    subject: string;
    sentAt: Date;
    inbox?: string;
    gmailId?: string;
    origin?: string;
  },
): Promise<string> {
  const row = await prisma.sentMessage.create({
    data: {
      userId,
      gmailId: fields.gmailId ?? `out-${randomUUID()}`,
      to: fields.to,
      subject: fields.subject,
      sentAt: fields.sentAt,
      inbox: fields.inbox ?? "primary",
      origin: fields.origin ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

async function originOf(id: string): Promise<string | null> {
  const row = await prisma.sentMessage.findUniqueOrThrow({
    where: { id },
    select: { origin: true },
  });
  return row.origin;
}

/** The migration's statements, run the way migrate deploy runs them: one transaction. */
async function runMigration() {
  const statements = readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  await prisma.$transaction(async (tx) => {
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
  });
}

const ids: Record<string, string> = {};

describePg("legacy sent provenance backfill on real Postgres", () => {
  beforeAll(async () => {
    // approved: the messageId an executed approval returned.
    const a = await newUser();
    await prisma.actionOutbox.create({
      data: {
        pendingActionId: randomUUID(),
        userId: a,
        toolName: "send_email",
        toolArgs: {},
        idempotencyKey: randomUUID(),
        status: "COMPLETED",
        result: JSON.stringify({ success: true, messageId: "m-approved", threadId: "t1" }),
      },
    });
    ids.approved = await sent(a, {
      to: "pat@x.example",
      subject: "Hi",
      sentAt: T,
      gmailId: "m-approved",
    });

    // auto_reply: Klorn's send right after the claim; the user's own reply a minute later.
    const b = await newUser();
    await inbound(b, { gmailId: "g-b", from: "Bob <bob@x.example>", subject: "Hello" });
    await claim(b, { gmailId: "g-b", to: "bob@x.example" });
    ids.autoReply = await sent(b, { to: "bob@x.example", subject: "Re: Hello", sentAt: at(1) });
    ids.manualAfterAuto = await sent(b, {
      to: "bob@x.example",
      subject: "Re: Hello",
      sentAt: at(60),
    });
    ids.manualFiveMinutes = await sent(b, {
      to: "bob@x.example",
      subject: "Re: Hello",
      sentAt: at(300),
    });

    // A claim rewritten as failed: nothing left, so the manual reply is the user's.
    const c = await newUser();
    await inbound(c, { gmailId: "g-c", from: "Cat <cat@x.example>", subject: "Invoice" });
    await claim(c, { gmailId: "g-c", to: "cat@x.example", title: "Auto-reply failed" });
    ids.afterFailedClaim = await sent(c, {
      to: "cat@x.example",
      subject: "Re: Invoice",
      sentAt: at(30),
    });

    // unsubscribe: exact subject after decoding '+' and %3C/%3E, sent after the carrier.
    const d = await newUser();
    await inbound(d, {
      mailto: "mailto:Unsub@List.example?subject=remove+%3Cme%3E",
      receivedAt: at(-3600),
    });
    ids.unsubExact = await sent(d, { to: "unsub@list.example", subject: "remove <me>", sentAt: T });
    ids.unsubBeforeCarrier = await sent(d, {
      to: "unsub@list.example",
      subject: "remove <me>",
      sentAt: at(-7200),
    });
    ids.unsubOtherInbox = await sent(d, {
      to: "unsub@list.example",
      subject: "remove <me>",
      sentAt: T,
      inbox: "linked-1",
    });

    // unsubscribe: a per-mail token whose carrier is gone, same shape, endpoint never mails.
    const e = await newUser();
    await inbound(e, {
      mailto: "mailto:u@lists.example?subject=unsub-AbCdEf0123456789XyZ",
      receivedAt: at(-3600),
    });
    ids.unsubToken = await sent(e, {
      to: "u@lists.example",
      subject: "unsub-ZzYyXx9876543210AbC",
      sentAt: T,
    });

    // The review's false positive: a newsletter names a real mailbox as its mailto target.
    const f = await newUser();
    await inbound(f, {
      mailto: "mailto:info@brand.example?subject=Unsubscribe",
      receivedAt: at(-3600),
    });
    ids.manualToMailbox = await sent(f, {
      to: "info@brand.example",
      subject: "Question about order 123",
      sentAt: T,
    });

    // Another user's claim never labels this user's row; a label already set is kept.
    const g = await newUser();
    await inbound(g, { gmailId: "g-b", from: "Bob <bob@x.example>", subject: "Hello" });
    ids.otherUsersClaim = await sent(g, {
      to: "bob@x.example",
      subject: "Re: Hello",
      sentAt: at(1),
    });
    ids.alreadyLabelled = await sent(b, {
      to: "bob@x.example",
      subject: "Re: Hello",
      sentAt: at(2),
      origin: "user",
    });

    await runMigration();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: created } } });
  });

  it("labels an executed approval's send as approved", async () => {
    expect(await originOf(ids.approved)).toBe("approved");
  });

  it("labels the unattended reply sent right after its claim", async () => {
    expect(await originOf(ids.autoReply)).toBe("auto_reply");
  });

  it("matches one row per claim: the user's own reply a minute later stays the user's", async () => {
    expect(await originOf(ids.manualAfterAuto)).toBeNull();
  });

  it("leaves a reply sent minutes after the claim alone", async () => {
    expect(await originOf(ids.manualFiveMinutes)).toBeNull();
  });

  it("never counts a claim rewritten as failed", async () => {
    expect(await originOf(ids.afterFailedClaim)).toBeNull();
  });

  it("labels a mailto unsubscribe whose subject equals the decoded mailto subject", async () => {
    expect(await originOf(ids.unsubExact)).toBe("unsubscribe");
  });

  it("needs the carrier first and the same account", async () => {
    expect(await originOf(ids.unsubBeforeCarrier)).toBeNull();
    expect(await originOf(ids.unsubOtherInbox)).toBeNull();
  });

  it("labels a per-mail token subject of the same shape sent to an endpoint that never mails", async () => {
    expect(await originOf(ids.unsubToken)).toBe("unsubscribe");
  });

  it("leaves the user's own mail to an address a newsletter named as its target", async () => {
    expect(await originOf(ids.manualToMailbox)).toBeNull();
  });

  it("scopes evidence to the row's own user and never overwrites a label", async () => {
    expect(await originOf(ids.otherUsersClaim)).toBeNull();
    expect(await originOf(ids.alreadyLabelled)).toBe("user");
  });

  it("is a no-op when run again", async () => {
    const before = await prisma.sentMessage.findMany({
      where: { userId: { in: created } },
      select: { id: true, origin: true },
      orderBy: { id: "asc" },
    });
    await runMigration();
    const after = await prisma.sentMessage.findMany({
      where: { userId: { in: created } },
      select: { id: true, origin: true },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(before);
  });
});
