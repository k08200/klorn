/**
 * /api/email/rules — the pins surface (list/compile/apply) and the PIN_TIER
 * shape hardening on the generic CRUD. The generic POST used to accept any
 * conditions JSON for any actionType; a PIN_TIER row now has to satisfy the
 * same validator the pin routes use, so the read-side invariants
 * (fetchPinnedTier) can't be bypassed by shape.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const ruleFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const ruleFindFirst = vi.hoisted(() => vi.fn(async () => null as unknown));
const ruleCreate = vi.hoisted(() => vi.fn(async () => ({ id: "r-new" })));
const ruleUpdate = vi.hoisted(() => vi.fn(async () => ({ id: "r-upd" })));
const ruleDelete = vi.hoisted(() => vi.fn(async () => ({})));
const ruleDeleteMany = vi.hoisted(() => vi.fn(async () => ({ count: 0 })));
const dbTransaction = vi.hoisted(() => vi.fn(async (ops: unknown[]) => Promise.all(ops)));
const compileMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = {
    emailRule: {
      findMany: ruleFindMany,
      findFirst: ruleFindFirst,
      create: ruleCreate,
      update: ruleUpdate,
      delete: ruleDelete,
      deleteMany: ruleDeleteMany,
    },
    $transaction: dbTransaction,
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../billing/entitlement-guard.js", () => ({
  requireEntitled: vi.fn(async () => {}),
  requireAppAccess: vi.fn(async () => {}),
}));
vi.mock("../mail/rule-compile.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../mail/rule-compile.js")>();
  return { ...original, compileRuleText: compileMock };
});

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp() {
  const { registerEmailRulesRoutes } = await import("../routes/email-rules.js");
  const app = Fastify();
  await app.register(async (scope) => {
    await registerEmailRulesRoutes(scope);
  });
  return app;
}

beforeEach(() => {
  ruleFindMany.mockReset();
  ruleFindMany.mockResolvedValue([]);
  ruleFindFirst.mockReset();
  ruleFindFirst.mockResolvedValue(null);
  ruleCreate.mockReset();
  ruleCreate.mockResolvedValue({ id: "r-new" });
  ruleUpdate.mockClear();
  ruleDeleteMany.mockClear();
  dbTransaction.mockClear();
  compileMock.mockReset();
});

describe("GET /rules/pins", () => {
  it("lists stored pins in wire shape", async () => {
    ruleFindMany.mockResolvedValue([
      { id: "r1", conditions: { fromDomain: ["acme.com"] }, actionValue: "SILENT" },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/rules/pins", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      pins: [{ id: "r1", scope: "domain", value: "acme.com", tier: "SILENT" }],
    });
    await app.close();
  });
});

describe("POST /rules/compile", () => {
  it("returns the compiler's pins for valid text", async () => {
    compileMock.mockResolvedValue({
      pins: [{ scope: "sender", value: "boss@acme.com", tier: "PUSH" }],
      unsupported: [],
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/rules/compile",
      headers: auth(),
      payload: { text: "boss@acme.com is urgent" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pins).toHaveLength(1);
    await app.close();
  });

  it("400s empty or oversized text without calling the LLM", async () => {
    const app = await buildApp();
    const empty = await app.inject({
      method: "POST",
      url: "/rules/compile",
      headers: auth(),
      payload: { text: "  " },
    });
    expect(empty.statusCode).toBe(400);
    const oversized = await app.inject({
      method: "POST",
      url: "/rules/compile",
      headers: auth(),
      payload: { text: "x".repeat(501) },
    });
    expect(oversized.statusCode).toBe(400);
    expect(compileMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("502s when the model's output is unusable", async () => {
    compileMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/rules/compile",
      headers: auth(),
      payload: { text: "some rule" },
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});

describe("POST /rules/pins", () => {
  it("applies valid pins and itemizes rejected ones", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/rules/pins",
      headers: auth(),
      payload: {
        pins: [
          { scope: "sender", value: "Boss@Acme.com", tier: "PUSH" },
          { scope: "domain", value: "gmail.com", tier: "SILENT" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.applied).toEqual([
      { id: "r-new", scope: "sender", value: "boss@acme.com", tier: "PUSH" },
    ]);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0].pin.value).toBe("gmail.com");
    await app.close();
  });

  it("400s a missing or oversized pins array", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "POST",
      url: "/rules/pins",
      headers: auth(),
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    const oversized = await app.inject({
      method: "POST",
      url: "/rules/pins",
      headers: auth(),
      payload: {
        pins: Array.from({ length: 21 }, () => ({
          scope: "sender",
          value: "a@b.com",
          tier: "PUSH",
        })),
      },
    });
    expect(oversized.statusCode).toBe(400);
    await app.close();
  });
});

describe("generic CRUD hardening for PIN_TIER", () => {
  it("rejects a PIN_TIER rule with an invalid shape (public domain)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/rules",
      headers: auth(),
      payload: {
        name: "sneaky",
        conditions: { fromDomain: ["gmail.com"] },
        actionType: "PIN_TIER",
        actionValue: "PUSH",
      },
    });
    expect(res.json().error).toBeTruthy();
    expect(ruleCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a PIN_TIER rule with multi-entity conditions", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/rules",
      headers: auth(),
      payload: {
        name: "multi",
        conditions: { from: ["a@b.com", "c@d.com"] },
        actionType: "PIN_TIER",
        actionValue: "PUSH",
      },
    });
    expect(res.json().error).toBeTruthy();
    await app.close();
  });

  it("accepts a well-shaped PIN_TIER rule", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/rules",
      headers: auth(),
      payload: {
        name: "Pin: boss@acme.com",
        conditions: { from: ["boss@acme.com"] },
        actionType: "PIN_TIER",
        actionValue: "PUSH",
      },
    });
    expect(res.json().rule).toBeTruthy();
    await app.close();
  });

  it("rejects a PATCH that would turn a rule into a malformed PIN_TIER", async () => {
    ruleFindFirst.mockResolvedValue({
      id: "r1",
      userId: "user-1",
      actionType: "AUTO_REPLY",
      conditions: { from: ["a@b.com"] },
      actionValue: "reply text",
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/rules/r1",
      headers: auth(),
      payload: { actionType: "PIN_TIER", actionValue: "NOT_A_TIER" },
    });
    expect(res.json().error).toBeTruthy();
    expect(ruleUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it("still updates non-pin rules as before", async () => {
    ruleFindFirst.mockResolvedValue({
      id: "r1",
      userId: "user-1",
      actionType: "AUTO_REPLY",
      conditions: { from: ["a@b.com"] },
      actionValue: "reply text",
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/rules/r1",
      headers: auth(),
      payload: { isActive: false },
    });
    expect(res.json().rule).toBeTruthy();
    await app.close();
  });
});

describe("PATCH on legacy malformed PIN_TIER rows", () => {
  it("allows an unrelated edit (isActive) on a pre-gate malformed pin row", async () => {
    // Rows authored before the shape gate existed can be malformed; the
    // gate must not lock the user out of disabling them.
    ruleFindFirst.mockResolvedValue({
      id: "legacy",
      userId: "user-1",
      actionType: "PIN_TIER",
      conditions: { from: ["a@b.com", "c@d.com"] },
      actionValue: "PUSH",
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/rules/legacy",
      headers: auth(),
      payload: { isActive: false },
    });
    expect(res.json().rule).toBeTruthy();
    await app.close();
  });

  it("still blocks a PATCH that edits the malformed shape without fixing it", async () => {
    ruleFindFirst.mockResolvedValue({
      id: "legacy",
      userId: "user-1",
      actionType: "PIN_TIER",
      conditions: { from: ["a@b.com", "c@d.com"] },
      actionValue: "PUSH",
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/rules/legacy",
      headers: auth(),
      payload: { actionValue: "SILENT" },
    });
    expect(res.json().error).toBeTruthy();
    await app.close();
  });
});

describe("AUTO_REPLY rules must name their senders", () => {
  const post = async (conditions: unknown, actionType = "AUTO_REPLY") => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/rules",
      headers: auth(),
      payload: { name: "r", conditions, actionType, actionValue: "Thanks!" },
    });
    return res.json() as { error?: string; rule?: unknown };
  };

  it("refuses an auto-reply with no sender, a string sender, or a non-string one", async () => {
    for (const conditions of [
      {},
      { subjectContains: ["x"] },
      { from: "boss@co.example" },
      { from: [123] },
      { from: ["  "] },
    ]) {
      expect((await post(conditions)).error, JSON.stringify(conditions)).toMatch(/sender/i);
    }
    expect(ruleCreate).not.toHaveBeenCalled();
  });

  it("creates an auto-reply that names a sender, and a draft rule without one", async () => {
    expect((await post({ from: ["boss@co.example"] })).error).toBeUndefined();
    expect((await post({}, "DRAFT_REPLY")).error).toBeUndefined();
    expect(ruleCreate).toHaveBeenCalledTimes(2);
  });

  it("refuses a PATCH that leaves an auto-reply without a sender, but still lets it be switched off", async () => {
    ruleFindFirst.mockResolvedValue({
      id: "r1",
      userId: "user-1",
      actionType: "DRAFT_REPLY",
      actionValue: "x",
      conditions: {},
    });
    const app = await buildApp();
    const toAuto = await app.inject({
      method: "PATCH",
      url: "/rules/r1",
      headers: auth(),
      payload: { actionType: "AUTO_REPLY" },
    });
    expect((toAuto.json() as { error?: string }).error).toMatch(/sender/i);

    ruleFindFirst.mockResolvedValue({
      id: "r1",
      userId: "user-1",
      actionType: "AUTO_REPLY",
      actionValue: "x",
      conditions: { from: ["boss@co.example"] },
    });
    const strip = await app.inject({
      method: "PATCH",
      url: "/rules/r1",
      headers: auth(),
      payload: { conditions: {} },
    });
    expect((strip.json() as { error?: string }).error).toMatch(/sender/i);
    expect(ruleUpdate).not.toHaveBeenCalled();

    const off = await app.inject({
      method: "PATCH",
      url: "/rules/r1",
      headers: auth(),
      payload: { isActive: false },
    });
    expect((off.json() as { error?: string }).error).toBeUndefined();
    expect(ruleUpdate).toHaveBeenCalledTimes(1);
  });
});
