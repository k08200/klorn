/**
 * IP24 instrumentation on the firewall path, end to end: the real
 * judgeAndMirrorEmail over the in-memory database (fake-db), with only the
 * judge and the notifiers mocked.
 *
 *  - DecisionLabel.rangAt: stamped when the PUSH / MEETING interrupt got past
 *    every hold gate (sendPushNotification's dispatchedAt), never when it was
 *    held (quiet hours, rate limit, …) and never for a lane that does not ring.
 *  - DecisionLabel.gmailImportant: Gmail's IMPORTANT marker on the inbox mail
 *    when it was first judged, null for mail that is not Gmail's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const judgeEmail = vi.hoisted(() => vi.fn());
const sendPushNotification = vi.hoisted(() =>
  vi.fn(async (): Promise<Record<string, unknown>> => ({})),
);

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
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../notify/conversations-updated.js", () => ({ notifyConversationsUpdated: vi.fn() }));
vi.mock("../mail/gmail-labels.js", () => ({
  applyLaneLabel: vi.fn(async () => "applied"),
  isLabelModeEnabled: () => false,
  laneForLabelIds: vi.fn(async () => null),
}));

import { judgeAndMirrorEmail } from "../judge/email-firewall.js";

const USER = "user-1";
const NOW = new Date("2026-11-12T10:00:00.000Z");
const GMAIL_ID = "18c2f0a1b2c3d4e5";
const IMAP_ID = "icloud-imap:me@icloud.com:42";

let db: FakeDb;

function seed(gmailId: string) {
  db = createFakeDb({
    automationConfig: [{ id: "cfg-1", userId: USER, notificationLanguage: "en" }],
    emailMessage: [
      {
        id: "email-1",
        userId: USER,
        gmailId,
        from: "Alice <alice@example.com>",
        to: "me@example.com",
        subject: "Contract",
        createdAt: new Date(NOW.getTime() - 60_000),
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

const judge = (gmailId: string, labels: string[], ageMs = 60_000) =>
  judgeAndMirrorEmail(USER, {
    id: "email-1",
    gmailId,
    from: "Alice <alice@example.com>",
    subject: "Contract",
    snippet: "Please sign",
    labels,
    receivedAt: new Date(NOW.getTime() - ageMs),
    linkedInboxAccountId: null,
  });

function judged(tier: string) {
  judgeEmail.mockReset();
  judgeEmail.mockResolvedValue({
    tier,
    reason: "Signature needed today",
    features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.5, urgency: 0.9 },
    source: "llm",
    autoEligible: false,
  });
}

const ledger = (): Row => {
  const rows = db.tables.decisionLabel ?? [];
  expect(rows).toHaveLength(1);
  return rows[0];
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  sendPushNotification.mockReset();
  sendPushNotification.mockResolvedValue({});
});

describe("rangAt — the interrupt actually fired", () => {
  it.each([
    "PUSH",
    "MEETING",
  ])("%s: stamped with the dispatch time once the gates let it through", async (tier) => {
    seed(GMAIL_ID);
    judged(tier);
    const dispatchedAt = new Date(NOW.getTime() + 1_000);
    sendPushNotification.mockResolvedValue({ status: "sent", dispatchedAt });

    await judge(GMAIL_ID, ["INBOX"]);

    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect(ledger().rangAt).toEqual(dispatchedAt);
  });

  it("PUSH held at a gate (quiet hours): not stamped", async () => {
    seed(GMAIL_ID);
    judged("PUSH");
    sendPushNotification.mockResolvedValue({
      status: "skipped",
      reason: "quiet_hours",
      dispatchedAt: null,
    });

    await judge(GMAIL_ID, ["INBOX"]);

    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect(ledger().rangAt ?? null).toBeNull();
  });

  it("QUEUE does not ring: not stamped", async () => {
    seed(GMAIL_ID);
    judged("QUEUE");

    await judge(GMAIL_ID, ["INBOX"]);

    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(ledger().rangAt ?? null).toBeNull();
  });
});

describe("gmailImportant — Gmail's marker when Klorn judged the mail", () => {
  it("true for Gmail inbox mail marked IMPORTANT", async () => {
    seed(GMAIL_ID);
    judged("QUEUE");

    await judge(GMAIL_ID, ["INBOX", "IMPORTANT"]);

    expect(ledger().gmailImportant).toBe(true);
  });

  it("false for Gmail inbox mail without it", async () => {
    seed(GMAIL_ID);
    judged("QUEUE");

    await judge(GMAIL_ID, ["INBOX"]);

    expect(ledger().gmailImportant).toBe(false);
  });

  it("null for mail the backfill sweep judges late: its labels are no longer the arrival ones", async () => {
    seed(GMAIL_ID);
    judged("QUEUE");

    await judge(GMAIL_ID, ["INBOX", "IMPORTANT"], 7 * 3_600_000);

    expect(ledger().gmailImportant ?? null).toBeNull();
  });

  it("null for IMAP mail, whose IMPORTANT is the user's own flag", async () => {
    seed(IMAP_ID);
    judged("QUEUE");

    await judge(IMAP_ID, ["INBOX", "IMPORTANT"]);

    expect(ledger().gmailImportant ?? null).toBeNull();
  });
});
