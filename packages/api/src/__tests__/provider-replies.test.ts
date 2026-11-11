/**
 * Provider-side replies: a reply the user sent from Gmail itself (found by the
 * Sent-folder scan, origin null) stamps providerRepliedAt on the judged mail it
 * answered. Mail Klorn sent (any origin) never stamps, and every lookup and
 * write is scoped to the user. Prisma is mocked; the real-Postgres proof of
 * the same rules is in provider-engagement-pg.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  sentFindMany: vi.fn(),
  emailFindMany: vi.fn(),
  stamp: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("../db.js", () => ({
  prisma: {
    sentMessage: { findMany: m.sentFindMany },
    emailMessage: { findMany: m.emailFindMany },
  },
}));
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));
vi.mock("../judge/decision-label.js", () => ({ stampProviderEngagement: m.stamp }));

import { matchProviderReplies, noteProviderReplies } from "../mail/provider-replies.js";

const T0 = new Date("2026-11-10T09:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

const mail = (
  id: string,
  threadId: string | null,
  receivedAt: Date,
  linkedInboxAccountId: string | null = null,
) => ({ id, threadId, receivedAt, linkedInboxAccountId });

beforeEach(() => {
  vi.clearAllMocks();
  m.sentFindMany.mockResolvedValue([]);
  m.emailFindMany.mockResolvedValue([]);
  m.stamp.mockResolvedValue(1);
});

describe("matchProviderReplies", () => {
  it("matches the newest mail of the thread and inbox that arrived before the send, at the send time", () => {
    // Only the newest, like Klorn's own reply stamp (the mail the user
    // answered), so one reply never marks a whole long thread as replied.
    const stamps = matchProviderReplies(
      [{ threadId: "t1", inbox: "primary", sentAt: minutes(30) }],
      [mail("e2", "t1", minutes(10)), mail("e1", "t1", minutes(0))],
    );
    expect(stamps).toEqual([{ at: minutes(30), emailId: "e2" }]);
  });

  it("ignores mail that arrived after the send, in another thread, or in another account", () => {
    const stamps = matchProviderReplies(
      [{ threadId: "t1", inbox: "primary", sentAt: minutes(30) }],
      [
        mail("later", "t1", minutes(31)),
        mail("same-time", "t1", minutes(30)),
        mail("other-thread", "t2", minutes(0)),
        mail("linked-account", "t1", minutes(0), "linked-1"),
        mail("no-thread", null, minutes(0)),
      ],
    );
    expect(stamps).toEqual([]);
  });

  it("matches a linked account's send only to that account's mail", () => {
    const stamps = matchProviderReplies(
      [{ threadId: "t1", inbox: "linked-1", sentAt: minutes(30) }],
      [mail("primary-mail", "t1", minutes(0)), mail("linked-mail", "t1", minutes(0), "linked-1")],
    );
    expect(stamps).toEqual([{ at: minutes(30), emailId: "linked-mail" }]);
  });

  it("orders the stamps by send time, so a mail's earliest reply is the one that lands", () => {
    const stamps = matchProviderReplies(
      [
        { threadId: "t1", inbox: "primary", sentAt: minutes(90) },
        { threadId: "t1", inbox: "primary", sentAt: minutes(20) },
      ],
      [mail("e1", "t1", minutes(0)), mail("e2", "t1", minutes(60))],
    );
    expect(stamps).toEqual([
      { at: minutes(20), emailId: "e1" },
      { at: minutes(90), emailId: "e2" },
    ]);
  });
});

describe("noteProviderReplies", () => {
  it("reads only the user's sends with no Klorn origin, then stamps the mail they answered", async () => {
    m.sentFindMany.mockResolvedValue([{ threadId: "t1", inbox: "primary", sentAt: minutes(30) }]);
    m.emailFindMany.mockResolvedValue([mail("e1", "t1", minutes(0))]);

    await noteProviderReplies("user-1", ["g-sent-1", "g-sent-2"]);

    // origin: null is the "the user's own mail" guard: auto_reply, unsubscribe,
    // approved and user (a send through Klorn) rows never reach a stamp.
    expect(m.sentFindMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        gmailId: { in: ["g-sent-1", "g-sent-2"] },
        origin: null,
        threadId: { not: null },
      },
      select: { threadId: true, inbox: true, sentAt: true },
    });
    // The mirror lookup is the user's own mail, minus their own copies (a
    // message to self carries SENT in the INBOX mirror).
    expect(m.emailFindMany).toHaveBeenCalledWith({
      where: { userId: "user-1", threadId: { in: ["t1"] }, NOT: { labels: { has: "SENT" } } },
      select: { id: true, threadId: true, receivedAt: true, linkedInboxAccountId: true },
    });
    expect(m.stamp).toHaveBeenCalledWith("user-1", "REPLIED", ["e1"], minutes(30));
  });

  it("does nothing for an empty list", async () => {
    await noteProviderReplies("user-1", []);
    expect(m.sentFindMany).not.toHaveBeenCalled();
    expect(m.stamp).not.toHaveBeenCalled();
  });

  it("stamps nothing for a send that starts a thread (no earlier mail in it)", async () => {
    m.sentFindMany.mockResolvedValue([{ threadId: "t1", inbox: "primary", sentAt: minutes(30) }]);
    m.emailFindMany.mockResolvedValue([mail("answer", "t1", minutes(45))]);

    await noteProviderReplies("user-1", ["g-new-thread"]);

    expect(m.stamp).not.toHaveBeenCalled();
  });

  it("stamps in send-time order", async () => {
    m.sentFindMany.mockResolvedValue([
      { threadId: "t1", inbox: "primary", sentAt: minutes(90) },
      { threadId: "t2", inbox: "primary", sentAt: minutes(20) },
    ]);
    m.emailFindMany.mockResolvedValue([mail("e1", "t1", minutes(0)), mail("e2", "t2", minutes(0))]);

    await noteProviderReplies("user-1", ["a", "b"]);

    expect(m.stamp.mock.calls.map((c) => c[3])).toEqual([minutes(20), minutes(90)]);
  });

  it("never throws: a failed read is logged and stamps nothing", async () => {
    m.sentFindMany.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(noteProviderReplies("user-1", ["g1"])).resolves.toBeUndefined();

    expect(m.stamp).not.toHaveBeenCalled();
    expect(m.captureError).toHaveBeenCalled();
    warn.mockRestore();
  });
});
