import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the IP24 report SQL (src/judge/ip24.ts) over the
// columns of migration 20261112020000_decision_label_ring_snapshot: which rows
// are rings, hits, opens and misses on the Klorn side and on the Gmail
// IMPORTANT baseline, the 24h maturity rule, the comparison set, and that the
// per-user rows carry no user id. Skipped unless KLORN_TEST_PG_URL points at a
// database with every migration applied.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import { queryIp24, queryIp24UserRows } from "../judge/ip24.js";

const describePg = url ? describe : describe.skip;
const createdUsers: string[] = [];
const HOUR = 3_600_000;
const NOW = Date.now();
const at = (msFromNow: number) => new Date(NOW + msFromNow);

async function newUser(): Promise<string> {
  const user = await prisma.user.create({ data: { email: `ip24-${randomUUID()}@test.local` } });
  createdUsers.push(user.id);
  return user.id;
}

interface LabelSpec {
  shownTier: string;
  judgedAt: Date;
  rangAt?: Date | null;
  gmailImportant: boolean | null;
  repliedAt?: Date;
  providerRepliedAt?: Date;
  openedAt?: Date;
  outcome?: string;
  outcomeAt?: Date;
}

async function newLabel(userId: string, spec: LabelSpec): Promise<void> {
  await prisma.decisionLabel.create({
    data: {
      userId,
      source: "EMAIL",
      sourceId: randomUUID(),
      features: { confidence: 0.9 },
      decidedBy: "llm",
      ...spec,
    },
  });
}

const JUDGED = at(-48 * HOUR);
const RANG = new Date(JUDGED.getTime() + 5_000);

afterAll(async () => {
  if (!url) return;
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.$disconnect();
});

