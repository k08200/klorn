/**
 * Free-tier wiring for the read surfaces a FREE user lands on once the paywall
 * is on: approvals (pending actions), commitments, the daily receipt, and API
 * keys. Each plugin used to sit entirely behind requireEntitled, so a FREE
 * session got 403 on plain READS (web Today "Could not load approvals", the
 * sidebar badge polling every minute). The split pinned here: reads and
 * no-effect triage go through requireAppAccess; anything that EXECUTES an
 * action, spends LLM money, creates work, or mints a credential whose every
 * use is paid stays requireEntitled.
 *
 * Boots the REAL guards under PAYWALL_ENABLED=true (config.ts reads it once at
 * module load, so each app gets a fresh module graph), then once with the
 * paywall off to prove pre-launch behaviour is unchanged.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ plan: "FREE", role: "USER" }));

vi.mock("../auth.js", () => ({
  resolveEffectiveJwtSecret: () => "test-secret",
  requireAuth: vi.fn(async (request: { userId?: string }) => {
    request.userId = "user-1";
  }),
  getUserId: vi.fn(() => "user-1"),
}));

const OWNED_COMMITMENT = {
  id: "c1",
  userId: "user-1",
  status: "OPEN",
  owner: "USER",
  title: "Send the deck",
};

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", plan: state.plan, role: state.role })),
    },
    pendingAction: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
    conversation: {
      findUnique: vi.fn(async () => ({ id: "conv-1", userId: "user-1" })),
    },
    attentionItem: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    pushDeliveryLog: { findMany: vi.fn(async () => []) },
    emailProcessingLog: { findMany: vi.fn(async () => []) },
    apiKey: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "k-new",
        ...data,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  return { prisma, db: prisma, INTERACTIVE_TX_OPTIONS: {} };
});

vi.mock("../agentcore/action-outbox.js", () => ({
  claimAndRunOutboxRow: vi.fn(),
  enqueueAction: vi.fn(),
}));
vi.mock("../agentcore/action-target.js", () => ({ resolveActionTarget: vi.fn(async () => null) }));
vi.mock("../judge/attention-mirror.js", () => ({
  upsertAttentionForPendingAction: vi.fn(async () => {}),
}));
vi.mock("../learning/feedback.js", () => ({
  recordFeedback: vi.fn(async () => {}),
  recipientFromToolArgs: () => null,
}));
vi.mock("../learning/trust-score.js", () => ({
  getTrustScoresBulk: vi.fn(async () => new Map()),
  updateTrustScore: vi.fn(async () => {}),
}));
vi.mock("../pim/commitments.js", () => ({
  listCommitments: vi.fn(async () => []),
  getCommitment: vi.fn(async () => OWNED_COMMITMENT),
  updateCommitment: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({
    ...OWNED_COMMITMENT,
    ...patch,
  })),
  deleteCommitment: vi.fn(async () => {}),
}));
vi.mock("../pim/commitment-path.js", () => ({
  buildPath: vi.fn(async () => ({ steps: [] })),
  getOrBuildPath: vi.fn(async () => ({ steps: [] })),
  materializeAllSteps: vi.fn(async () => ({ created: 0 })),
  materializeStepAsTask: vi.fn(async () => ({ taskId: "t1" })),
}));
vi.mock("../user-timezone.js", () => ({ getUserTimeZone: vi.fn(async () => "UTC") }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const ORIGINAL_PAYWALL = process.env.PAYWALL_ENABLED;

async function buildApp(paywall: boolean): Promise<FastifyInstance> {
  if (paywall) process.env.PAYWALL_ENABLED = "true";
  else delete process.env.PAYWALL_ENABLED;
  vi.resetModules();
  const { chatRoutes } = await import("../routes/chat-pending-actions.js");
  const { commitmentRoutes } = await import("../routes/commitments.js");
  const { receiptRoutes } = await import("../routes/receipt.js");
  const { apiKeyRoutes } = await import("../routes/api-keys.js");
  const app = Fastify();
  await app.register(chatRoutes, { prefix: "/api/chat" });
  await app.register(commitmentRoutes, { prefix: "/api/commitments" });
  await app.register(receiptRoutes, { prefix: "/api/inbox/receipt" });
  await app.register(apiKeyRoutes, { prefix: "/api/keys" });
  await app.ready();
  return app;
}

type Call = { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: unknown };

/** Reads and no-effect triage: a FREE user must get past the guard. */
const OPEN_TO_FREE: Array<Call & { status: number }> = [
  // Approvals list (Today, /assistant/approvals, /inbox, the sidebar badge).
  { method: "GET", url: "/api/chat/pending-actions", status: 200 },
  { method: "GET", url: "/api/chat/conversations/conv-1/pending-actions", status: 200 },
  // Dismissing or snoozing executes nothing — the handler runs (404: no row).
  { method: "POST", url: "/api/chat/pending-actions/a1/reject", payload: {}, status: 404 },
  {
    method: "POST",
    url: "/api/chat/pending-actions/a1/snooze",
    payload: { snoozeUntil: "2999-01-01T00:00:00.000Z" },
    status: 404,
  },
  // Commitment ledger: read + triage of the user's own rows.
  { method: "GET", url: "/api/commitments", status: 200 },
  { method: "GET", url: "/api/commitments/c1", status: 200 },
  { method: "PATCH", url: "/api/commitments/c1", payload: { status: "DONE" }, status: 200 },
  { method: "DELETE", url: "/api/commitments/c1", status: 204 },
  // The daily receipt (Activity).
  { method: "GET", url: "/api/inbox/receipt/today", status: 200 },
  // Existing API keys: list + revoke stay open so a downgraded user can clean up.
  { method: "GET", url: "/api/keys", status: 200 },
  { method: "DELETE", url: "/api/keys/k1", status: 200 },
];

