/**
 * POST /api/email/send with `inReplyToEmailId` — the web AI-draft reply.
 *
 * The web reply-draft panel lets the user edit to / subject / body, so it sends
 * through /send (not /:id/reply, which derives recipient and subject itself).
 * Before this field the send named no mail, so the answered mail never got its
 * reply chip, its REPLIED stamp on the decision ledger (#1651, the lane-quality
 * input), or a threaded "waiting on" row.
 *
 *   - an id of the caller's own mail: the bytes sent are exactly the confirmed
 *     to / subject / body; the reply threads into the original (thread id,
 *     In-Reply-To, References, as /:id/reply does) when the original lives on the
 *     account the mail leaves from; then the chip, REPLIED and SentMessage
 *     (origin "user", the original's thread) are recorded;
 *   - an id that is not the caller's: 404 before anything is sent or stamped;
 *   - a value that is not an id: 400, no lookup;
 *   - absent: the exact /send it always was, nothing stamped;
 *   - a refused or unknown send stamps nothing.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

interface EmailRow {
  id: string;
  userId: string;
  gmailId: string;
  threadId: string | null;
  linkedInboxAccountId: string | null;
}

/** Two users' mail: user-2's row must be unreachable from user-1's requests. */
const ROWS: EmailRow[] = [
  { id: "e1", userId: "user-1", gmailId: "g1", threadId: "t1", linkedInboxAccountId: null },
  { id: "e-li", userId: "user-1", gmailId: "g-li", threadId: "t-li", linkedInboxAccountId: "li-1" },
  { id: "e2", userId: "user-2", gmailId: "g2", threadId: "t2", linkedInboxAccountId: null },
];

interface EmailWhere {
  id?: string;
  userId?: string;
  OR?: Array<{ id?: string; gmailId?: string }>;
}

/** Applies the where clause the way Postgres would: a missing userId is not a scope. */
function matches(row: EmailRow, where: EmailWhere): boolean {
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.OR && !where.OR.some((c) => c.id === row.id || c.gmailId === row.gmailId)) {
    return false;
  }
  return true;
}