describePg("IP24 report (real Postgres)", () => {
  it("counts rings, hits, opens and misses for Klorn and the Gmail baseline, per user", async () => {
    const a = await newUser();
    const b = await newUser();
    const base = { judgedAt: JUDGED };

    // r1: rang, Gmail-important, answered in Gmail 1h after the ring.
    await newLabel(a, {
      ...base,
      shownTier: "PUSH",
      rangAt: RANG,
      gmailImportant: true,
      providerRepliedAt: new Date(RANG.getTime() + HOUR),
    });
    // r2: rang, not Gmail-important, opened (from the notification) but never answered.
    await newLabel(a, {
      ...base,
      shownTier: "PUSH",
      rangAt: RANG,
      gmailImportant: false,
      openedAt: new Date(RANG.getTime() + 600_000),
    });
    // r3: did not ring, Gmail-important, answered in Klorn 1h after the judgement.
    await newLabel(a, {
      ...base,
      shownTier: "QUEUE",
      gmailImportant: true,
      repliedAt: new Date(JUDGED.getTime() + HOUR),
    });
    // r4: MEETING rang, the user confirmed the lane 3h later.
    await newLabel(a, {
      ...base,
      shownTier: "MEETING",
      rangAt: RANG,
      gmailImportant: false,
      outcome: "CONFIRM:MEETING",
      outcomeAt: new Date(RANG.getTime() + 3 * HOUR),
    });
    // r5: rang 2h ago: not 24h old yet, on either side.
    await newLabel(a, {
      shownTier: "PUSH",
      judgedAt: at(-2 * HOUR),
      rangAt: at(-2 * HOUR),
      gmailImportant: true,
    });
    // r6: did not ring, the user moved it to PUSH a day later.
    await newLabel(a, {
      ...base,
      shownTier: "INFO",
      gmailImportant: false,
      outcome: "OVERRIDE:PUSH",
      outcomeAt: new Date(JUDGED.getTime() + 30 * HOUR),
    });
    // r7: rang on IMAP mail (no Gmail snapshot): outside the comparison.
    await newLabel(a, { ...base, shownTier: "PUSH", rangAt: RANG, gmailImportant: null });
    // r8: rang, Gmail-important, answered 30h later: not within 24h.
    await newLabel(a, {
      ...base,
      shownTier: "PUSH",
      rangAt: RANG,
      gmailImportant: true,
      providerRepliedAt: new Date(RANG.getTime() + 30 * HOUR),
    });
    // r9: the urgent sweep rang a keyword-fallback QUEUE mail.
    await newLabel(a, { ...base, shownTier: "QUEUE", rangAt: RANG, gmailImportant: false });
    // r10: judged before the window.
    await newLabel(a, {
      shownTier: "PUSH",
      judgedAt: at(-10 * 24 * HOUR),
      rangAt: at(-10 * 24 * HOUR),
      gmailImportant: true,
      repliedAt: at(-10 * 24 * HOUR + HOUR),
    });
    // r11: PUSH held at a gate; the user confirmed PUSH an hour later.
    await newLabel(a, {
      ...base,
      shownTier: "PUSH",
      rangAt: null,
      gmailImportant: true,
      outcome: "CONFIRM:PUSH",
      outcomeAt: new Date(JUDGED.getTime() + HOUR),
    });
    // r12: pre-instrumentation row (no snapshot, no ring): outside the comparison.
    await newLabel(a, {
      ...base,
      shownTier: "QUEUE",
      gmailImportant: null,
      repliedAt: new Date(JUDGED.getTime() + 600_000),
    });

    // r13: held by quiet hours, answered in Gmail during them, then rang by the
    // summary after they ended: the reply came before the ring, so no hit.
    await newLabel(a, {
      ...base,
      shownTier: "PUSH",
      rangAt: new Date(JUDGED.getTime() + 3 * HOUR),
      gmailImportant: false,
      providerRepliedAt: new Date(JUDGED.getTime() + HOUR),
    });

    // User b: one unanswered ring on Gmail-important mail.
    await newLabel(b, { ...base, shownTier: "PUSH", rangAt: RANG, gmailImportant: true });

    // An off-app channel took a push for a in the window.
    await prisma.pushDeliveryLog.create({
      data: {
        userId: a,
        channel: "web",
        title: "t",
        status: "ACCEPTED",
        createdAt: at(-47 * HOUR),
      },
    });
    // b's only delivery attempt failed.
    await prisma.pushDeliveryLog.create({
      data: { userId: b, channel: "web", title: "t", status: "FAILED", createdAt: at(-47 * HOUR) },
    });

    const query = { since: at(-7 * 24 * HOUR), until: at(60_000), userIds: [a, b] };
    const rows = await queryIp24UserRows(query);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(Object.keys(r)).not.toContain("userId");

    const rowA = rows.find((r) => r.klornRings === 6);
    expect(rowA).toEqual({
      klornRings: 6, // r1 r2 r4 r8 r9 r13
      klornHits: 2, // r1 r4
      klornOpened: 1, // r2
      klornMisses: 3, // r3 r6 r11
      gmailRings: 4, // r1 r3 r8 r11
      gmailHits: 3, // r1 r3 r11
      gmailOpened: 0,
      gmailMisses: 3, // r4 r6 r13 (answered within 2h, Gmail would not ring)
      otherLaneRings: 1, // r9
      nonGmailRings: 1, // r7
      offAppDelivery: true,
    });

    const report = await queryIp24(query);
    expect(report.klorn.rings).toBe(7);
    expect(report.klorn.hits).toBe(2);
    expect(report.klorn.perUser).toEqual([
      { ip24: 2 / 6, n: 6, offAppDelivery: true },
      { ip24: 0, n: 1, offAppDelivery: false },
    ]);
    expect(report.klorn.offApp).toEqual({
      users: 1,
      rings: 6,
      hits: 2,
      ip24: 2 / 6,
      medianIp24: 2 / 6,
    });
    expect(report.gmail.rings).toBe(5);
    expect(report.gmail.hits).toBe(3);
    expect(report.notCompared).toEqual({ otherLaneRings: 1, nonGmailRings: 1 });
  });

  it("reads no one for an empty user list, never everyone", async () => {
    const a = await newUser();
    await newLabel(a, { judgedAt: JUDGED, shownTier: "PUSH", rangAt: RANG, gmailImportant: true });

    const rows = await queryIp24UserRows({
      since: at(-7 * 24 * HOUR),
      until: at(60_000),
      userIds: [],
    });

    expect(rows).toEqual([]);
  });
});
