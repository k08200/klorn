import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the ranked QUEUE (docs/design/attention-engine-v3.md
// §3(5) "Reasons and API contract", P3 PR2b). The order lives in SQL
// (judge/email-lanes.ts) and in memory (judge/v3/ranking.ts rankQueue, used by
// the firewall list); this pins the two to the same answer on the same rows,
// plus threads and the Reader's neighbours. Skipped unless KLORN_TEST_PG_URL
// points at a database with every migration applied; set DATABASE_URL to the
// same URL, since setup.ts loads db.ts before this file runs.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import {
  neighbourEmailIdsInLane,
  pageEmailIdsInLane,
  pageThreadsInLane,
} from "../judge/email-lanes.js";
import { IMPORTANCE_PRIOR } from "../judge/v3/importance.js";
import { isShownHeld } from "../judge/v3/item-wire.js";
import { type RankableItem, rankQueue } from "../judge/v3/ranking.js";

const describePg = url ? describe : describe.skip;
const NOW = new Date("2026-11-07T09:00:00.000Z");
const HOUR = 3_600_000;
const at = (h: number) => new Date(NOW.getTime() + h * HOUR);

interface Seed {
  key: string;
  receivedAt: Date;
  threadId?: string;
  /** null = no AttentionItem (unjudged mail sits in QUEUE). */
  item: {
    tier: string;
    v3Importance?: number | null;
    v3Due?: Date | null;
    heldAt?: Date | null;
    isManualOverride?: boolean;
    agentTierSetAt?: Date | null;
  } | null;
}

const SEEDS: Seed[] = [
  {
    key: "held-strong",
    receivedAt: at(-5),
    item: { tier: "QUEUE", v3Importance: 0.9, heldAt: at(-4) },
  },
  {
    key: "held-weak-early",
    receivedAt: at(-6),
    item: { tier: "QUEUE", v3Importance: 0.2, heldAt: at(-6) },
  },
  {
    key: "held-weak-late",
    receivedAt: at(-7),
    item: { tier: "QUEUE", v3Importance: 0.2, heldAt: at(-3) },
  },
  { key: "due-now", receivedAt: at(-9), item: { tier: "QUEUE", v3Importance: 0.5, v3Due: at(-1) } },
  { key: "due-3d", receivedAt: at(-2), item: { tier: "QUEUE", v3Importance: 0.5, v3Due: at(72) } },
  { key: "due-9d", receivedAt: at(-1), item: { tier: "QUEUE", v3Importance: 0.5, v3Due: at(216) } },
  { key: "vip-no-due", receivedAt: at(-10), item: { tier: "QUEUE", v3Importance: 1 } },
  { key: "never-v3", receivedAt: at(-0.5), item: { tier: "QUEUE" } },
  { key: "unjudged", receivedAt: at(-8), item: null },
  // Same score as never-v3 (0.2, no due): the newer mail wins the tie.
  { key: "never-v3-old", receivedAt: at(-11), item: { tier: "QUEUE" } },
  // A hold a human overrode, and one an agent moved: not held any more.
  {
    key: "held-overridden",
    receivedAt: at(-12),
    item: { tier: "QUEUE", v3Importance: 0.9, heldAt: at(-12), isManualOverride: true },
  },
  {
    key: "held-agent",
    receivedAt: at(-13),
    item: { tier: "QUEUE", v3Importance: 0.9, heldAt: at(-13), agentTierSetAt: at(-12) },
  },
  // Not in QUEUE at all.
  { key: "push", receivedAt: at(-1), item: { tier: "PUSH", v3Importance: 1 } },
  // Two messages of one thread: the thread ranks by its newest message.
  {
    key: "thread-old",
    receivedAt: at(-20),
    threadId: "t1",
    item: { tier: "QUEUE", v3Importance: 1, v3Due: at(1) },
  },
  {
    key: "thread-new",
    receivedAt: at(-0.25),
    threadId: "t1",
    item: { tier: "QUEUE", v3Importance: 0.3 },
  },
];

let userId = "";
const idOf = new Map<string, string>();
const keyOf = new Map<string, string>();