/** Executes an action, spends LLM money, creates work, or mints a paid credential. */
const PAID_ONLY: Call[] = [
  { method: "POST", url: "/api/chat/pending-actions/a1/approve", payload: {} },
  { method: "GET", url: "/api/commitments/c1/path" },
  { method: "POST", url: "/api/commitments/c1/path/rebuild" },
  { method: "POST", url: "/api/commitments/c1/path/steps/0/materialize" },
  { method: "POST", url: "/api/commitments/c1/path/materialize-all" },
  { method: "POST", url: "/api/inbox/receipt/undo/a1" },
  { method: "POST", url: "/api/keys", payload: { name: "Claude" } },
];

const label = (c: Call) => `${c.method} ${c.url}`;

function send(app: FastifyInstance, c: Call) {
  return app.inject({ method: c.method, url: c.url, payload: c.payload as object | undefined });
}

/** The refusal code, or null for a body that is not JSON (a 204 has none). */
function bodyCode(res: { json: () => { code?: string } }): string | null {
  try {
    return res.json().code ?? null;
  } catch {
    return null;
  }
}

beforeEach(() => {
  state.plan = "FREE";
  state.role = "USER";
});

afterAll(() => {
  if (ORIGINAL_PAYWALL === undefined) delete process.env.PAYWALL_ENABLED;
  else process.env.PAYWALL_ENABLED = ORIGINAL_PAYWALL;
  vi.resetModules();
});

describe("free-tier surfaces (PAYWALL_ENABLED=true, FREE user)", () => {
  it.each(
    OPEN_TO_FREE.map((c) => [label(c), c] as const),
  )("%s is open to FREE", async (_name, c) => {
    const app = await buildApp(true);
    const res = await send(app, c);
    expect(bodyCode(res)).not.toBe("ENTITLEMENT_REQUIRED");
    expect(res.statusCode).toBe(c.status);
    await app.close();
  });

  it.each(
    PAID_ONLY.map((c) => [label(c), c] as const),
  )("%s refuses FREE with 403 ENTITLEMENT_REQUIRED", async (_name, c) => {
    const app = await buildApp(true);
    const res = await send(app, c);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("ENTITLEMENT_REQUIRED");
    await app.close();
  });

  it.each(
    PAID_ONLY.map((c) => [label(c), c] as const),
  )("%s admits a PRO user", async (_name, c) => {
    state.plan = "PRO";
    const app = await buildApp(true);
    const res = await send(app, c);
    expect(res.statusCode).not.toBe(403);
    await app.close();
  });
});

/**
 * These plugins are open to FREE at the plugin level and gate paid routes one
 * by one, so a NEW route would be free by default. Every registered route must
 * be classified here — an unclassified one fails this test until its author
 * decides (and, if it is paid, adds requireEntitled + a PAID_ONLY case).
 */
const ROUTE_CLASSIFICATION: Record<string, "free" | "paid"> = {
  "GET /api/chat/pending-actions": "free",
  "GET /api/chat/conversations/:id/pending-actions": "free",
  "POST /api/chat/pending-actions/:actionId/reject": "free",
  "POST /api/chat/pending-actions/:actionId/snooze": "free",
  "POST /api/chat/pending-actions/:actionId/approve": "paid",
  "GET /api/commitments": "free",
  "GET /api/commitments/:id": "free",
  "PATCH /api/commitments/:id": "free",
  "DELETE /api/commitments/:id": "free",
  "GET /api/commitments/:id/path": "paid",
  "POST /api/commitments/:id/path/rebuild": "paid",
  "POST /api/commitments/:id/path/steps/:index/materialize": "paid",
  "POST /api/commitments/:id/path/materialize-all": "paid",
  "GET /api/inbox/receipt/today": "free",
  "POST /api/inbox/receipt/undo/:pendingActionId": "paid",
  "GET /api/keys": "free",
  "GET /api/keys/:id/activity": "free",
  "DELETE /api/keys/:id": "free",
  "POST /api/keys": "paid",
};

describe("free-tier surfaces — every route is classified", () => {
  it("has no unclassified route in the free-open plugins", async () => {
    vi.resetModules();
    const { chatRoutes } = await import("../routes/chat-pending-actions.js");
    const { commitmentRoutes } = await import("../routes/commitments.js");
    const { receiptRoutes } = await import("../routes/receipt.js");
    const { apiKeyRoutes } = await import("../routes/api-keys.js");
    const app = Fastify();
    const seen: string[] = [];
    app.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const m of methods) if (m !== "HEAD") seen.push(`${m} ${route.url}`);
    });
    await app.register(chatRoutes, { prefix: "/api/chat" });
    await app.register(commitmentRoutes, { prefix: "/api/commitments" });
    await app.register(receiptRoutes, { prefix: "/api/inbox/receipt" });
    await app.register(apiKeyRoutes, { prefix: "/api/keys" });
    await app.ready();
    expect([...new Set(seen)].sort()).toEqual(Object.keys(ROUTE_CLASSIFICATION).sort());
    await app.close();
  });
});

describe("free-tier surfaces (paywall off — pre-launch unchanged)", () => {
  it.each(
    PAID_ONLY.map((c) => [label(c), c] as const),
  )("%s is not gated for FREE", async (_name, c) => {
    const app = await buildApp(false);
    const res = await send(app, c);
    expect(res.statusCode).not.toBe(403);
    await app.close();
  });
});
