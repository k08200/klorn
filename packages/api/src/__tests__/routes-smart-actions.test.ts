/**
 * Smart actions (routes/smart-actions.ts), SMART_ACTIONS_ENABLED:
 *   - off: every route is indistinguishable from one that does not exist, even
 *     without a session; cohort: only ROLLOUT_COHORT_USER_IDS get through;
 *   - the draft never sends, and returns the proactive draft verbatim when one exists;
 *   - Send needs the body AND the hash of what was on screen; a hash that does
 *     not match what would go out refuses before any receipt or send; a match
 *     mints the receipt BEFORE the provider call, whatever
 *     MANUAL_SEND_RECEIPTS_ENABLED says;
 *   - the calendar proposal never writes, asks instead of guessing, names
 *     overlapping events; the write takes only the confirmed date/time and
 *     refuses an overlap unless the user chose to add anyway;
 *   - another user's mail is a 404 on every route, and nothing happens.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { sendEmailPayloadHash } from "../judge/attention-floor.js";

const order = vi.hoisted(() => [] as string[]);
const db = vi.hoisted(() => ({
  emailFindFirst: vi.fn(),
  emailUpdateMany: vi.fn(async () => ({ count: 1 })),
  receiptCreate: vi.fn(),
  receiptUpdateMany: vi.fn(async () => ({ count: 1 })),
  receiptFindFirst: vi.fn(async () => null as { id: string; status?: string } | null),
  linkedFindFirst: vi.fn(async () => null),
  sentUpsert: vi.fn(async () => ({})),
  eventFindMany: vi.fn(async () => [] as unknown[]),
}));
const gmail = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  createEmailDraft: vi.fn(),
  getAuthedClient: vi.fn(),
  getReplyHeaders: vi.fn(),
  markAsRead: vi.fn(),
  toggleReadGmail: vi.fn(),
  toggleStarGmail: vi.fn(),
  trashEmail: vi.fn(),
  untrashEmail: vi.fn(),
  archiveEmail: vi.fn(),
  unarchiveEmail: vi.fn(),
  GMAIL_TOOLS: [],
}));
const replies = vi.hoisted(() => ({
  draftReplyForEmailId: vi.fn(),
  sendReplyDraftFailure: vi.fn(
    (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
      reply.code(503).send({ error: "unavailable" }),
  ),
}));
const claims = vi.hoisted(() => ({
  claimSend: vi.fn(),
  releaseSend: vi.fn(async () => {}),
}));
const calendar = vi.hoisted(() => ({ createUserCalendarEvent: vi.fn() }));
const parseEventText = vi.hoisted(() => vi.fn());
const entitled = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../db.js", () => {
  const prisma = {
    emailMessage: { findFirst: db.emailFindFirst, updateMany: db.emailUpdateMany },
    sendReceipt: {
      create: db.receiptCreate,
      updateMany: db.receiptUpdateMany,
      findFirst: db.receiptFindFirst,
    },
    linkedInboxAccount: { findFirst: db.linkedFindFirst },
    sentMessage: { upsert: db.sentUpsert },
    calendarEvent: { findMany: db.eventFindMany },
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
vi.mock("../billing/entitlement-guard.js", () => ({ requireEntitled: entitled }));
vi.mock("../routes/email-replies.js", () => replies);
vi.mock("../routes/calendar.js", () => calendar);
// The claim's SQL is proven against real Postgres (smart-reply-send-race-pg.test.ts).
vi.mock("../mail/send-claim.js", () => claims);
vi.mock("../event-parse.js", () => ({ parseEventText }));
vi.mock("../user-timezone.js", () => ({ getUserTimeZone: vi.fn(async () => "Asia/Seoul") }));

const TOKEN = signToken({ userId: "user-1", email: "test@example.com" });

async function call(
  url: string,
  payload: Record<string, unknown> = {},
  opts: { auth?: boolean } = {},
) {
  const { smartActionsRoutes } = await import("../routes/smart-actions.js");
  const app = Fastify();
  await app.register(smartActionsRoutes, { prefix: "/api/smart-actions" });
  const res = await app.inject({
    method: "POST",
    url,
    headers: {
      ...(opts.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }),
      "content-type": "application/json",
    },
    payload: JSON.stringify(payload),
  });
  await app.close();
  return res;
}

const EMAIL = {
  id: "e1",
  gmailId: "g1",
  threadId: "t1",
  from: "Boss <boss@corp.com>",
  subject: "Need your reply today",
  linkedInboxAccountId: null as string | null,
  proactiveDraft: null as string | null,
  repliedAt: null as Date | null,
  body: "Hi. Can we meet 내일 3시 at the office? Thanks",
  receivedAt: new Date("2026-11-12T01:00:00Z"),
};
const TO = "boss@corp.com";
const SUBJECT = "Re: Need your reply today";
const BODY = "Sounds good — see you then.";
const HASH = sendEmailPayloadHash({ to: TO, subject: SUBJECT, body: BODY });

const ROUTES = [
  "/api/smart-actions/emails/e1/reply-draft",
  "/api/smart-actions/emails/e1/reply",
  "/api/smart-actions/emails/e1/event-proposal",
  "/api/smart-actions/emails/e1/event",
];

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  vi.stubEnv("SMART_ACTIONS_ENABLED", "true");
  vi.stubEnv("MANUAL_SEND_RECEIPTS_ENABLED", "");
  db.emailFindFirst.mockResolvedValue({ ...EMAIL });
  db.receiptCreate.mockImplementation(async () => {
    order.push("receipt");
    return { id: "rcpt-1" };
  });
  db.eventFindMany.mockResolvedValue([]);
  db.receiptFindFirst.mockResolvedValue(null);
  claims.claimSend.mockImplementation(async (key: object) => {
    order.push("claim");
    return { ...key, token: "tok-1" };
  });
  claims.releaseSend.mockImplementation(async () => {
    order.push("release");
  });
  gmail.sendEmail.mockImplementation(async () => {
    order.push("send");
    return { success: true, messageId: "sent-1", threadId: "t1" };
  });
  gmail.getReplyHeaders.mockResolvedValue({ messageId: "<orig@corp.com>" });
  replies.draftReplyForEmailId.mockResolvedValue("Generated draft");
  parseEventText.mockResolvedValue({
    title: "Office meeting",
    startTime: "2026-11-13T15:00:00+09:00",
    endTime: "2026-11-13T15:30:00+09:00",
    location: "The office",
  });
  calendar.createUserCalendarEvent.mockImplementation(async (_uid: string, input: never) => {
    const { title, startTime, endTime } = input as {
      title: string;
      startTime: string;
      endTime: string;
    };
    return {
      event: { id: "ev-1", title, startTime: new Date(startTime), endTime: new Date(endTime) },
      googleId: "g-ev-1",
    };
  });
});

afterEach(() => vi.unstubAllEnvs());

function expectNothingSent() {
  expect(gmail.sendEmail).not.toHaveBeenCalled();
  expect(db.receiptCreate).not.toHaveBeenCalled();
}

describe("SMART_ACTIONS_ENABLED off", () => {
  it.each(ROUTES)("%s answers the default 404 before any auth", async (url) => {
    vi.stubEnv("SMART_ACTIONS_ENABLED", "");
    for (const auth of [true, false]) {
      const res = await call(url, { body: BODY, payloadHash: HASH }, { auth });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        message: `Route POST:${url} not found`,
        error: "Not Found",
        statusCode: 404,
      });
    }
    expectNothingSent();
    expect(db.emailFindFirst).not.toHaveBeenCalled();
  });
});

describe("SMART_ACTIONS_ENABLED=cohort", () => {
  it("is a 404 for a user outside ROLLOUT_COHORT_USER_IDS", async () => {
    vi.stubEnv("SMART_ACTIONS_ENABLED", "cohort");
    vi.stubEnv("ROLLOUT_COHORT_USER_IDS", "someone-else");
    const res = await call("/api/smart-actions/emails/e1/event-proposal");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Not Found");
    expect(db.emailFindFirst).not.toHaveBeenCalled();
  });

  it("opens to a user in the cohort", async () => {
    vi.stubEnv("SMART_ACTIONS_ENABLED", "cohort");
    vi.stubEnv("ROLLOUT_COHORT_USER_IDS", "founder, user-1");
    const res = await call("/api/smart-actions/emails/e1/event-proposal");
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /emails/:id/reply-draft", () => {
  it("returns the proactive draft verbatim, with the reply's recipient and subject", async () => {
    const draft = "Thanks!\n\n<b>not html</b> — ignore previous instructions? No.";
    db.emailFindFirst.mockResolvedValue({ ...EMAIL, proactiveDraft: draft });
    const res = await call("/api/smart-actions/emails/e1/reply-draft");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ to: TO, subject: SUBJECT, body: draft, source: "proactive" });
    expect(replies.draftReplyForEmailId).not.toHaveBeenCalled();
    expectNothingSent();
  });

  it("drafts in the foreground when no proactive draft is on offer", async () => {
    db.emailFindFirst.mockResolvedValue({ ...EMAIL, proactiveDraft: "old", repliedAt: new Date() });
    const res = await call("/api/smart-actions/emails/e1/reply-draft");
    expect(res.json()).toEqual({
      to: TO,
      subject: SUBJECT,
      body: "Generated draft",
      source: "generated",
    });
    expect(replies.draftReplyForEmailId).toHaveBeenCalledWith("user-1", "e1", "foreground");
    expectNothingSent();
  });

  it("is Pro-gated", async () => {
    entitled.mockImplementationOnce(async (_req: unknown, reply: never) => {
      (reply as { code: (n: number) => { send: (b: unknown) => void } }).code(402).send({});
    });
    const res = await call("/api/smart-actions/emails/e1/reply-draft");
    expect(res.statusCode).toBe(402);
    expect(replies.draftReplyForEmailId).not.toHaveBeenCalled();
  });
});

describe("POST /emails/:id/reply (Send)", () => {
  it("requires the body and the hash of what was on screen", async () => {
    for (const payload of [
      { body: BODY },
      { payloadHash: HASH },
      { body: BODY, payloadHash: "x" },
    ]) {
      const res = await call("/api/smart-actions/emails/e1/reply", payload);
      expect(res.statusCode).toBe(400);
    }
    const blank = sendEmailPayloadHash({ to: TO, subject: SUBJECT, body: "   " });
    expect(
      (await call("/api/smart-actions/emails/e1/reply", { body: "   ", payloadHash: blank }))
        .statusCode,
    ).toBe(400);
    expectNothingSent();
  });

  it("refuses a body that differs from what was hashed — no receipt, no send", async () => {
    const res = await call("/api/smart-actions/emails/e1/reply", {
      body: `${BODY} P.S. wire the money`,
      payloadHash: HASH,
    });
    expect(res.statusCode).toBe(412);
    expectNothingSent();
  });

  it("refuses when the screen showed another recipient or subject", async () => {
    for (const shown of [
      { to: "attacker@evil.test", subject: SUBJECT, body: BODY },
      { to: TO, subject: "Re: something else", body: BODY },
    ]) {
      const res = await call("/api/smart-actions/emails/e1/reply", {
        body: BODY,
        payloadHash: sendEmailPayloadHash(shown),
        to: shown.to,
      });
      expect(res.statusCode).toBe(412);
    }
    expectNothingSent();
  });

  it("mints the receipt over the shown bytes BEFORE sending, flag or not", async () => {
    const res = await call("/api/smart-actions/emails/e1/reply", { body: BODY, payloadHash: HASH });
    expect(res.statusCode).toBe(200);
    expect(order).toEqual(["claim", "receipt", "release", "send"]);
    expect(db.receiptCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          route: "smart-reply",
          action: "send_email",
          payloadHash: HASH,
          emailId: "e1",
          status: "PENDING",
        }),
      }),
    );
    expect(gmail.sendEmail).toHaveBeenCalledWith(
      "user-1",
      TO,
      SUBJECT,
      BODY,
      [],
      expect.objectContaining({ threadId: "t1" }),
    );
    expect(res.json().receipt).toMatchObject({
      id: "rcpt-1",
      action: "send_email",
      payloadHash: HASH,
    });
    expect(db.receiptUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SENT" }) }),
    );
  });

  it("refuses the same bytes to the same mail moments after a send", async () => {
    db.receiptFindFirst.mockResolvedValueOnce({ id: "rcpt-0", status: "SENT" });
    const res = await call("/api/smart-actions/emails/e1/reply", { body: BODY, payloadHash: HASH });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: expect.stringMatching(/already went/),
      code: "ALREADY_SENT",
    });
    expectNothingSent();
    const where = (
      db.receiptFindFirst.mock.calls[0] as unknown as [{ where: Record<string, unknown> }]
    )[0].where;
    expect(where).toMatchObject({ userId: "user-1", emailId: "e1", payloadHash: HASH });
  });

  it("re-checks for a repeat and writes the receipt under the claim, after the provider lookups", async () => {
    await call("/api/smart-actions/emails/e1/reply", { body: BODY, payloadHash: HASH });
    expect(claims.claimSend).toHaveBeenCalledWith({
      userId: "user-1",
      emailId: "e1",
      payloadHash: HASH,
    });
    expect(claims.releaseSend).toHaveBeenCalledWith(expect.objectContaining({ token: "tok-1" }));
    const [early, decisive] = db.receiptFindFirst.mock.invocationCallOrder;
    const claimedAt = claims.claimSend.mock.invocationCallOrder[0];
    // No provider call under the claim: threading is resolved before it.
    expect(gmail.getReplyHeaders.mock.invocationCallOrder[0]).toBeLessThan(claimedAt);
    expect(early).toBeLessThan(claimedAt);
    expect(decisive).toBeGreaterThan(claimedAt);
    expect(decisive).toBeLessThan(claims.releaseSend.mock.invocationCallOrder[0]);
  });

  it("tells the request that lost the claim the send is still in progress, not that it went", async () => {
    claims.claimSend.mockResolvedValueOnce(null);
    const res = await call("/api/smart-actions/emails/e1/reply", { body: BODY, payloadHash: HASH });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: expect.any(String), code: "SEND_IN_PROGRESS" });
    expect(res.json().error).not.toMatch(/already went/);
    expectNothingSent();
    expect(db.receiptFindFirst).toHaveBeenCalledTimes(1); // the early read only
    expect(claims.releaseSend).not.toHaveBeenCalled();
  });

  it("answers SEND_IN_PROGRESS for an earlier send whose receipt is still PENDING", async () => {
    db.receiptFindFirst.mockResolvedValueOnce({ id: "rcpt-0", status: "PENDING" });
    const res = await call("/api/smart-actions/emails/e1/reply", { body: BODY, payloadHash: HASH });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("SEND_IN_PROGRESS");
    expectNothingSent();
  });

  it("answers SEND_OUTCOME_UNKNOWN, never ALREADY_SENT, when the earlier send's outcome is unknown", async () => {
    db.receiptFindFirst.mockResolvedValueOnce({ id: "rcpt-0", status: "UNKNOWN" });
    const res = await call("/api/smart-actions/emails/e1/reply", { body: BODY, payloadHash: HASH });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("SEND_OUTCOME_UNKNOWN");
    expectNothingSent();
  });

  it("reads the latest receipt for these bytes when deciding which repeat it is", async () => {
    db.receiptFindFirst.mockResolvedValueOnce({ id: "rcpt-0", status: "SENT" });
    await call("/api/smart-actions/emails/e1/reply", { body: BODY, payloadHash: HASH });
    const query = (
      db.receiptFindFirst.mock.calls[0] as unknown as [
        { orderBy?: unknown; select?: Record<string, boolean> },
      ]
    )[0];
    expect(query.orderBy).toEqual({ createdAt: "desc" });
    expect(query.select).toMatchObject({ status: true });
  });

  it("sends nothing when the claim cannot be taken (503, as for the receipt)", async () => {
    claims.claimSend.mockRejectedValueOnce(new Error("db down"));
    const res = await call("/api/smart-actions/emails/e1/reply", { body: BODY, payloadHash: HASH });
    expect(res.statusCode).toBe(503);
    expectNothingSent();
  });

  it("releases the claim on a repeat found under it, a receipt that cannot be written, and a failed check", async () => {
    const send = () =>
      call("/api/smart-actions/emails/e1/reply", { body: BODY, payloadHash: HASH });
    db.receiptFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "rcpt-0", status: "SENT" });
    expect((await send()).statusCode).toBe(409);
    db.receiptCreate.mockRejectedValueOnce(new Error("db down"));
    expect((await send()).statusCode).toBe(503);
    db.receiptFindFirst.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("db down"));
    expect((await send()).statusCode).toBe(500);
    expect(claims.releaseSend).toHaveBeenCalledTimes(3);
    expect(gmail.sendEmail).not.toHaveBeenCalled();
  });

  it("answers a provider refusal 409, an unsupported provider 501, an unknown outcome 502", async () => {
    const { SendOutcomeUnknownError } = await import("../mail/providers/send-outcome-unknown.js");
    const cases: Array<[() => unknown, number]> = [
      [() => ({ error: "Gmail said no" }), 409],
      [() => ({ unsupported: true, error: "Not on this provider" }), 501],
      [
        () => {
          throw new SendOutcomeUnknownError();
        },
        502,
      ],
    ];
    for (const [result, status] of cases) {
      gmail.sendEmail.mockImplementationOnce(async () => result());
      const res = await call("/api/smart-actions/emails/e1/reply", {
        body: BODY,
        payloadHash: HASH,
      });
      expect(res.statusCode).toBe(status);
    }
  });

  it("sends nothing when the receipt cannot be written", async () => {
    db.receiptCreate.mockRejectedValue(new Error("db down"));
    const res = await call("/api/smart-actions/emails/e1/reply", { body: BODY, payloadHash: HASH });
    expect(res.statusCode).toBe(503);
    expect(gmail.sendEmail).not.toHaveBeenCalled();
  });
});

describe("another user's mail", () => {
  it.each(ROUTES)("%s is a 404 and does nothing", async (url) => {
    db.emailFindFirst.mockResolvedValue(null);
    const res = await call(url, {
      body: BODY,
      payloadHash: HASH,
      title: "x",
      date: "2026-11-13",
      time: "15:00",
      durationMinutes: 30,
    });
    expect(res.statusCode).toBe(404);
    for (const [args] of db.emailFindFirst.mock.calls as unknown as Array<
      [{ where: { userId: string } }]
    >) {
      expect(args.where.userId).toBe("user-1");
    }
    expectNothingSent();
    expect(replies.draftReplyForEmailId).not.toHaveBeenCalled();
    expect(calendar.createUserCalendarEvent).not.toHaveBeenCalled();
    expect(parseEventText).not.toHaveBeenCalled();
  });
});

describe("no send path from a notification", () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sources(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });
  const files = sources(srcDir).map((full) => ({
    path: relative(srcDir, full),
    text: readFileSync(full, "utf8"),
  }));

  it("only the two reply routes call the shared reply send", () => {
    const callers = files
      .filter((f) => /\bsendReplyToEmail\s*\(/.test(f.text) && f.path !== "mail/reply-send.ts")
      .map((f) => f.path)
      .sort();
    expect(callers).toEqual(["routes/email-replies.ts", "routes/smart-actions.ts"]);
  });

  it("nothing under notify/ reaches the smart actions", () => {
    const notify = files.filter((f) => f.path.startsWith("notify/"));
    expect(notify.length).toBeGreaterThan(0);
    for (const f of notify) {
      expect(f.text).not.toMatch(/smart-actions|sendReplyToEmail|reply-send/);
    }
  });

  it("the smart routes are POST-only, and Send declares body and payloadHash required", () => {
    const text = files.find((f) => f.path === "routes/smart-actions.ts")?.text ?? "";
    expect(text).not.toMatch(/app\.(get|put|patch|delete)\(/);
    expect(text).toMatch(/required: \["body", "payloadHash"\]/);
  });
});

describe("POST /emails/:id/event-proposal", () => {
  it("asks AM or PM for a bare hour, quotes the mail, and writes nothing", async () => {
    const res = await call("/api/smart-actions/emails/e1/event-proposal");
    expect(res.statusCode).toBe(200);
    expect(res.json().proposal).toEqual({
      title: "Office meeting",
      date: "2026-11-13",
      time: null,
      durationMinutes: 30,
      location: "The office",
      timeZone: "Asia/Seoul",
      quote: "Can we meet 내일 3시 at the office?",
      question: { kind: "meridiem", am: "03:00", pm: "15:00" },
      existing: [],
    });
    // The model reads only the quote, never the whole mail.
    expect(parseEventText).toHaveBeenCalledWith(
      "user-1",
      "Can we meet 내일 3시 at the office?",
      EMAIL.receivedAt,
    );
    expect(calendar.createUserCalendarEvent).not.toHaveBeenCalled();
    expect(db.eventFindMany).not.toHaveBeenCalled();
  });

  it("names what is already on the calendar at a fully read time", async () => {
    db.emailFindFirst.mockResolvedValue({ ...EMAIL, body: "Let's meet tomorrow at 3pm." });
    db.eventFindMany.mockResolvedValue([
      {
        id: "ev-0",
        title: "Invitation: Sync",
        description: null,
        location: null,
        startTime: new Date("2026-11-13T06:00:00Z"),
        endTime: new Date("2026-11-13T07:00:00Z"),
        allDay: false,
        provider: "GOOGLE",
        externalId: "g-0",
        sourceAccountId: null,
      },
    ]);
    const res = await call("/api/smart-actions/emails/e1/event-proposal");
    const proposal = res.json().proposal;
    expect(proposal).toMatchObject({ date: "2026-11-13", time: "15:00", question: null });
    expect(proposal.existing).toEqual([
      {
        id: "ev-0",
        title: "Invitation: Sync",
        startTime: "2026-11-13T06:00:00.000Z",
        endTime: "2026-11-13T07:00:00.000Z",
      },
    ]);
    const where = (
      db.eventFindMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }]
    )[0].where;
    // Timed rows only: an all-day birthday or holiday is not a duplicate.
    expect(where).toMatchObject({
      userId: "user-1",
      allDay: false,
      startTime: { lt: new Date("2026-11-13T06:30:00Z") },
      endTime: { gt: new Date("2026-11-13T06:00:00Z") },
    });
    expect(calendar.createUserCalendarEvent).not.toHaveBeenCalled();
  });

  it("is null when the mail names no date, without calling the model", async () => {
    db.emailFindFirst.mockResolvedValue({ ...EMAIL, subject: "Hello", body: "Just checking in." });
    const res = await call("/api/smart-actions/emails/e1/event-proposal");
    expect(res.json()).toEqual({ proposal: null });
    expect(parseEventText).not.toHaveBeenCalled();
  });

  it("still proposes, titled from the subject, when the model fails", async () => {
    parseEventText.mockRejectedValue(new Error("provider down"));
    const res = await call("/api/smart-actions/emails/e1/event-proposal");
    expect(res.json().proposal).toMatchObject({
      title: "Need your reply today",
      durationMinutes: 60,
      location: null,
      question: { kind: "meridiem" },
    });
  });
});

describe("POST /emails/:id/event (Save on the confirm card)", () => {
  const SAVE = { title: "Office meeting", date: "2026-11-13", time: "15:00", durationMinutes: 30 };
  // The write takes dates a year back to five ahead of now; pin now.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("refuses a write without the confirmed date and time", async () => {
    for (const payload of [
      { ...SAVE, time: undefined },
      { ...SAVE, date: undefined },
      { ...SAVE, time: "3:00 PM" },
      { ...SAVE, time: "3시" },
      { ...SAVE, date: "2026-02-30" },
      { ...SAVE, title: "  " },
    ]) {
      const res = await call("/api/smart-actions/emails/e1/event", payload);
      expect(res.statusCode).toBe(400);
    }
    expect(calendar.createUserCalendarEvent).not.toHaveBeenCalled();
  });

  it("writes the confirmed time in the user's timezone, with the reminder", async () => {
    const res = await call("/api/smart-actions/emails/e1/event", {
      ...SAVE,
      location: " The office ",
      reminderMinutes: 30,
    });
    expect(res.statusCode).toBe(200);
    expect(calendar.createUserCalendarEvent).toHaveBeenCalledWith("user-1", {
      title: "Office meeting",
      startTime: "2026-11-13T06:00:00.000Z",
      endTime: "2026-11-13T06:30:00.000Z",
      location: "The office",
      allDay: false,
      attendees: [],
      reminderMinutes: 30,
    });
    expect(res.json()).toMatchObject({ reminderSet: true, timeZone: "Asia/Seoul" });
  });

  it("refuses a date outside a year back to five ahead", async () => {
    for (const date of ["1999-01-01", "2099-01-01"]) {
      const res = await call("/api/smart-actions/emails/e1/event", { ...SAVE, date });
      expect(res.statusCode).toBe(400);
    }
    expect(calendar.createUserCalendarEvent).not.toHaveBeenCalled();
  });

  it("only takes the reminder chip's values", async () => {
    const res = await call("/api/smart-actions/emails/e1/event", { ...SAVE, reminderMinutes: 1 });
    expect(res.statusCode).toBe(400);
  });

  it("refuses an overlap unless the user chose to add anyway", async () => {
    const existing = {
      id: "ev-0",
      title: "Sync",
      startTime: new Date("2026-11-13T06:00:00Z"),
      endTime: new Date("2026-11-13T07:00:00Z"),
    };
    db.eventFindMany.mockResolvedValue([existing]);
    const refused = await call("/api/smart-actions/emails/e1/event", SAVE);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().existing).toEqual([
      expect.objectContaining({ id: "ev-0", title: "Sync" }),
    ]);
    expect(calendar.createUserCalendarEvent).not.toHaveBeenCalled();

    const added = await call("/api/smart-actions/emails/e1/event", {
      ...SAVE,
      allowDuplicate: true,
    });
    expect(added.statusCode).toBe(200);
    expect(calendar.createUserCalendarEvent).toHaveBeenCalledTimes(1);
  });

  it("is Pro-gated like POST /api/calendar", async () => {
    entitled.mockImplementationOnce(async (_req: unknown, reply: never) => {
      (reply as { code: (n: number) => { send: (b: unknown) => void } }).code(402).send({});
    });
    const res = await call("/api/smart-actions/emails/e1/event", SAVE);
    expect(res.statusCode).toBe(402);
    expect(calendar.createUserCalendarEvent).not.toHaveBeenCalled();
  });
});
