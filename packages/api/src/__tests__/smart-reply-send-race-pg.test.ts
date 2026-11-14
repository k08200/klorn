import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real-Postgres proof that the smart action's Send cannot go out twice. The
// repeat check ("the same bytes to the same mail moments ago") used to be a
// read followed, a provider round trip later, by the receipt insert: two Sends
// fired together both read "nothing yet" and both sent. The check now runs
// under a claim row (mail/send-claim.ts) taken by one atomic INSERT ... ON
// CONFLICT, so exactly one request passes it. These requests go through the
// real route, the real send path and the real tables; only the provider, the
// session check and the billing gate are stubbed.
// Skipped unless KLORN_TEST_PG_URL points at a database with every migration
// applied; DATABASE_URL is set to the same URL because setup.ts loads db.ts first.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

const provider = vi.hoisted(() => ({ sendEmail: vi.fn() }));

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth.js")>()),
  // The device-session lookup is not under test; getUserId still reads the token.
  requireAuth: async () => {},
}));
vi.mock("../billing/entitlement-guard.js", () => ({ requireEntitled: async () => {} }));
vi.mock("../mail/providers/dispatch.js", () => ({
  mailActionsFor: async () => ({ sendEmail: provider.sendEmail }),
}));
vi.mock("../mail/reply-threading.js", () => ({
  // A provider round trip between the repeat check and the receipt insert: the
  // window the race needed.
  resolveReplyThreading: async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { threadId: "t1" };
  },
}));
vi.mock("../learning/contact-engagement.js", () => ({ recordContactEngagement: vi.fn() }));
vi.mock("../judge/user-outcome.js", () => ({ noteEmailOutcome: vi.fn() }));
vi.mock("../routes/email-replies.js", () => ({
  draftReplyForEmailId: vi.fn(),
  sendReplyDraftFailure: vi.fn(),
}));
vi.mock("../routes/calendar.js", () => ({ createUserCalendarEvent: vi.fn() }));

import { signToken } from "../auth.js";
import { prisma } from "../db.js";
import { sendEmailPayloadHash } from "../judge/attention-floor.js";
import { REPEAT_SEND_WINDOW_MS } from "../mail/reply-send.js";
import { smartActionsRoutes } from "../routes/smart-actions.js";

const describePg = url ? describe : describe.skip;
const TO = "boss@corp.example";
const SUBJECT = "Re: Need your reply today";
const BODY = "Sounds good, see you then.";
const created: string[] = [];

async function seed(): Promise<{ userId: string; emailId: string; token: string }> {
  const user = await prisma.user.create({ data: { email: `race-${randomUUID()}@test.local` } });
  created.push(user.id);
  const email = await prisma.emailMessage.create({
    data: {
      userId: user.id,
      gmailId: `g-${randomUUID()}`,
      threadId: "t1",
      from: `Boss <${TO}>`,
      to: "me@test.local",
      subject: "Need your reply today",
      body: "Can you confirm today?",
      receivedAt: new Date(),
    },
  });
  return {
    userId: user.id,
    emailId: email.id,
    token: signToken({ userId: user.id, email: user.email }),
  };
}

async function sendAll(
  seeded: { emailId: string; token: string },
  bodies: string[],
): Promise<number[]> {
  const app = Fastify();
  await app.register(smartActionsRoutes, { prefix: "/api/smart-actions" });
  try {
    const responses = await Promise.all(
      bodies.map((body) =>
        app.inject({
          method: "POST",
          url: `/api/smart-actions/emails/${seeded.emailId}/reply`,
          headers: {
            authorization: `Bearer ${seeded.token}`,
            "content-type": "application/json",
          },
          payload: JSON.stringify({
            body,
            payloadHash: sendEmailPayloadHash({ to: TO, subject: SUBJECT, body }),
          }),
        }),
      ),
    );
    return responses.map((res) => res.statusCode).sort();
  } finally {
    await app.close();
  }
}

describePg("smart action Send against real Postgres: one send per tap, however many arrive", () => {
  beforeEach(() => {
    vi.stubEnv("SMART_ACTIONS_ENABLED", "true");
    provider.sendEmail.mockReset();
    provider.sendEmail.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { success: true, messageId: `sent-${randomUUID()}`, threadId: "t1" };
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    if (created.length > 0) await prisma.user.deleteMany({ where: { id: { in: created } } });
  });

  it("two Sends of the same bytes fired together: exactly one goes out, the other is 409", async () => {
    const seeded = await seed();

    const statuses = await sendAll(seeded, [BODY, BODY]);

    expect(statuses).toEqual([200, 409]);
    expect(provider.sendEmail).toHaveBeenCalledTimes(1);
    const receipts = await prisma.sendReceipt.findMany({ where: { userId: seeded.userId } });
    expect(receipts.map((r) => r.status)).toEqual(["SENT"]);
    expect(await prisma.sendClaim.count({ where: { userId: seeded.userId } })).toBe(0);
  });

  it("six at once still send exactly once", async () => {
    const seeded = await seed();

    const statuses = await sendAll(seeded, Array(6).fill(BODY));

    expect(statuses).toEqual([200, 409, 409, 409, 409, 409]);
    expect(provider.sendEmail).toHaveBeenCalledTimes(1);
    expect(await prisma.sendReceipt.count({ where: { userId: seeded.userId } })).toBe(1);
  });

  it("different bytes to the same mail are not a repeat: each goes out", async () => {
    const seeded = await seed();

    const statuses = await sendAll(seeded, [BODY, `${BODY} Thanks.`]);

    expect(statuses).toEqual([200, 200]);
    expect(provider.sendEmail).toHaveBeenCalledTimes(2);
  });

  it("a provider refusal leaves nothing behind: the retry goes out", async () => {
    const seeded = await seed();
    provider.sendEmail.mockResolvedValueOnce({ error: "Gmail said no" });

    expect(await sendAll(seeded, [BODY])).toEqual([409]);
    expect(await sendAll(seeded, [BODY])).toEqual([200]);

    const receipts = await prisma.sendReceipt.findMany({
      where: { userId: seeded.userId },
      orderBy: { createdAt: "asc" },
    });
    expect(receipts.map((r) => r.status)).toEqual(["REFUSED", "SENT"]);
    expect(await prisma.sendClaim.count({ where: { userId: seeded.userId } })).toBe(0);
  });

  it("a claim left by a request that died holds for the repeat window, then is taken over", async () => {
    const seeded = await seed();
    const payloadHash = sendEmailPayloadHash({ to: TO, subject: SUBJECT, body: BODY });
    const claim = { userId: seeded.userId, emailId: seeded.emailId, payloadHash };
    await prisma.sendClaim.create({
      data: { ...claim, token: "dead", claimedAt: new Date(Date.now() - 60_000) },
    });

    expect(await sendAll(seeded, [BODY])).toEqual([409]);
    expect(provider.sendEmail).not.toHaveBeenCalled();

    await prisma.sendClaim.update({
      where: { userId_emailId_payloadHash: claim },
      data: { claimedAt: new Date(Date.now() - REPEAT_SEND_WINDOW_MS - 60_000) },
    });
    expect(await sendAll(seeded, [BODY])).toEqual([200]);
    expect(provider.sendEmail).toHaveBeenCalledTimes(1);
    expect(await prisma.sendClaim.count({ where: { userId: seeded.userId } })).toBe(0);
  });
});
