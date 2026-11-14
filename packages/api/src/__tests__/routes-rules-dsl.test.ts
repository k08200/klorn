/**
 * Rules DSL routes (routes/rules-dsl.ts), RULES_DSL_ENABLED:
 *   - off: every route is indistinguishable from one that does not exist,
 *     even without a session, and touches no table; cohort: only
 *     ROLLOUT_COHORT_USER_IDS get through;
 *   - every query and write is scoped to the token's user (IDOR);
 *   - dry-run writes nothing;
 *   - apply replaces editable pins only, in one transaction with an audit row,
 *     and never creates, changes or deletes a reply/send rule, a label rule,
 *     an unsupported pin or a LearnedRule; a stale baseHash is refused.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  calls: [] as Array<{ model: string; op: string; args: unknown }>,
  emailRules: [] as Row[],
  learnedRules: [] as Row[],
  items: [] as Row[],
  mails: [] as Row[],
  audits: [] as Row[],
  nextId: 1,
}));

const WRITE_OPS = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

function whereMatches(row: Row, where: Record<string, unknown> = {}): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown };
      if (c.in && !c.in.includes(value)) return false;
      if ("not" in c && value === c.not) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function pick(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
}

vi.mock("../db.js", () => {
  const table = (model: string, rows: () => Row[]) => {
    const record = (op: string, args: unknown) => store.calls.push({ model, op, args });
    return {
      findMany: vi.fn(
        async (args: { where?: Row; select?: Record<string, boolean>; take?: number }) => {
          record("findMany", args);
          const found = rows().filter((r) => whereMatches(r, args?.where));
          return found.slice(0, args?.take ?? found.length).map((r) => pick(r, args?.select));
        },
      ),
      create: vi.fn(async (args: { data: Row }) => {
        record("create", args);
        const row = {
          id: `new-${store.nextId++}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...args.data,
        };
        rows().push(row);
        return row;
      }),
      createMany: vi.fn(async (args: { data: Row[] }) => {
        record("createMany", args);
        for (const data of args.data) {
          rows().push({
            id: `new-${store.nextId++}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          });
        }
        return { count: args.data.length };
      }),
      updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
        record("updateMany", args);
        const hit = rows().filter((r) => whereMatches(r, args.where));
        for (const r of hit) Object.assign(r, args.data, { updatedAt: new Date() });
        return { count: hit.length };
      }),
      deleteMany: vi.fn(async (args: { where: Row }) => {
        record("deleteMany", args);
        const keep = rows().filter((r) => !whereMatches(r, args.where));
        const removed = rows().length - keep.length;
        rows().splice(0, rows().length, ...keep);
        return { count: removed };
      }),
    };
  };
  const prisma = {
    emailRule: table("emailRule", () => store.emailRules),
    learnedRule: table("learnedRule", () => store.learnedRules),
    attentionItem: table("attentionItem", () => store.items),
    emailMessage: table("emailMessage", () => store.mails),
    ruleChangeAudit: table("ruleChangeAudit", () => store.audits),
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => {
      store.calls.push({ model: "$", op: "$transaction", args: ops.length });
      return Promise.all(ops);
    }),
    user: {
      findUnique: vi.fn(async () => ({
        id: "user-1",
        email: "test@example.com",
        role: "USER",
        sessionsInvalidatedAt: null,
      })),
    },
    device: {
      findUnique: vi.fn(async () => ({
        id: "device-1",
        lastActiveAt: new Date(),
        createdAt: new Date(),
      })),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const TOKEN = signToken({ userId: "user-1", email: "test@example.com" });
const BASE = "/api/email/rules/dsl";
const ROUTES = [
  { method: "GET", url: `${BASE}/export` },
  { method: "POST", url: `${BASE}/validate` },
  { method: "POST", url: `${BASE}/dry-run` },
  { method: "POST", url: `${BASE}/apply` },
] as const;

async function call(
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  opts: { auth?: boolean } = {},
) {
  const { rulesDslRoutes } = await import("../routes/rules-dsl.js");
  const { installRouteAuthGuard } = await import("../security/route-auth-guard.js");
  const app = Fastify();
  // The production default-deny guard (#1748), so a missing session is
  // refused before the body is parsed, exactly as in registerApiRoutes.
  installRouteAuthGuard(app);
  await app.register(rulesDslRoutes, { prefix: BASE });
  const res = await app.inject({
    method,
    url,
    headers: opts.auth === false ? {} : { authorization: `Bearer ${TOKEN}` },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  await app.close();
  return res;
}

function writes() {
  return store.calls.filter((c) => WRITE_OPS.has(c.op) || c.op === "$transaction");
}

function rule(partial: Row): Row {
  const id = `seed-${store.nextId++}`;
  return {
    id,
    userId: "user-1",
    name: id,
    description: null,
    isActive: true,
    conditions: { from: [`${id}@x.co`] },
    actionType: "PIN_TIER",
    actionValue: "QUEUE",
    triggerCount: 0,
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, store.nextId)),
    updatedAt: new Date(Date.UTC(2026, 10, 1, 0, store.nextId)),
    ...partial,
  };
}

function seed() {
  store.emailRules.push(
    rule({ id: "boss", name: "Boss", conditions: { from: ["boss@x.co"] }, actionValue: "PUSH" }),
    rule({
      id: "acme",
      name: "Acme",
      conditions: { fromDomain: ["acme.io"] },
      actionValue: "INFO",
    }),
    rule({
      id: "reply",
      name: "Thanks",
      actionType: "AUTO_REPLY",
      conditions: { from: ["boss@x.co"] },
      actionValue: "Thanks!",
    }),
    rule({ id: "draft", name: "Drafts", actionType: "DRAFT_REPLY", actionValue: "tpl" }),
    rule({
      id: "multi",
      name: "Two",
      conditions: { from: ["a@x.co", "b@x.co"] },
      actionValue: "PUSH",
    }),
    // Another user's rules: never read, never touched.
    rule({ id: "theirs", userId: "user-2", name: "Theirs", conditions: { from: ["boss@x.co"] } }),
  );
  store.learnedRules.push(
    {
      id: "learned-1",
      userId: "user-1",
      pattern: "sender-domain",
      value: "learned.io",
      tier: "INFO",
      status: "APPLIED",
      evidenceCount: 4,
    },
    {
      id: "learned-2",
      userId: "user-2",
      pattern: "sender-domain",
      value: "other.io",
      tier: "PUSH",
      status: "APPLIED",
      evidenceCount: 9,
    },
  );
  const mails: Array<[string, string, string, string, boolean]> = [
    ["m1", "user-1", "Boss <boss@x.co>", "PUSH", false],
    ["m2", "user-1", "someone@acme.io", "INFO", false],
    ["m3", "user-1", "new@y.co", "QUEUE", false],
    ["m4", "user-2", "boss@x.co", "QUEUE", false],
  ];
  mails.forEach(([id, userId, from, tier, manual], i) => {
    store.mails.push({ id, userId, from, fromAddress: null, subject: `subject ${id}` });
    store.items.push({
      id: `item-${id}`,
      userId,
      source: "EMAIL",
      sourceId: id,
      tier,
      isManualOverride: manual,
      surfacedAt: new Date(Date.UTC(2026, 10, 10 - i)),
    });
  });
}

function snapshot() {
  return JSON.stringify({ rules: store.emailRules, learned: store.learnedRules });
}

beforeEach(() => {
  store.calls = [];
  store.emailRules = [];
  store.learnedRules = [];
  store.items = [];
  store.mails = [];
  store.audits = [];
  store.nextId = 1;
  process.env.RULES_DSL_ENABLED = "true";
  delete process.env.ROLLOUT_COHORT_USER_IDS;
  seed();
});

afterEach(() => {
  delete process.env.RULES_DSL_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});

describe("flag", () => {
  it.each(
    ROUTES,
  )("off: $method $url answers Fastify's default 404, before auth, reading nothing", async ({
    method,
    url,
  }) => {
    delete process.env.RULES_DSL_ENABLED;
    for (const auth of [true, false]) {
      store.calls = [];
      const res = await call(method, url, method === "POST" ? { text: "version 1" } : undefined, {
        auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        message: `Route ${method}:${url} not found`,
        error: "Not Found",
        statusCode: 404,
      });
      expect(store.calls).toEqual([]);
    }
  });

  it.each(ROUTES)("cohort: $method $url is 404 outside the cohort and open inside it", async ({
    method,
    url,
  }) => {
    process.env.RULES_DSL_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
    const body = method === "POST" ? { text: "version 1\n", baseHash: "x" } : undefined;
    const outside = await call(method, url, body);
    expect(outside.statusCode).toBe(404);
    expect(store.calls.filter((c) => c.model !== "user" && c.model !== "device")).toEqual([]);
    process.env.ROLLOUT_COHORT_USER_IDS = "someone-else,user-1";
    const inside = await call(method, url, body);
    expect(inside.statusCode).not.toBe(404);
  });

  it.each(ROUTES)("on: $method $url needs a session", async ({ method, url }) => {
    const res = await call(method, url, method === "POST" ? { text: "version 1" } : undefined, {
      auth: false,
    });
    expect(res.statusCode).toBe(401);
    expect(store.calls.filter((c) => c.model === "emailRule")).toEqual([]);
  });
});

describe("GET /export", () => {
  it("exports only the caller's rules, with read-only comments and a base hash", async () => {
    const res = await call("GET", `${BASE}/export`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      text: string;
      baseHash: string;
      ruleCount: number;
      readOnlyCount: number;
    };
    expect(body.ruleCount).toBe(2);
    expect(body.readOnlyCount).toBe(4);
    expect(body.baseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.text).toContain('when from address "boss@x.co"');
    expect(body.text).toContain('# reply rule "Thanks": auto-reply, 1 sender, active');
    expect(body.text).toContain('# learned: sender domain "learned.io" -> INFO');
    expect(body.text).not.toContain("Theirs");
    expect(body.text).not.toContain("other.io");
    expect(body.text).not.toContain("Thanks!");
    for (const c of store.calls.filter(
      (c) => c.model === "emailRule" || c.model === "learnedRule",
    )) {
      expect((c.args as { where: Row }).where.userId).toBe("user-1");
    }
    expect(writes()).toEqual([]);
  });
});

describe("POST /validate", () => {
  it("returns ok and the rule count for valid text", async () => {
    const res = await call("POST", `${BASE}/validate`, {
      text: 'version 1\nrule "a"\nwhen from address "a@b.co"\nthen lane PUSH',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, ruleCount: 1, errors: [], truncated: false });
    expect(writes()).toEqual([]);
  });

  it("returns line:column errors for invalid text, never a write", async () => {
    const res = await call("POST", `${BASE}/validate`, {
      text: 'version 1\nrule "a"\nwhen from address "a@b.co"\nthen lane AUTO',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: false,
      ruleCount: 0,
      errors: [{ line: 4, column: 11, code: "retired-lane" }],
    });
    expect(writes()).toEqual([]);
  });

  it("refuses text over 64 KiB with text-too-large", async () => {
    const res = await call("POST", `${BASE}/validate`, {
      text: `version 1\n#${"x".repeat(70 * 1024)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, errors: [{ code: "text-too-large" }] });
  });

  it("refuses a body far over the limit before parsing it", async () => {
    const res = await call("POST", `${BASE}/validate`, { text: "x".repeat(400 * 1024) });
    expect(res.statusCode).toBe(413);
  });

  it("refuses a missing or non-string text", async () => {
    expect((await call("POST", `${BASE}/validate`, {})).statusCode).toBe(400);
    expect((await call("POST", `${BASE}/validate`, { text: { a: 1 } })).statusCode).toBe(400);
  });
});

describe("POST /dry-run", () => {
  it("reports what would change on the caller's recent judged mail and writes nothing", async () => {
    const before = snapshot();
    const res = await call("POST", `${BASE}/dry-run`, {
      text: [
        "version 1",
        'rule "Boss"\nwhen from address "boss@x.co"\nthen lane MEETING',
        'rule "New"\nwhen from domain "y.co"\nthen lane SILENT',
      ].join("\n"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      examined: 3,
      changed: 3,
      manualKept: 0,
      transitions: expect.arrayContaining([
        { from: "PUSH", to: "MEETING", count: 1 },
        { from: "INFO", to: null, count: 1 },
        { from: "QUEUE", to: "SILENT", count: 1 },
      ]),
    });
    expect(writes()).toEqual([]);
    expect(snapshot()).toBe(before);
    for (const c of store.calls.filter((c) => c.model !== "user" && c.model !== "device")) {
      expect((c.args as { where: Row }).where.userId).toBe("user-1");
    }
  });

  it("answers 400 with errors for invalid text", async () => {
    const res = await call("POST", `${BASE}/dry-run`, { text: "version 1\nbogus" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "invalid-rules",
      errors: [{ line: 2, column: 1, code: "unexpected-token" }],
    });
    expect(store.calls.filter((c) => c.model === "attentionItem")).toEqual([]);
  });

  it("bounds the sample size", async () => {
    const text = "version 1\n";
    expect((await call("POST", `${BASE}/dry-run`, { text, limit: 0 })).statusCode).toBe(400);
    expect((await call("POST", `${BASE}/dry-run`, { text, limit: 501 })).statusCode).toBe(400);
    store.calls = [];
    expect((await call("POST", `${BASE}/dry-run`, { text, limit: 2 })).statusCode).toBe(200);
    const items = store.calls.find((c) => c.model === "attentionItem");
    expect((items?.args as { take: number }).take).toBe(2);
  });
});

describe("POST /apply", () => {
  async function exported() {
    return (await call("GET", `${BASE}/export`)).json() as { text: string; baseHash: string };
  }

  it("refuses a stale base hash with 409 and writes nothing", async () => {
    const { text } = await exported();
    store.calls = [];
    const res = await call("POST", `${BASE}/apply`, { text, baseHash: "0".repeat(64) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "rules-changed" });
    expect(writes()).toEqual([]);
  });

  it("refuses invalid text with 400 and writes nothing", async () => {
    const { baseHash } = await exported();
    store.calls = [];
    const res = await call("POST", `${BASE}/apply`, { text: "version 1\nbogus", baseHash });
    expect(res.statusCode).toBe(400);
    expect(writes()).toEqual([]);
  });

  it("requires a base hash", async () => {
    expect((await call("POST", `${BASE}/apply`, { text: "version 1" })).statusCode).toBe(400);
  });

  it("applying the unchanged export writes only the audit row", async () => {
    const before = snapshot();
    const { text, baseHash } = await exported();
    store.calls = [];
    const res = await call("POST", `${BASE}/apply`, { text, baseHash });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ added: 0, changed: 0, removed: 0, unchanged: 2 });
    expect(snapshot()).toBe(before);
    expect(store.audits).toHaveLength(1);
  });

  it("replaces editable pins in one transaction with an audit row, nothing else", async () => {
    const replyBefore = JSON.stringify(
      store.emailRules.filter((r) =>
        ["reply", "draft", "multi", "theirs"].includes(r.id as string),
      ),
    );
    const learnedBefore = JSON.stringify(store.learnedRules);
    const { baseHash } = await exported();
    store.calls = [];
    const text = [
      "version 1",
      'rule "Boss"\nwhen from address "boss@x.co"\nthen lane MEETING',
      'rule "New"\nwhen from domain "y.co"\nthen lane SILENT\ndisabled',
    ].join("\n");
    const res = await call("POST", `${BASE}/apply`, { text, baseHash });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Row;
    expect(body).toMatchObject({ added: 1, changed: 1, removed: 1, unchanged: 0 });
    expect(body.baseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.text).toContain('when from domain "y.co"');

    // One transaction holds every write, the audit row included.
    const tx = store.calls.filter((c) => c.op === "$transaction");
    expect(tx).toHaveLength(1);
    const writeCalls = writes().filter((c) => c.op !== "$transaction");
    for (const c of writeCalls) {
      const args = c.args as { where?: Row; data?: Row | Row[] };
      if (c.model === "emailRule" && args.where) {
        expect(args.where).toMatchObject({ userId: "user-1", actionType: "PIN_TIER" });
      }
      const rows = Array.isArray(args.data) ? args.data : args.data ? [args.data] : [];
      for (const row of rows) expect(row.userId ?? "user-1").toBe("user-1");
    }
    expect(writeCalls.map((c) => c.model).sort()).toEqual(
      ["emailRule", "emailRule", "emailRule", "ruleChangeAudit"].sort(),
    );

    // Reply/draft rules, the unsupported pin, the other user and LearnedRule: untouched.
    expect(
      JSON.stringify(
        store.emailRules.filter((r) =>
          ["reply", "draft", "multi", "theirs"].includes(r.id as string),
        ),
      ),
    ).toBe(replyBefore);
    expect(JSON.stringify(store.learnedRules)).toBe(learnedBefore);
    expect(store.calls.filter((c) => c.model === "learnedRule" && WRITE_OPS.has(c.op))).toEqual([]);

    // The pins now match the text.
    const pins = store.emailRules.filter(
      (r) => r.userId === "user-1" && r.actionType === "PIN_TIER" && r.id !== "multi",
    );
    expect(pins.map((r) => [r.id, r.actionValue, r.isActive, r.conditions])).toEqual([
      ["boss", "MEETING", true, { from: ["boss@x.co"] }],
      [expect.stringMatching(/^new-/), "SILENT", false, { fromDomain: ["y.co"] }],
    ]);

    // The audit row: counts and a hash, no rule content.
    expect(store.audits).toEqual([
      expect.objectContaining({
        userId: "user-1",
        source: "rules-dsl",
        ruleCount: 2,
        addedCount: 1,
        changedCount: 1,
        removedCount: 1,
        textHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(JSON.stringify(store.audits)).not.toContain("y.co");
  });

  it("an empty rule set removes the editable pins and keeps every other rule", async () => {
    const { baseHash } = await exported();
    const res = await call("POST", `${BASE}/apply`, { text: "version 1\n", baseHash });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ removed: 2 });
    expect(store.emailRules.map((r) => r.id).sort()).toEqual(["draft", "multi", "reply", "theirs"]);
    expect(store.learnedRules).toHaveLength(2);
  });

  it("a second apply with the first export's hash is refused", async () => {
    const { text, baseHash } = await exported();
    const first = await call("POST", `${BASE}/apply`, {
      text: `${text}\nrule "x"\nwhen from address "x@x.co"\nthen lane PUSH`,
      baseHash,
    });
    expect(first.statusCode).toBe(200);
    const second = await call("POST", `${BASE}/apply`, { text, baseHash });
    expect(second.statusCode).toBe(409);
  });
});
