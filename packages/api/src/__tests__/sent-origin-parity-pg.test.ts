import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Real-Postgres parity of the two provenance paths: the legacy backfill SQL
// (migration 20261101000000_sent_message_origin_backfill) labels rows already
// in the table; sent-origin-classifier.ts labels rows the Sent scan and the
// history import are about to create, with its real loaders. The same
// fixtures (sent-origin-backfill-pg.test.ts, plus the target derivations the
// SQL emulates) are seeded twice; both copies must get the same labels.
// Skipped unless KLORN_TEST_PG_URL points at a database with every migration
// applied; DATABASE_URL is set to the same URL because setup.ts loads db.ts first.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import { classifySentRows } from "../mail/sent-origin-classifier.js";

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

interface SentFixture {
  key: string;
  userId: string;
  gmailId: string;
  to: string;
  subject: string;
  sentAt: Date;
  inbox: string;
  origin: string | null;
}

/** One copy of the fixtures: users, their evidence, and the sent rows to label. */
class Copy {
  readonly rows: SentFixture[] = [];

  async user(): Promise<string> {
    const user = await prisma.user.create({ data: { email: `parity-${randomUUID()}@test.local` } });
    created.push(user.id);
    return user.id;
  }

  async inbound(
    userId: string,
    fields: {
      gmailId?: string;
      from?: string;
      subject?: string;
      mailto?: string;
      receivedAt?: Date;
    },
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

  async claim(userId: string, fields: { gmailId: string; to: string; title?: string }) {
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
        createdAt: T,
      },
    });
  }

  sent(
    key: string,
    userId: string,
    fields: {
      to: string;
      subject: string;
      sentAt: Date;
      inbox?: string;
      gmailId?: string;
      origin?: string;
    },
  ) {
    this.rows.push({
      key,
      userId,
      gmailId: fields.gmailId ?? `out-${randomUUID()}`,
      to: fields.to,
      subject: fields.subject,
      sentAt: fields.sentAt,
      inbox: fields.inbox ?? "primary",
      origin: fields.origin ?? null,
    });
  }

  async insert(rows: SentFixture[]) {
    for (const r of rows) {
      await prisma.sentMessage.create({
        data: {
          userId: r.userId,
          gmailId: r.gmailId,
          to: r.to,
          subject: r.subject,
          sentAt: r.sentAt,
          inbox: r.inbox,
          origin: r.origin,
        },
      });
    }
  }
}