beforeAll(async () => {
  if (!url) return;
  const user = await prisma.user.create({ data: { email: `ranked-${randomUUID()}@test.local` } });
  userId = user.id;
  for (const seed of SEEDS) {
    const email = await prisma.emailMessage.create({
      data: {
        userId,
        gmailId: `g-${randomUUID()}`,
        threadId: seed.threadId ?? null,
        from: "Sender <s@example.com>",
        to: "me@test.local",
        subject: seed.key,
        receivedAt: seed.receivedAt,
      },
    });
    idOf.set(seed.key, email.id);
    keyOf.set(email.id, seed.key);
    if (!seed.item) continue;
    await prisma.attentionItem.create({
      data: {
        userId,
        source: "EMAIL",
        sourceId: email.id,
        type: "REPLY_NEEDED",
        title: seed.key,
        tier: seed.item.tier,
        v3Importance: seed.item.v3Importance ?? null,
        v3Due: seed.item.v3Due ?? null,
        heldAt: seed.item.heldAt ?? null,
        isManualOverride: seed.item.isManualOverride ?? false,
        agentTierSetAt: seed.item.agentTierSetAt ?? null,
      },
    });
  }
});

afterAll(async () => {
  if (!url) return;
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

const query = (over: Record<string, unknown> = {}) => ({
  userId,
  lane: "QUEUE" as const,
  scope: { kind: "all" as const },
  rankedAt: NOW,
  skip: 0,
  take: 50,
  ...over,
});

/** The in-memory order over the same rows, as the firewall list computes it. */
function expectedOrder(keys: string[]): string[] {
  const items: RankableItem[] = keys.map((key) => {
    const seed = SEEDS.find((s) => s.key === key);
    const item = seed?.item;
    const held =
      item &&
      isShownHeld({
        tier: item.tier,
        heldAt: item.heldAt ?? null,
        isManualOverride: item.isManualOverride ?? false,
        agentTierSetAt: item.agentTierSetAt ?? null,
        v3PolicyVersion: null,
        v3Decision: null,
        v3Due: null,
      });
    return {
      id: idOf.get(key) as string,
      receivedAt: seed?.receivedAt as Date,
      importance: item?.v3Importance ?? IMPORTANCE_PRIOR.unknown,
      due: item?.v3Due ? item.v3Due.toISOString() : null,
      heldAt: held ? (item?.heldAt ?? null) : null,
    };
  });
  return rankQueue(items, NOW).map((i) => keyOf.get(i.id) as string);
}

const QUEUE_KEYS = SEEDS.filter((s) => !s.item || s.item.tier === "QUEUE").map((s) => s.key);

describePg("ranked QUEUE: SQL and rankQueue agree", () => {
  it("orders the lane page exactly as rankQueue does", async () => {
    const page = await pageEmailIdsInLane(query());
    const got = page.ids.map((id) => keyOf.get(id));
    expect(got).toEqual(expectedOrder(QUEUE_KEYS));
    expect(page.total).toBe(QUEUE_KEYS.length);
    // Spot checks of the contract, independent of rankQueue.
    expect(got.slice(0, 3)).toEqual(["held-strong", "held-weak-early", "held-weak-late"]);
    expect(got).not.toContain("push");
  });

  it("pages the same order", async () => {
    const full = (await pageEmailIdsInLane(query())).ids;
    const second = (await pageEmailIdsInLane(query({ skip: 4, take: 4 }))).ids;
    expect(second).toEqual(full.slice(4, 8));
  });

  it("keeps today's time order when not ranked", async () => {
    const page = await pageEmailIdsInLane(query({ rankedAt: undefined }));
    const times = page.ids.map(
      (id) => SEEDS.find((s) => s.key === keyOf.get(id))?.receivedAt.getTime() ?? 0,
    );
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("ranks a thread by its newest message in the view", async () => {
    const threads = await pageThreadsInLane(query());
    const got = threads.rows.map((r) => keyOf.get(r.id));
    const flat = expectedOrder(QUEUE_KEYS.filter((k) => k !== "thread-old"));
    expect(got).toEqual(flat);
    expect(threads.rows.find((r) => keyOf.get(r.id) === "thread-new")?.threadCount).toBe(2);
  });

  it("the Reader's neighbours follow the ranked order, even for a mail moved out", async () => {
    const order = expectedOrder(QUEUE_KEYS);
    const mid = order[4] as string;
    const n = await neighbourEmailIdsInLane({ ...query(), emailId: idOf.get(mid) as string });
    expect(keyOf.get(n.newerId ?? "")).toBe(order[3]);
    expect(keyOf.get(n.olderId ?? "")).toBe(order[5]);

    // The PUSH mail is not in the view; it still gets neighbours from where it
    // would sit, rather than none.
    const outside = await neighbourEmailIdsInLane({
      ...query(),
      emailId: idOf.get("push") as string,
    });
    expect(outside.newerId !== null || outside.olderId !== null).toBe(true);

    // Another user's mail has no neighbours.
    const foreign = await neighbourEmailIdsInLane({
      ...query(),
      userId: randomUUID(),
      emailId: idOf.get(mid) as string,
    });
    expect(foreign).toEqual({ newerId: null, olderId: null });
  });
});
