/**
 * POST /api/email/bulk — decision-ledger stamps. A bulk archive stamps
 * ARCHIVED on exactly the rows that left the inbox (one query, the acting
 * user's rows only); a failed item is not stamped; mark-read is not an open
 * (nobody read those mails) and stamps nothing; and the response is the same
 * when the ledger write fails. The Subscriptions page reuses the archive path
 * through archiveEmailMessages and must not stamp (it acts on a sender).
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  emailFindMany: vi.fn(),
  emailDeleteMany: vi.fn(async () => ({ count: 1 })),
  emailUpdateMany: vi.fn(async () => ({ count: 1 })),
  labelUpdateMany: vi.fn(),
}));
const archive = vi.hoisted(() => vi.fn());

vi.mock("../auth.js", () => ({
  requireAuth: async () => {},
  getUserId: () => "user-1",
}));
vi.mock("../db.js", () => {
  const prisma = {
    emailMessage: {
      findMany: db.emailFindMany,
      deleteMany: db.emailDeleteMany,
      updateMany: db.emailUpdateMany,
    },
    decisionLabel: { updateMany: db.labelUpdateMany },
  };
  return { prisma, db: prisma };
});
vi.mock("../mail/providers/dispatch.js", () => ({
  mailActionsFor: vi.fn(async () => ({
    provider: "GOOGLE",
    archive,
    toggleRead: vi.fn(async () => ({ success: true })),
  })),
}));
vi.mock("../judge/attention-resolve.js", () => ({
  resolveAttentionForEmails: vi.fn(async () => {}),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { archiveEmailMessages, registerEmailBulkRoutes } from "../routes/email-bulk.js";

const row = (id: string) => ({ id, gmailId: `g-${id}`, linkedInboxAccountId: null });

async function buildApp() {
  const app = Fastify();
  await app.register(registerEmailBulkRoutes, { prefix: "/api/email" });
  return app;
}

async function stamps() {
  await new Promise((r) => setTimeout(r, 0));
  return db.labelUpdateMany.mock.calls.map((c) => c[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  db.emailFindMany.mockResolvedValue([row("e1"), row("e2")]);
  db.labelUpdateMany.mockResolvedValue({ count: 2 });
  archive.mockResolvedValue({ success: true });
});

const bulk = (app: Awaited<ReturnType<typeof buildApp>>, action: string) =>
  app.inject({ method: "POST", url: "/api/email/bulk", payload: { action, ids: ["e1", "e2"] } });

describe("POST /api/email/bulk — decision ledger", () => {
  it("stamps ARCHIVED on every archived row in one query", async () => {
    const app = await buildApp();
    const res = await bulk(app, "archive");

    expect(res.json()).toMatchObject({ success: true, updatedCount: 2 });
    expect(await stamps()).toEqual([
      {
        where: {
          userId: "user-1",
          source: "EMAIL",
          sourceId: { in: ["e1", "e2"] },
          archivedAt: null,
        },
        data: { archivedAt: expect.any(Date) },
      },
    ]);
  });

  it("leaves a row that failed to archive unstamped", async () => {
    archive.mockImplementation(async (_u: string, gmailId: string) =>
      gmailId === "g-e2" ? { error: "refused" } : { success: true },
    );
    const app = await buildApp();
    const res = await bulk(app, "archive");

    expect(res.json()).toMatchObject({ success: false, updatedCount: 1 });
    const calls = await stamps();
    expect(calls).toHaveLength(1);
    expect(calls[0].where.sourceId).toEqual({ in: ["e1"] });
  });

  it("does not stamp a bulk mark-read: nobody opened those mails", async () => {
    const app = await buildApp();
    const res = await bulk(app, "mark-read");

    expect(res.statusCode).toBe(200);
    expect(await stamps()).toEqual([]);
  });

  it("answers exactly the same when the ledger write fails", async () => {
    const app = await buildApp();
    const ok = await bulk(app, "archive");
    db.labelUpdateMany.mockRejectedValue(new Error("ledger down"));
    const failed = await bulk(app, "archive");

    expect(failed.statusCode).toBe(ok.statusCode);
    expect(failed.body).toBe(ok.body);
  });

  it("does not stamp when the Subscriptions page archives a sender's mail", async () => {
    await archiveEmailMessages("user-1", [row("e1")] as never);
    expect(await stamps()).toEqual([]);
  });
});
