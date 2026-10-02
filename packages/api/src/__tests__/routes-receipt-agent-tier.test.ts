/**
 * The daily receipt lists what Klorn did on the user's behalf, and "pushed" means
 * a push notification went out. A PUSH lane an MCP agent set (step A2b) sent
 * nothing, so the receipt must not claim it did: it is listed as queued, with no
 * push outcome, and is not counted as an interruption.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const NOON = new Date("2026-09-30T12:00:00.000Z");
const item = (id: string, tier: string, over: Row = {}): Row => ({
  id,
  userId: "user-1",
  source: "EMAIL",
  sourceId: `e-${id}`,
  type: "REPLY_NEEDED",
  title: `Title ${id}`,
  tier,
  tierReason: "why",
  surfacedAt: new Date(NOON.getTime() - 60_000),
  agentTierSetAt: null,
  ...over,
});

interface ReceiptWire {
  pushed: Array<{ id: string; pushStatus?: string }>;
  queued: Array<{ id: string; pushStatus?: string }>;
  summary: { totalInterrupted: number };
}

async function receipt(rows: Row[]): Promise<ReceiptWire> {
  dbHolder.current = createFakeDb({
    attentionItem: rows,
    automationConfig: [],
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

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: NOON }));
afterEach(() => vi.useRealTimers());

describe("GET /api/inbox/receipt/today", () => {
  it("lists a judge-tiered PUSH as pushed, as before", async () => {
    const r = await receipt([item("judge-push", "PUSH")]);
    expect(r.pushed.map((i) => i.id)).toEqual(["judge-push"]);
    expect(r.pushed[0].pushStatus).toBe("SENT");
    expect(r.summary.totalInterrupted).toBe(1);
  });

  it("lists an agent-set PUSH as queued with no push outcome, and does not count it as an interruption", async () => {
    const r = await receipt([
      item("agent-push", "PUSH", { agentTierSetAt: new Date("2026-09-30T11:00:00.000Z") }),
      item("judge-push", "PUSH"),
    ]);
    expect(r.pushed.map((i) => i.id)).toEqual(["judge-push"]);
    expect(r.queued.map((i) => i.id)).toEqual(["agent-push"]);
    expect(r.queued[0].pushStatus).toBeUndefined();
    expect(r.summary.totalInterrupted).toBe(1);
  });

  it("an agent-set lane other than PUSH is listed exactly as any other item of that lane", async () => {
    const r = await receipt([item("agent-silent", "SILENT", { agentTierSetAt: NOON })]);
    expect(r.pushed).toEqual([]);
    expect(r.queued).toEqual([]);
  });
});
