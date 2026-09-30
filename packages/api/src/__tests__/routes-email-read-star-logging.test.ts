/**
 * Read/star/bulk-read routes write the local row whatever the provider said —
 * an accepted local/remote divergence (docs/providers/unified-platform-plan.md,
 * step B1). The responses stay exactly as they were; what this pins is that a
 * provider `{ error }` is no longer discarded silently: it is logged, with the
 * local row id and never the provider message id (IMAP ids embed the mailbox
 * address). An `unsupported` result (provider with no action surface) stays a
 * silent local-only update, and success logs nothing.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const db = vi.hoisted(() => ({
  emailFindFirst: vi.fn(),
  emailFindMany: vi.fn(),
  emailUpdate: vi.fn(async () => ({})),
  emailUpdateMany: vi.fn(async () => ({ count: 1 })),
}));

const actions = vi.hoisted(() => ({
  toggleRead: vi.fn(),
  toggleStar: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = {
    emailMessage: {
      findFirst: db.emailFindFirst,
      findMany: db.emailFindMany,
      update: db.emailUpdate,
      updateMany: db.emailUpdateMany,
    },
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
vi.mock("../mail/providers/dispatch.js", () => ({
  mailActionsFor: vi.fn(async () => actions),
}));
vi.mock("../mail/email-sync.js", () => ({ syncEmailByGmailId: vi.fn() }));
vi.mock("../analytics.js", () => ({ recordEvent: vi.fn() }));
vi.mock("../learning/contact-engagement.js", () => ({
  recordContactEngagement: vi.fn(async () => {}),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../billing/entitlement-guard.js", () => ({ requireEntitled: vi.fn(async () => {}) }));
vi.mock("../routes/email.js", () => ({ safeAttachmentFilename: (name: string) => name }));

const TOKEN = signToken({ userId: "user-1", email: "test@example.com" });
const headers = { authorization: `Bearer ${TOKEN}` };

async function buildApp() {
  const { registerEmailMutationsRoutes } = await import("../routes/email-mutations.js");
  const { registerEmailBulkRoutes } = await import("../routes/email-bulk.js");
  const app = Fastify();
  await app.register(registerEmailMutationsRoutes, { prefix: "/api/email" });
  await app.register(registerEmailBulkRoutes, { prefix: "/api/email" });
  return app;
}

const ROW = {
  id: "row-42",
  gmailId: "naver-imap:secret-mailbox@naver.com:42",
  linkedInboxAccountId: "acc-1",
};
const PROVIDER_ERROR = "Naver did not confirm the change.";

function warned(): string {
  return (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .flat()
    .map((a) => (a instanceof Error ? a.message : String(a)))
    .join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  db.emailFindFirst.mockResolvedValue(ROW);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("PATCH /api/email/:id/read and /star", () => {
  it.each([
    ["read", "toggleRead", { isRead: false }, { isRead: false }],
    ["star", "toggleStar", { isStarred: true }, { isStarred: true }],
  ] as const)("%s: a provider {error} is logged, the response and the local write are unchanged", async (path, method, body, localData) => {
    actions[method].mockResolvedValue({ error: PROVIDER_ERROR });
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/email/row-42/${path}`,
      headers,
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(db.emailUpdate).toHaveBeenCalledWith({ where: { id: "row-42" }, data: localData });
    const text = warned();
    expect(text).toContain(PROVIDER_ERROR);
    expect(text).toContain("row-42");
    expect(text).not.toContain("secret-mailbox@naver.com");
  });

  it.each([
    "toggleRead",
    "toggleStar",
  ] as const)("%s: an unsupported result stays a silent local-only update", async (method) => {
    actions[method].mockResolvedValue({ unsupported: true, error: "not supported yet" });
    const app = await buildApp();
    const path = method === "toggleRead" ? "read" : "star";
    const res = await app.inject({
      method: "PATCH",
      url: `/api/email/row-42/${path}`,
      headers,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(db.emailUpdate).toHaveBeenCalledTimes(1);
    expect(warned()).not.toContain("not supported yet");
  });

  it("logs nothing on success", async () => {
    actions.toggleRead.mockResolvedValue({ success: true });
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/email/row-42/read",
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(warned()).toBe("");
  });
});

describe("POST /api/email/bulk (mark-read)", () => {
  const rows = [
    { id: "r1", gmailId: "naver-imap:secret-mailbox@naver.com:1", linkedInboxAccountId: "a" },
    { id: "r2", gmailId: "naver-imap:secret-mailbox@naver.com:2", linkedInboxAccountId: "a" },
    { id: "r3", gmailId: "naver-imap:secret-mailbox@naver.com:3", linkedInboxAccountId: "a" },
  ];

  it("logs provider errors and thrown errors per item but keeps the response and the local write", async () => {
    db.emailFindMany.mockResolvedValue(rows);
    actions.toggleRead
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ error: PROVIDER_ERROR })
      .mockRejectedValueOnce(new Error("socket hang up"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/bulk",
      headers,
      payload: { ids: ["r1", "r2", "r3"], action: "mark-read" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, updatedCount: 3, failed: [] });
    expect(db.emailUpdateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", id: { in: ["r1", "r2", "r3"] } },
      data: { isRead: true },
    });
    const text = warned();
    expect(text).toContain(PROVIDER_ERROR);
    expect(text).toContain("socket hang up");
    expect(text).toContain("r2");
    expect(text).toContain("r3");
    expect(text).not.toContain("secret-mailbox@naver.com");
  });

  it("logs nothing when every provider call succeeds", async () => {
    db.emailFindMany.mockResolvedValue(rows);
    actions.toggleRead.mockResolvedValue({ success: true });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/email/bulk",
      headers,
      payload: { ids: ["r1", "r2", "r3"], action: "mark-unread" },
    });
    expect(warned()).toBe("");
  });
});
