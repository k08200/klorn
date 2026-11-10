/**
 * Regression coverage for the querystring schema hardening pass.
 *
 * Every route that reads request.query now declares a `schema.querystring`
 * (see routes/commitments.ts, routes/memory.ts, routes/phone.ts among
 * others). Before the schemas existed, a duplicated query param (?a=1&a=2)
 * reached the handler as an array instead of a string, which could throw
 * inside handler logic that assumes a scalar and surface as a 500. Fastify's
 * AJV-backed schema validation now rejects the duplicate with 400 before the
 * handler ever runs.
 *
 * Three representative routes across three different route files are
 * exercised here: commitments.ts (auth + entitlement-gated), memory.ts
 * (auth-gated), and phone.ts (public webhook, Twilio-signature gated). Each
 * asserts (a) a duplicated param 400s and (b) a normal single param still
 * reaches the handler.
 */
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

vi.mock("../mail/email.js", () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
}));
vi.mock("../judge/attention-mirror.js", () => ({
  upsertAttentionForCommitment: vi.fn(async () => undefined),
  deleteAttentionForCommitments: vi.fn(async () => undefined),
}));

const validateTwilioRequest = vi.fn(
  (_authToken: string, signature: string, _url: string, _params: Record<string, string>) =>
    signature === "valid-signature",
);
vi.mock("twilio", () => {
  const factory = Object.assign(
    vi.fn(() => ({ calls: { create: vi.fn() } })),
    {
      validateRequest: (...args: unknown[]) =>
        validateTwilioRequest(...(args as [string, string, string, Record<string, string>])),
    },
  );
  return { default: factory };
});

type CommitmentRow = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: string;
  dueAt: Date | null;
};
const commitments: CommitmentRow[] = [];

type MemRow = {
  id: string;
  userId: string;
  type: string;
  key: string;
  content: string;
  updatedAt: Date;
  [k: string]: unknown;
};
const memories = new Map<string, MemRow>();
let nextMemId = 1;

interface EscalationRow {
  id: string;
  userId: string;
  notificationId: string;
  gatherToken: string;
  title: string;
  status: string;
  acknowledgedAt: Date | null;
}
const escalations: EscalationRow[] = [];

vi.mock("../db.js", () => {
  const prisma = {
    commitment: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; status?: string } }) =>
        commitments.filter(
          (c) => c.userId === where.userId && (!where.status || c.status === where.status),
        ),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          commitments.find((c) => c.id === where.id) ?? null,
      ),
    },
    memory: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const rows: MemRow[] = [];
        for (const m of memories.values()) if (m.userId === where.userId) rows.push(m);
        return rows;
      }),
      groupBy: vi.fn(async () => [{ type: "preference", _count: memories.size }]),
    },
    phoneEscalation: {
      findUnique: vi.fn(async (args: unknown) => {
        const a = args as { where: { gatherToken?: string; id?: string } };
        if (a.where.gatherToken) {
          return escalations.find((e) => e.gatherToken === a.where.gatherToken) ?? null;
        }
        return escalations.find((e) => e.id === a.where.id) ?? null;
      }),
      update: vi.fn(async (args: unknown) => {
        const a = args as { where: { id: string }; data: Partial<EscalationRow> };
        const row = escalations.find((e) => e.id === a.where.id);
        if (!row) throw new Error("Record not found");
        Object.assign(row, a.data);
        return row;
      }),
    },
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })),
    },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

const TOKEN = signToken({ userId: "user-1", email: "test@example.com" });
const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` });

function seedCommitment(over: Partial<CommitmentRow> = {}): CommitmentRow {
  const row: CommitmentRow = {
    id: `c-${commitments.length + 1}`,
    userId: "user-1",
    title: "Send the deck",
    description: null,
    status: "OPEN",
    dueAt: null,
    ...over,
  };
  commitments.push(row);
  return row;
}

function seedMemory(over: Partial<MemRow> = {}): MemRow {
  const row: MemRow = {
    id: `mem-${nextMemId++}`,
    userId: "user-1",
    type: "fact",
    key: "k",
    content: "v",
    updatedAt: new Date(),
    ...over,
  };
  memories.set(row.id, row);
  return row;
}

function seedEscalation(overrides: Partial<EscalationRow> = {}): EscalationRow {
  const row: EscalationRow = {
    id: "esc-1",
    userId: "u1",
    notificationId: "n1",
    gatherToken: "tok-1",
    title: "Server is down",
    status: "PLACED",
    acknowledgedAt: null,
    ...overrides,
  };
  escalations.push(row);
  return row;
}

describe("querystring schema hardening — duplicated params 400, single params pass", () => {
  const ENV_KEYS = ["TWILIO_AUTH_TOKEN", "PUBLIC_URL", "RENDER_EXTERNAL_URL"] as const;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    commitments.length = 0;
    memories.clear();
    nextMemId = 1;
    escalations.length = 0;
    validateTwilioRequest.mockClear();
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.PUBLIC_URL = "https://api.example.com";
    delete process.env.RENDER_EXTERNAL_URL;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  describe("GET /api/commitments (routes/commitments.ts)", () => {
    async function buildApp() {
      const { commitmentRoutes } = await import("../routes/commitments.js");
      const app = Fastify();
      await app.register(commitmentRoutes, { prefix: "/api/commitments" });
      return app;
    }

    it("rejects a duplicated ?status param with 400", async () => {
      seedCommitment({ status: "OPEN" });
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/commitments?status=OPEN&status=DONE",
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("still serves a normal single ?status param", async () => {
      seedCommitment({ id: "open-1", status: "OPEN" });
      seedCommitment({ id: "done-1", status: "DONE" });
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/commitments?status=DONE",
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().commitments.map((c: { id: string }) => c.id)).toEqual(["done-1"]);
      await app.close();
    });
  });

  describe("GET /api/memories (routes/memory.ts)", () => {
    async function buildApp() {
      const { memoryRoutes } = await import("../routes/memory.js");
      const app = Fastify();
      await app.register(memoryRoutes, { prefix: "/api/memories" });
      return app;
    }

    it("rejects a duplicated ?type param with 400", async () => {
      seedMemory({ type: "fact" });
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/memories?type=fact&type=preference",
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("still serves a normal single ?type param", async () => {
      seedMemory({ id: "mem-1", type: "fact" });
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/memories?type=fact",
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().memories).toHaveLength(1);
      await app.close();
    });
  });

  describe("POST /api/phone/gather (routes/phone.ts)", () => {
    async function buildApp() {
      const { phoneRoutes } = await import("../routes/phone.js");
      const app = Fastify();
      await app.register(phoneRoutes, { prefix: "/api/phone" });
      return app;
    }

    const FORM_HEADERS = {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": "valid-signature",
    };

    it("rejects a duplicated ?token param with 400 before the Twilio signature check runs", async () => {
      seedEscalation();
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/phone/gather?token=tok-1&token=tok-2",
        headers: FORM_HEADERS,
        body: "Digits=2",
      });
      expect(res.statusCode).toBe(400);
      // Schema validation short-circuits before the handler — the signature
      // check (and thus the escalation lookup) never runs.
      expect(validateTwilioRequest).not.toHaveBeenCalled();
      await app.close();
    });

    it("still serves a normal single ?token param", async () => {
      seedEscalation();
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/phone/gather?token=tok-1",
        headers: FORM_HEADERS,
        body: "Digits=2",
      });
      expect(res.statusCode).toBe(200);
      expect(escalations[0]?.status).toBe("ACKNOWLEDGED");
      await app.close();
    });
  });
});