const db = vi.hoisted(() => ({
  linkedFindFirst: vi.fn(),
  emailFindFirst: vi.fn(),
  emailUpdateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
  labelUpdateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
  sentUpsert: vi.fn(async (_args: unknown) => ({})),
}));
const gmail = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  createEmailDraft: vi.fn(),
  getReplyHeaders: vi.fn(),
  markAsRead: vi.fn(),
  toggleReadGmail: vi.fn(),
  toggleStarGmail: vi.fn(),
  trashEmail: vi.fn(),
  untrashEmail: vi.fn(),
  archiveEmail: vi.fn(),
  unarchiveEmail: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = {
    linkedInboxAccount: { findFirst: db.linkedFindFirst },
    emailMessage: { findFirst: db.emailFindFirst, updateMany: db.emailUpdateMany },
    decisionLabel: { updateMany: db.labelUpdateMany },
    sentMessage: { upsert: db.sentUpsert },
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
vi.mock("../mail/gmail.js", () => gmail);
vi.mock("../mail/email-sync.js", () => ({ syncEmailByGmailId: vi.fn() }));
vi.mock("../analytics.js", () => ({ recordEvent: vi.fn() }));
vi.mock("../learning/contact-engagement.js", () => ({
  recordContactEngagement: vi.fn(async () => {}),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../billing/entitlement-guard.js", () => ({ requireEntitled: vi.fn(async () => {}) }));
vi.mock("../routes/email.js", () => ({ safeAttachmentFilename: (name: string) => name }));

const TOKEN = signToken({ userId: "user-1", email: "test@example.com" });

async function send(payload: Record<string, unknown>) {
  const { registerEmailMutationsRoutes } = await import("../routes/email-mutations.js");
  const app = Fastify();
  await app.register(registerEmailMutationsRoutes, { prefix: "/api/email" });
  const res = await app.inject({
    method: "POST",
    url: "/api/email/send",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
  await app.close();
  // The ledger stamp is fire-and-forget: let it settle before asserting.
  await new Promise((r) => setTimeout(r, 0));
  return res;
}

/** The draft as the user edited it: not the server-derived "Re: …" reply. */
const DRAFT = { to: "Carol <carol@example.com>", subject: "Different subject", body: "Sure, 3pm." };

const STAMP_E1 = {
  where: { userId: "user-1", source: "EMAIL", sourceId: "e1", repliedAt: null },
  data: { repliedAt: expect.any(Date) },
};

beforeEach(() => {
  vi.clearAllMocks();
  db.emailFindFirst.mockImplementation(
    async (args: { where: EmailWhere }) => ROWS.find((row) => matches(row, args.where)) ?? null,
  );
  db.linkedFindFirst.mockImplementation(async (args: { where: { id: string; userId: string } }) =>
    args.where.id === "li-1" && args.where.userId === "user-1"
      ? { id: "li-1", provider: "GOOGLE" }
      : null,
  );
  gmail.sendEmail.mockResolvedValue({ success: true, messageId: "sent-1", threadId: "t-new" });
  gmail.getReplyHeaders.mockResolvedValue({
    messageId: "<orig@corp.com>",
    references: "<a@corp.com>",
  });
});

describe("an AI-draft send that names the caller's own mail", () => {
  it("sends exactly the confirmed bytes, threaded into the original", async () => {
    const res = await send({ ...DRAFT, inReplyToEmailId: "e1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, messageId: "sent-1", threadId: "t-new" });

    // Ownership: the mail is read by id AND the caller's userId.
    expect(db.emailFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "e1", userId: "user-1" } }),
    );
    // Headers come from the original, read on the account it lives on.
    expect(gmail.getReplyHeaders).toHaveBeenCalledWith("user-1", "g1", null);
    expect(gmail.sendEmail).toHaveBeenCalledTimes(1);
    expect(gmail.sendEmail.mock.calls[0]).toEqual([
      "user-1",
      "Carol <carol@example.com>",
      "Different subject",
      "Sure, 3pm.",
      [],
      {
        threadId: "t1",
        inReplyTo: "<orig@corp.com>",
        references: "<a@corp.com> <orig@corp.com>",
      },
    ]);
  });

  it("stamps REPLIED on that mail's decision-ledger row exactly once", async () => {
    await send({ ...DRAFT, inReplyToEmailId: "e1" });
    expect(db.labelUpdateMany.mock.calls.map((c) => c[0])).toEqual([STAMP_E1]);
  });

  it("flips the mail's reply chip and records the reply as the user's", async () => {
    await send({ ...DRAFT, inReplyToEmailId: "e1" });
    expect(db.emailUpdateMany).toHaveBeenCalledTimes(1);
    expect(db.emailUpdateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", OR: [{ id: "e1" }, { gmailId: "e1" }] },
      data: { repliedAt: expect.any(Date) },
    });
    expect(db.sentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_gmailId: { userId: "user-1", gmailId: "sent-1" } },
        // The thread the provider reports: an edited subject can start a new one.
        create: expect.objectContaining({
          threadId: "t-new",
          to: "Carol <carol@example.com>",
          inbox: "primary",
          origin: "user",
        }),
      }),
    );
  });

  it("a provider that reports no thread id (IMAP) records the reply on the original's thread", async () => {
    gmail.sendEmail.mockResolvedValue({ success: true, messageId: "sent-1", threadId: null });
    await send({ ...DRAFT, inReplyToEmailId: "e1" });
    expect(db.sentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ threadId: "t1", origin: "user" }),
      }),
    );
  });

  it("a reply from the linked inbox the original lives on threads there", async () => {
    const res = await send({ ...DRAFT, linkedInboxAccountId: "li-1", inReplyToEmailId: "e-li" });
    expect(res.statusCode).toBe(200);
    expect(gmail.getReplyHeaders).toHaveBeenCalledWith("user-1", "g-li", "li-1");
    expect(gmail.sendEmail.mock.calls[0][5]).toEqual({
      threadId: "t-li",
      inReplyTo: "<orig@corp.com>",
      references: "<a@corp.com> <orig@corp.com>",
      linkedInboxAccountId: "li-1",
    });
    expect(db.labelUpdateMany.mock.calls.map((c) => c[0])).toEqual([
      { ...STAMP_E1, where: { ...STAMP_E1.where, sourceId: "e-li" } },
    ]);
  });

  it("a reply leaving from another account than the original's is not re-routed or threaded, but is recorded", async () => {
    // The original is in linked inbox li-1; the client sends from the primary inbox.
    const res = await send({ ...DRAFT, inReplyToEmailId: "e-li" });
    expect(res.statusCode).toBe(200);
    // The account the caller chose and the exact bytes, as /send always sent them.
    expect(gmail.sendEmail.mock.calls[0]).toEqual([
      "user-1",
      "Carol <carol@example.com>",
      "Different subject",
      "Sure, 3pm.",
      [],
      undefined,
    ]);
    expect(gmail.getReplyHeaders).not.toHaveBeenCalled();
    expect(db.emailUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", OR: [{ id: "e-li" }, { gmailId: "e-li" }] },
      }),
    );
    expect(db.labelUpdateMany).toHaveBeenCalledTimes(1);
    // The new message's own thread: the original's thread id belongs to another account.
    expect(db.sentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ threadId: "t-new", inbox: "primary", origin: "user" }),
      }),
    );
  });
});

