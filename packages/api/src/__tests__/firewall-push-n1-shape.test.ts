/**
 * Decision N1 (LOCKED 2026-11-08) on the firewall path: the device push for a
 * PUSH / MEETING mail is titled with the sender's name only, its body is the
 * subject then the judge's one-line reason (as stored on the attention item,
 * resolved for display), it opens that mail, and it names its lane and the
 * user's notification language so the channels can pick the action set. The
 * bell row and the live frame (and so the 7-day dedupe) are unchanged.
 *
 * Same harness as firewall-push-localized.test.ts: the real judgeAndMirrorEmail
 * over the in-memory database; only the judge and the notifiers are mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const judgeEmail = vi.hoisted(() => vi.fn());
const sendPushNotification = vi.hoisted(() => vi.fn(async () => ({})));
const pushNotification = vi.hoisted(() => vi.fn());

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../judge/poc-judge.js", () => ({ judgeEmail }));
vi.mock("../judge/judge-context.js", () => ({
  buildJudgeContext: vi.fn(async () => ({ corrections: [], senderPrior: null, senderFacts: null })),
}));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../notify/push.js", () => ({ sendPushNotification }));
vi.mock("../websocket.js", () => ({ pushNotification }));
vi.mock("../notify/conversations-updated.js", () => ({ notifyConversationsUpdated: vi.fn() }));
vi.mock("../mail/gmail-labels.js", () => ({
  applyLaneLabel: vi.fn(async () => "applied"),
  isLabelModeEnabled: () => false,
  laneForLabelIds: vi.fn(async () => null),
}));

import { judgeAndMirrorEmail } from "../judge/email-firewall.js";

const USER = "user-1";
const NOW = new Date("2026-11-07T10:00:00.000Z");
const HOUR = 60 * 60_000;
const GMAIL_ID = "18c2f0a1b2c3d4e5";

let db: FakeDb;

/** `language` undefined: the user has no AutomationConfig row at all. */
function seed(language: string | undefined) {
  db = createFakeDb({
    automationConfig:
      language === undefined ? [] : [{ id: "cfg-1", userId: USER, notificationLanguage: language }],
    emailMessage: [
      {
        id: "email-1",
        userId: USER,
        gmailId: GMAIL_ID,
        from: "Alice <alice@example.com>",
        to: "me@example.com",
        subject: "Contract",
        createdAt: new Date(NOW.getTime() - HOUR),
      },
    ],
    attentionItem: [],
    decisionLabel: [],
    linkedInboxAccount: [],
    notification: [],
    user: [],
  });
  dbHolder.current = db;
}

const judge = (subject = "Contract") =>
  judgeAndMirrorEmail(USER, {
    id: "email-1",
    gmailId: GMAIL_ID,
    from: "Alice <alice@example.com>",
    subject,
    snippet: "Please sign",
    labels: ["INBOX"],
    receivedAt: new Date(NOW.getTime() - 60_000),
    linkedInboxAccountId: null,
  });

const written = (): Row[] => db.tables.notification ?? [];
const pushPayload = () =>
  (sendPushNotification.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
const wsPayload = () =>
  (pushNotification.mock.calls[0] as unknown as [string, { title: string; message: string }])[1];

function judged(tier: string, reason: string) {
  judgeEmail.mockReset();
  judgeEmail.mockResolvedValue({
    tier,
    reason,
    features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.5, urgency: 0.9 },
    source: "llm",
    autoEligible: false,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  sendPushNotification.mockClear();
  pushNotification.mockClear();
  judged("PUSH", "Signature needed today");
});

describe("firewall device push — decision N1 shape", () => {
  it("PUSH: sender-only title, subject + reason body, opens the mail, lane PUSH", async () => {
    seed("en");

    await judge("Contract");

    const payload = pushPayload();
    expect(payload.title).toBe("Alice");
    expect(payload.body).toBe("Contract\nSignature needed today");
    expect(payload.url).toBe("/email/email-1");
    expect(payload.emailId).toBe("email-1");
    expect(payload.lane).toBe("PUSH");
    expect(payload.language).toBe("en");
    expect(typeof payload.attentionItemId).toBe("string");
  });

  it("MEETING: the same shape, lane MEETING", async () => {
    seed("ko");
    judged("MEETING", "Meeting request for Thursday");

    await judge("Sync?");

    const payload = pushPayload();
    expect(payload.title).toBe("Alice");
    expect(payload.body).toBe("Sync?\nMeeting request for Thursday");
    expect(payload.lane).toBe("MEETING");
    expect(payload.language).toBe("ko");
  });

  it("omits the reason line when the judge gave none", async () => {
    seed("en");
    judged("PUSH", "");

    await judge("Contract");

    expect(pushPayload().body).toBe("Contract");
  });

  it("leaves the bell row and live frame as they were (the dedupe key is untouched)", async () => {
    seed("en");

    await judge("Contract");

    const [row] = written();
    expect(row.title).toBe("Urgent email");
    expect(row.message).toBe(`Alice: Contract [${GMAIL_ID}]`);
    expect(wsPayload().title).toBe("Urgent email");
    expect(wsPayload().message).toBe("Alice: Contract");
  });

  it("names the mail on the bell row and carries the N1 toast on the live frame (Windows shell)", async () => {
    seed("en");

    await judge("Contract");

    // The desktop catch-up reads the mail id back (decision N6).
    expect(written()[0].sourceEmailId).toBe("email-1");
    // The Windows toast: same title/body as the device push, opens the mail.
    expect((wsPayload() as unknown as { mail: unknown }).mail).toEqual({
      emailId: "email-1",
      title: "Alice",
      body: "Contract\nSignature needed today",
    });
  });
});
