/**
 * The daily receipt is "today" in the USER's timezone. Its `date` used to be the
 * UTC calendar date of the local-midnight instant, so for any zone east of UTC
 * it was always the previous day: on 2026-10-15 in Seoul the activity page said
 * "Wednesday, October 14" while the briefing was for the 15th. And a user with no
 * automation config fell back to UTC, unlike every other per-user clock (KST).
 */

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeDb, Row } from "./helpers/fake-db.js";
import { createFakeDb } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
vi.mock("../auth.js", () => ({
  requireAuth: vi.fn(async () => {}),
  getUserId: vi.fn(() => "user-1"),
}));
vi.mock("../billing/entitlement-guard.js", () => ({ requireEntitled: vi.fn(async () => {}) }));

import { receiptRoutes } from "../routes/receipt.js";

// 08:00 on 2026-10-15 in Seoul is 23:00 on 2026-10-14 in UTC.
const KST_MORNING = new Date("2026-10-14T23:00:00.000Z");

const item = (id: string, surfacedAt: string): Row => ({
  id,
  userId: "user-1",
  source: "EMAIL",
  sourceId: `e-${id}`,
  type: "REPLY_NEEDED",
  title: `Title ${id}`,
  tier: "QUEUE",
  tierReason: "why",
  surfacedAt: new Date(surfacedAt),
  agentTierSetAt: null,
});

interface ReceiptWire {
  date: string;
  queued: Array<{ id: string }>;
}

async function receiptAt(now: Date, config: Row[], rows: Row[] = []): Promise<ReceiptWire> {
  vi.useFakeTimers({ toFake: ["Date"], now });
  dbHolder.current = createFakeDb({
    attentionItem: rows,
    automationConfig: config,
    pushDeliveryLog: [],
    pendingAction: [],
    emailProcessingLog: [],
  });
  const app = Fastify();
  await app.register(receiptRoutes, { prefix: "/api/inbox/receipt" });
  const res = await app.inject({ method: "GET", url: "/api/inbox/receipt/today" });
  await app.close();
  return res.json() as ReceiptWire;
}

afterEach(() => vi.useRealTimers());

describe("GET /api/inbox/receipt/today — the user's day", () => {
  it("dates the receipt by the user's local day, not the UTC date of its start", async () => {
    const r = await receiptAt(KST_MORNING, [
      { id: "c1", userId: "user-1", timezone: "Asia/Seoul" },
    ]);
    expect(r.date).toBe("2026-10-15");
  });

  it("covers local midnight to midnight across the UTC day boundary", async () => {
    const r = await receiptAt(
      KST_MORNING,
      [{ id: "c1", userId: "user-1", timezone: "Asia/Seoul" }],
      [
        item("before-local-midnight", "2026-10-14T14:59:59.000Z"), // 23:59:59 KST on the 14th
        item("after-local-midnight", "2026-10-14T15:00:00.000Z"), // 00:00 KST on the 15th
        item("this-morning", "2026-10-14T22:30:00.000Z"), // 07:30 KST
      ],
    );
    expect(r.queued.map((i) => i.id).sort()).toEqual(["after-local-midnight", "this-morning"]);
  });

  it("uses the same day in a zone west of UTC", async () => {
    // 16:00 on 2026-10-14 in Los Angeles (PDT, UTC-7).
    const r = await receiptAt(new Date("2026-10-14T23:00:00.000Z"), [
      { id: "c1", userId: "user-1", timezone: "America/Los_Angeles" },
    ]);
    expect(r.date).toBe("2026-10-14");
  });

  it("falls back to the product default zone (Asia/Seoul), not UTC, without a config", async () => {
    const r = await receiptAt(KST_MORNING, []);
    expect(r.date).toBe("2026-10-15");
  });
});