describe("ownership: another user's mail id", () => {
  it("is 404 and nothing is sent, threaded, chipped or stamped", async () => {
    const res = await send({ ...DRAFT, inReplyToEmailId: "e2" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Email not found" });
    expect(db.emailFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "e2", userId: "user-1" } }),
    );
    expect(gmail.getReplyHeaders).not.toHaveBeenCalled();
    expect(gmail.sendEmail).not.toHaveBeenCalled();
    expect(db.emailUpdateMany).not.toHaveBeenCalled();
    expect(db.labelUpdateMany).not.toHaveBeenCalled();
    expect(db.sentUpsert).not.toHaveBeenCalled();
  });

  it("a provider id (gmailId) of the caller's mail is not an email id: 404", async () => {
    const res = await send({ ...DRAFT, inReplyToEmailId: "g1" });
    expect(res.statusCode).toBe(404);
    expect(gmail.sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    [42],
    [""],
    ["   "],
    [{ id: "e1" }],
    [["e1"]],
    ["x".repeat(129)],
  ])("a value that is not an email id (%j) is 400, with no lookup and no send", async (value) => {
    const res = await send({ ...DRAFT, inReplyToEmailId: value });
    expect(res.statusCode).toBe(400);
    expect(db.emailFindFirst).not.toHaveBeenCalled();
    expect(gmail.sendEmail).not.toHaveBeenCalled();
  });
});

describe("nothing is recorded unless the reply went out", () => {
  it("a provider refusal (400) stamps nothing", async () => {
    gmail.sendEmail.mockResolvedValue({ error: "Quota exceeded" });
    const res = await send({ ...DRAFT, inReplyToEmailId: "e1" });
    expect(res.statusCode).toBe(400);
    expect(db.emailUpdateMany).not.toHaveBeenCalled();
    expect(db.labelUpdateMany).not.toHaveBeenCalled();
    expect(db.sentUpsert).not.toHaveBeenCalled();
  });

  it("a send whose outcome is unknown (502) stamps nothing", async () => {
    const { SendOutcomeUnknownError } = await import("../mail/providers/send-outcome-unknown.js");
    gmail.sendEmail.mockRejectedValue(new SendOutcomeUnknownError());
    const res = await send({ ...DRAFT, inReplyToEmailId: "e1" });
    expect(res.statusCode).toBe(502);
    expect(db.emailUpdateMany).not.toHaveBeenCalled();
    expect(db.labelUpdateMany).not.toHaveBeenCalled();
    expect(db.sentUpsert).not.toHaveBeenCalled();
  });

  it("a thrown send stamps nothing", async () => {
    gmail.sendEmail.mockRejectedValue(new Error("socket hang up"));
    const res = await send({ ...DRAFT, inReplyToEmailId: "e1" });
    expect(res.statusCode).toBe(500);
    expect(db.emailUpdateMany).not.toHaveBeenCalled();
    expect(db.labelUpdateMany).not.toHaveBeenCalled();
  });

  it("answers exactly the same when the ledger write fails", async () => {
    const ok = await send({ ...DRAFT, inReplyToEmailId: "e1" });
    db.labelUpdateMany.mockRejectedValue(new Error("ledger down"));
    const failed = await send({ ...DRAFT, inReplyToEmailId: "e1" });
    expect(failed.statusCode).toBe(ok.statusCode);
    expect(failed.body).toBe(ok.body);
  });
});

describe("without inReplyToEmailId (compose, Mac, mobile)", () => {
  it.each([
    ["absent", {}],
    ["null", { inReplyToEmailId: null }],
  ])("%s → the exact /send it always was, nothing looked up or stamped", async (_label, extra) => {
    const res = await send({ ...DRAFT, ...extra });
    expect(res.statusCode).toBe(200);
    expect(gmail.sendEmail.mock.calls[0]).toEqual([
      "user-1",
      "Carol <carol@example.com>",
      "Different subject",
      "Sure, 3pm.",
      [],
      undefined,
    ]);
    expect(db.emailFindFirst).not.toHaveBeenCalled();
    expect(gmail.getReplyHeaders).not.toHaveBeenCalled();
    expect(db.emailUpdateMany).not.toHaveBeenCalled();
    expect(db.labelUpdateMany).not.toHaveBeenCalled();
    expect(db.sentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ threadId: "t-new", inbox: "primary", origin: "user" }),
      }),
    );
  });
});
