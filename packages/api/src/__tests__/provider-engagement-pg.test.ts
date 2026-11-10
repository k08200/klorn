import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the provider-side engagement columns (migration
// 20261110000000_decision_label_provider_engagement): a reply or archive seen
// by Gmail sync lands in its own column, first wins, never before the
// judgement and never on another user's row; the Sent-scan reply stamp skips
// mail Klorn sent; and the lane-quality report keeps the two sources apart.
// Skipped unless KLORN_TEST_PG_URL points at a database with every migration
// applied.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import { stampDecisionOutcome, stampProviderEngagement } from "../judge/decision-label.js";
import { queryLaneQuality } from "../judge/lane-quality.js";
import { noteProviderReplies } from "../mail/provider-replies.js";

const describePg = url ? describe : describe.skip;
const createdUsers: string[] = [];
const HOUR = 3_600_000;

async function newUser(): Promise<string> {
  const user = await prisma.user.create({ data: { email: `provider-${randomUUID()}@test.local` } });
  createdUsers.push(user.id);
  return user.id;
}

async function newLabel(
  userId: string,
  over: { sourceId?: string; shownTier?: string; judgedAt?: Date } = {},
): Promise<string> {
  const sourceId = over.sourceId ?? randomUUID();
  await prisma.decisionLabel.create({
    data: {
      userId,
      source: "EMAIL",
      sourceId,
      shownTier: over.shownTier ?? "PUSH",
      features: { confidence: 0.9 },
      decidedBy: "llm",
      ...(over.judgedAt ? { judgedAt: over.judgedAt } : {}),
    },
  });
  return sourceId;
}

async function newMail(
  userId: string,
  threadId: string,
  receivedAt: Date,
  labels: string[] = ["INBOX"],
): Promise<string> {
  const row = await prisma.emailMessage.create({
    data: {
      userId,
      gmailId: `g-${randomUUID()}`,
      threadId,
      from: "Sarah <sarah@acme.example>",
      to: "me@test.local",
      subject: "Contract",
      labels,
      receivedAt,
    },
  });
  return row.id;
}

async function newSent(
  userId: string,
  threadId: string,
  sentAt: Date,
  origin: string | null,
): Promise<string> {
  const gmailId = `s-${randomUUID()}`;
  await prisma.sentMessage.create({
    data: {
      userId,
      gmailId,
      threadId,
      to: "sarah@acme.example",
      subject: "Re: Contract",
      sentAt,
      inbox: "primary",
      origin,
    },
  });
  return gmailId;
}

const label = (userId: string, sourceId: string) =>
  prisma.decisionLabel.findUniqueOrThrow({
    where: { userId_source_sourceId: { userId, source: "EMAIL", sourceId } },
  });

afterAll(async () => {
  if (!url) return;
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.$disconnect();
});

describePg("stampProviderEngagement (real Postgres)", () => {
  it("lands in its own column: a Klorn stamp first is kept, and the first provider stamp wins", async () => {
    const userId = await newUser();
    const sourceId = await newLabel(userId, { judgedAt: new Date(Date.now() - 2 * HOUR) });

    await stampDecisionOutcome(userId, "EMAIL", sourceId, "REPLIED");
    const klornReply = (await label(userId, sourceId)).repliedAt;
    const first = new Date(Date.now() - HOUR);
    await stampProviderEngagement(userId, "REPLIED", [sourceId], first);
    await stampProviderEngagement(userId, "REPLIED", [sourceId], new Date());

    const row = await label(userId, sourceId);
    expect(klornReply).toBeInstanceOf(Date);
    expect(row.repliedAt).toEqual(klornReply);
    expect(row.providerRepliedAt).toEqual(first);
    expect(row.outcome).toBeNull();
  });

  it("never stamps before the judgement, nor another user's row with the same sourceId", async () => {
    const owner = await newUser();
    const other = await newUser();
    const judgedAt = new Date(Date.now() - HOUR);
    const sourceId = await newLabel(owner, { judgedAt });
    await newLabel(other, { sourceId, judgedAt });

    const before = await stampProviderEngagement(
      owner,
      "ARCHIVED",
      [sourceId],
      new Date(judgedAt.getTime() - 60_000),
    );
    expect(before).toBe(0);
    expect((await label(owner, sourceId)).providerArchivedAt).toBeNull();

    const at = new Date();
    expect(await stampProviderEngagement(owner, "ARCHIVED", [sourceId], at)).toBe(1);
    expect((await label(owner, sourceId)).providerArchivedAt).toEqual(at);
    expect((await label(other, sourceId)).providerArchivedAt).toBeNull();
  });
});

describePg("noteProviderReplies (real Postgres)", () => {
  it("stamps the mail the user's own Gmail reply answered; Klorn's sends, other users and re-runs change nothing", async () => {
    const userId = await newUser();
    const stranger = await newUser();
    const threadId = `t-${randomUUID()}`;
    const t0 = new Date(Date.now() - 6 * HOUR);
    const mailId = await newMail(userId, threadId, t0);
    await newLabel(userId, { sourceId: mailId, judgedAt: new Date(t0.getTime() + 60_000) });
    // A note to self in the same thread carries SENT in the mirror: never a target.
    const selfCopy = await newMail(userId, threadId, new Date(t0.getTime() + 2 * 60_000), [
      "INBOX",
      "SENT",
    ]);
    await newLabel(userId, { sourceId: selfCopy, judgedAt: new Date(t0.getTime() + 3 * 60_000) });

    const autoReply = await newSent(userId, threadId, new Date(t0.getTime() + HOUR), "auto_reply");
    const viaKlorn = await newSent(userId, threadId, new Date(t0.getTime() + HOUR), "user");
    await noteProviderReplies(userId, [autoReply, viaKlorn]);
    expect((await label(userId, mailId)).providerRepliedAt).toBeNull();

    // Another user's send in a thread with the same id cannot reach this row.
    const foreign = await newSent(stranger, threadId, new Date(t0.getTime() + HOUR), null);
    await noteProviderReplies(stranger, [foreign]);
    await noteProviderReplies(userId, [foreign]);
    expect((await label(userId, mailId)).providerRepliedAt).toBeNull();

    const sentAt = new Date(t0.getTime() + 2 * HOUR);
    const own = await newSent(userId, threadId, sentAt, null);
    await noteProviderReplies(userId, [own, autoReply]);
    expect((await label(userId, mailId)).providerRepliedAt).toEqual(sentAt);
    expect((await label(userId, selfCopy)).providerRepliedAt).toBeNull();

    // Idempotent: the next scan (or a later reply) keeps the first reply time.
    const later = await newSent(userId, threadId, new Date(t0.getTime() + 3 * HOUR), null);
    await noteProviderReplies(userId, [own, later]);
    expect((await label(userId, mailId)).providerRepliedAt).toEqual(sentAt);
  });
});

describePg("queryLaneQuality provider split (real Postgres)", () => {
  it("counts Klorn engagement, what only the provider saw, and either source once (Klorn + provider-only = either)", async () => {
    const userId = await newUser();
    const until = new Date();
    const since = new Date(until.getTime() - 7 * 86_400_000);
    const judgedAt = new Date(until.getTime() - 2 * 86_400_000);
    const set = (sourceId: string, data: Record<string, Date>) =>
      prisma.decisionLabel.update({
        where: { userId_source_sourceId: { userId, source: "EMAIL", sourceId } },
        data,
      });
    const soon = new Date(judgedAt.getTime() + HOUR);
    const late = new Date(judgedAt.getTime() + 30 * HOUR);

    await set(await newLabel(userId, { judgedAt }), { repliedAt: soon });
    await set(await newLabel(userId, { judgedAt }), { providerRepliedAt: soon });
    await set(await newLabel(userId, { judgedAt }), { repliedAt: soon, providerRepliedAt: soon });
    await set(await newLabel(userId, { judgedAt }), { repliedAt: late, providerRepliedAt: soon });
    await set(await newLabel(userId, { judgedAt }), { providerArchivedAt: soon });
    await set(await newLabel(userId, { judgedAt }), { archivedAt: soon, providerArchivedAt: soon });
    await newLabel(userId, { judgedAt });

    const report = await queryLaneQuality({ since, until, userId });
    const push = report.lanes.find((l) => l.lane === "PUSH");

    expect(push).toMatchObject({
      judged: 7,
      matured: 7,
      replied24h: 2,
      archived: 1,
      anyOutcome: 4,
      // Provider-only: rows 2 and 4 (Klorn saw no reply within 24h), row 5.
      providerOnlyReplied24h: 2,
      providerOnlyArchived: 1,
      replied24hEither: 4,
      archivedEither: 2,
      anyEither: 6,
    });
  });
});
