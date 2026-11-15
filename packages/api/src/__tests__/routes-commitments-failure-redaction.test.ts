/**
 * PATCH /api/commitments/:id fires two writes and forgets them: the dismissal
 * feedback and the counterparty trust score. Their failures are Prisma errors
 * over the commitment's words and the counterparty's address and name; a
 * validation error renders all of them. The `.catch` handlers log facts only.
 */
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { callText } from "./helpers/canary.js";
import { DB_CANARY, validationErrorQuotingText } from "./helpers/prisma-canary.js";

vi.mock("../sentry.js", () => ({ captureError: vi.fn(), addBreadcrumb: vi.fn() }));
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
vi.mock("../learning/feedback.js", () => ({ recordFeedback: vi.fn(async () => undefined) }));
vi.mock("../learning/trust-score.js", () => ({
  getTrustScoresBulk: vi.fn(async () => new Map()),
  updateTrustScore: vi.fn(async () => undefined),
}));
vi.mock("../pim/commitment-completion.js", () => ({
  maybeRefreshCompletionSuggestions: vi.fn(async () => 0),
}));

type Row = Record<string, unknown> & { id: string; userId: string; status: string };
const rows = new Map<string, Row>();

vi.mock("../db.js", () => {
  const prisma = {
    commitment: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = { ...(rows.get(where.id) as Row), ...data };
          rows.set(where.id, row);
          return row;
        },
      ),
    },
    attentionItem: { findFirst: vi.fn(async () => ({ id: "ai-1" })) },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

const { recordFeedback } = await import("../learning/feedback.js");
const { updateTrustScore } = await import("../learning/trust-score.js");
const { captureError } = await import("../sentry.js");

const auth = { authorization: `Bearer ${signToken({ userId: "user-1", email: "t@e.com" })}` };

async function buildApp() {
  const { commitmentRoutes } = await import("../routes/commitments.js");
  const app = Fastify();
  await app.register(commitmentRoutes, { prefix: "/api/commitments" });
  return app;
}

function seed(over: Partial<Row> = {}): Row {
  const row: Row = {
    id: "c-1",
    userId: "user-1",
    title: "Send the deck",
    description: null,
    status: "OPEN",
    dueAt: null,
    ...over,
  };
  rows.set(row.id, row);
  return row;
}

describe("commitment PATCH — fire-and-forget failures are logged as facts", () => {
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    rows.clear();
    vi.mocked(captureError).mockClear();
    consoleSpies = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
  });

  const sinkText = () =>
    consoleSpies.map((spy) => callText(spy)).join("\n") + callText(vi.mocked(captureError));

  it("a failed dismissal feedback write", async () => {
    seed();
    vi.mocked(recordFeedback).mockRejectedValueOnce(validationErrorQuotingText());
    const app = await buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/commitments/c-1",
      headers: auth,
      payload: { status: "DISMISSED" },
    });

    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(sinkText()).toContain("recordFeedback DISMISSED failed"));
    expect(sinkText()).toContain("PrismaClientValidationError");
    expect(sinkText()).not.toContain(DB_CANARY);
    await app.close();
  });

  it("a failed counterparty trust-score write", async () => {
    seed({
      owner: "COUNTERPARTY",
      counterpartyEmail: `${DB_CANARY}@example.com`,
      counterpartyName: `${DB_CANARY} Kim`,
    });
    vi.mocked(updateTrustScore).mockRejectedValueOnce(validationErrorQuotingText());
    const app = await buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/commitments/c-1",
      headers: auth,
      payload: { status: "DONE" },
    });

    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(sinkText()).toContain("updateTrustScore failed"));
    expect(sinkText()).not.toContain(DB_CANARY);
    await app.close();
  });
});