async function seed(copy: Copy): Promise<void> {
  const a = await copy.user();
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
  copy.sent("approved", a, {
    to: "pat@x.example",
    subject: "Hi",
    sentAt: T,
    gmailId: "m-approved",
  });

  const b = await copy.user();
  await copy.inbound(b, { gmailId: "g-b", from: "Bob <bob@x.example>", subject: "Hello" });
  await copy.claim(b, { gmailId: "g-b", to: "bob@x.example" });
  copy.sent("autoReply", b, { to: "bob@x.example", subject: "Re: Hello", sentAt: at(1) });
  copy.sent("manualAfterAuto", b, { to: "bob@x.example", subject: "Re: Hello", sentAt: at(60) });
  copy.sent("manualFiveMinutes", b, { to: "bob@x.example", subject: "Re: Hello", sentAt: at(300) });
  copy.sent("alreadyLabelled", b, {
    to: "bob@x.example",
    subject: "Re: Hello",
    sentAt: at(2),
    origin: "user",
  });

  const c = await copy.user();
  await copy.inbound(c, { gmailId: "g-c", from: "Cat <cat@x.example>", subject: "Invoice" });
  await copy.claim(c, { gmailId: "g-c", to: "cat@x.example", title: "Auto-reply failed" });
  copy.sent("afterFailedClaim", c, { to: "cat@x.example", subject: "Re: Invoice", sentAt: at(30) });

  const d = await copy.user();
  await copy.inbound(d, {
    mailto: "mailto:Unsub@List.example?subject=remove+%3Cme%3E",
    receivedAt: at(-3600),
  });
  copy.sent("unsubExact", d, { to: "unsub@list.example", subject: "remove <me>", sentAt: T });
  copy.sent("unsubBeforeCarrier", d, {
    to: "unsub@list.example",
    subject: "remove <me>",
    sentAt: at(-7200),
  });
  copy.sent("unsubOtherInbox", d, {
    to: "unsub@list.example",
    subject: "remove <me>",
    sentAt: T,
    inbox: "linked-1",
  });

  const e = await copy.user();
  await copy.inbound(e, {
    mailto: "mailto:u@lists.example?subject=unsub-AbCdEf0123456789XyZ",
    receivedAt: at(-3600),
  });
  copy.sent("unsubToken", e, {
    to: "u@lists.example",
    subject: "unsub-ZzYyXx9876543210AbC",
    sentAt: T,
  });

  const f = await copy.user();
  await copy.inbound(f, {
    mailto: "mailto:info@brand.example?subject=Unsubscribe",
    receivedAt: at(-3600),
  });
  copy.sent("manualToMailbox", f, {
    to: "info@brand.example",
    subject: "Question about order 123",
    sentAt: T,
  });

  const g = await copy.user();
  await copy.inbound(g, { gmailId: "g-b", from: "Bob <bob@x.example>", subject: "Hello" });
  copy.sent("otherUsersClaim", g, { to: "bob@x.example", subject: "Re: Hello", sentAt: at(1) });

  // Target derivations the SQL does differently from parseMailtoTarget.
  const h = await copy.user();
  const long = "a".repeat(300);
  const carriers = [
    `mailto:long@list.example?subject=${long}`,
    "mailto:cafe@list.example?subject=caf%C3%A9",
    "mailto:a%40b.example",
    "mailto:not-an-address",
    "mailto:frag@list.example?subject=bye#x",
    "mailto:ws@list.example?subject=%20%20hi%09",
    "mailto:nul@list.example?subject=a%00b",
    "mailto:tok@lists.example?subject=unsub-AbCdEf0123456789XyZ",
  ];
  for (const mailto of carriers) await copy.inbound(h, { mailto, receivedAt: at(-3600) });
  await copy.inbound(h, { from: "Tok <TOK@lists.example>", subject: "A real person" });
  copy.sent("longSubject", h, { to: "long@list.example", subject: long, sentAt: T });
  copy.sent("rawEscapeKept", h, { to: "cafe@list.example", subject: "caf%C3%A9", sentAt: T });
  copy.sent("rawEscapeDecoded", h, { to: "cafe@list.example", subject: "café", sentAt: T });
  copy.sent("encodedAddress", h, { to: "a@b.example", subject: "unsubscribe", sentAt: T });
  copy.sent("looseAddress", h, { to: "not-an-address", subject: "unsubscribe", sentAt: T });
  copy.sent("fragment", h, { to: "frag@list.example", subject: "bye", sentAt: T });
  copy.sent("trimmedSubject", h, { to: "ws@list.example", subject: "hi", sentAt: T });
  copy.sent("nulEscapeKept", h, { to: "nul@list.example", subject: "a%00b", sentAt: T });
  copy.sent("tokenToSender", h, {
    to: "tok@lists.example",
    subject: "unsub-ZzYyXx9876543210AbC",
    sentAt: T,
  });
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

const sqlLabels = new Map<string, string | null>();
const tsLabels = new Map<string, string | null>();

describePg("sent provenance: the classifier agrees with the backfill SQL on real Postgres", () => {
  beforeAll(async () => {
    const sqlCopy = new Copy();
    const tsCopy = new Copy();
    await seed(sqlCopy);
    await seed(tsCopy);

    // SQL copy: every row in the table, then the migration's UPDATEs.
    await sqlCopy.insert(sqlCopy.rows);
    await runMigration();
    for (const r of sqlCopy.rows) {
      const row = await prisma.sentMessage.findUniqueOrThrow({
        where: { userId_gmailId: { userId: r.userId, gmailId: r.gmailId } },
        select: { origin: true },
      });
      sqlLabels.set(r.key, row.origin);
    }

    // TS copy: rows labelled at send time are already there; the rest are new
    // to the classifier, one batch per user, through the real loaders. The
    // labels are read from the classifier, not the table: another pg file can
    // run the migration's UPDATEs over the same database meanwhile.
    await tsCopy.insert(tsCopy.rows.filter((r) => r.origin !== null));
    for (const r of tsCopy.rows) if (r.origin !== null) tsLabels.set(r.key, r.origin);
    const fresh = tsCopy.rows.filter((r) => r.origin === null);
    for (const userId of new Set(fresh.map((r) => r.userId))) {
      const batch = fresh.filter((r) => r.userId === userId);
      const labels = await classifySentRows(userId, batch);
      for (const r of batch) tsLabels.set(r.key, labels.get(r.gmailId) ?? null);
    }
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: created } } });
  });

  it("labels every fixture the same way", () => {
    expect(Object.fromEntries(tsLabels)).toEqual(Object.fromEntries(sqlLabels));
  });

  it("is not vacuous: the fixtures exercise every label and null", () => {
    expect(Object.fromEntries(sqlLabels)).toEqual({
      approved: "approved",
      autoReply: "auto_reply",
      manualAfterAuto: null,
      manualFiveMinutes: null,
      alreadyLabelled: "user",
      afterFailedClaim: null,
      unsubExact: "unsubscribe",
      unsubBeforeCarrier: null,
      unsubOtherInbox: null,
      unsubToken: "unsubscribe",
      manualToMailbox: null,
      otherUsersClaim: null,
      longSubject: "unsubscribe",
      rawEscapeKept: "unsubscribe",
      rawEscapeDecoded: null,
      encodedAddress: null,
      looseAddress: "unsubscribe",
      fragment: "unsubscribe",
      trimmedSubject: "unsubscribe",
      nulEscapeKept: "unsubscribe",
      tokenToSender: null,
    });
  });
});
