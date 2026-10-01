/**
 * The firewall PUSH dedupe after an IMAP UIDVALIDITY repair (step B2b of
 * docs/providers/unified-platform-plan.md).
 *
 * The PUSH marker is the text `[gmailId]` on the bell row, shared with the urgent
 * sweep. A repair re-keys the old row (`...:101#uv1000`), and a NEW message that
 * reuses UID 101 arrives under the old id `...:101`. The old row's marker must not
 * silence it: for IMAP ids a marker counts only from the row's creation on. Gmail
 * ids keep the exact query they had.
 *
 * The real judgeAndMirrorEmail runs over the in-memory database; only the judge and
 * the outward-facing notifiers are mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const judgeEmail = vi.hoisted(() => vi.fn());
const sendPushNotification = vi.hoisted(() => vi.fn(async () => ({})));

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
vi.mock("../notify/notification-strings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notify/notification-strings.js")>()),
  getUserNotificationLanguage: vi.fn(async () => "en"),
}));
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
const NOW = new Date("2026-09-30T10:00:00.000Z");
const HOUR = 60 * 60_000;
const DEDUP_WINDOW_MS = 7 * 24 * HOUR;
/** The IMAP mailboxes the PUSH dedupe rules must hold for: Naver, and generic IMAP (step B4). */
const IMAP_CASES = [
  { label: "Naver", id: "naver-imap:me@naver.com:101", provider: "NAVER", email: "me@naver.com" },
  {
    label: "generic IMAP",
    id: "generic-imap:me@example.com:101",
    provider: "IMAP",
    email: "me@example.com",
  },
] as const;
/** The id under test; set per mailbox by the describe.each blocks below. */
let IMAP_ID: string = IMAP_CASES[0].id;
const GMAIL_ID = "18c2f0a1b2c3d4e5";

let db: FakeDb;

function seed(gmailId: string, rowCreatedAt: Date, markerAt: Date, accounts: Row[] = []) {
  db = createFakeDb({
    linkedInboxAccount: accounts,
    emailMessage: [
      {
        id: "email-new",
        userId: USER,
        gmailId,
        from: "Alice <alice@example.com>",
        to: "me@naver.com",
        subject: "Contract",
        createdAt: rowCreatedAt,
      },
    ],
    attentionItem: [],
    decisionLabel: [],
    notification: [
      {
        id: "old-push",
        userId: USER,
        type: "email",
        title: "Urgent email",
        message: `Alice: An older message [${gmailId}]`,
        createdAt: markerAt,
      },
    ],
    user: [],
  });
  dbHolder.current = db;
}

const judge = (
  gmailId: string,
  over: { receivedAt?: Date; linkedInboxAccountId?: string | null } = {},
) =>
  judgeAndMirrorEmail(USER, {
    id: "email-new",
    gmailId,
    from: "Alice <alice@example.com>",
    subject: "Contract",
    snippet: "Please sign",
    labels: ["INBOX"],
    receivedAt: new Date(NOW.getTime() - 60_000),
    linkedInboxAccountId: null,
    ...over,
  });
const notifications = (): Row[] => db.tables.notification ?? [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  judgeEmail.mockReset();
  judgeEmail.mockResolvedValue({
    tier: "PUSH",
    reason: "Urgent",
    features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.5, urgency: 0.9 },
    source: "llm",
    autoEligible: false,
  });
  sendPushNotification.mockClear();
});

describe.each(IMAP_CASES)("$label ids: a marker counts only from the row's creation on", (imap) => {
  beforeEach(() => {
    IMAP_ID = imap.id;
  });

  it("pushes a new message whose id an older, re-keyed row was already notified under", async () => {
    seed(IMAP_ID, new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - 2 * HOUR));

    await judge(IMAP_ID);

    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect(notifications()).toHaveLength(2);
  });

  it("still dedupes the same row: a marker written after the row was created counts", async () => {
    seed(IMAP_ID, new Date(NOW.getTime() - 2 * HOUR), new Date(NOW.getTime() - HOUR));

    await judge(IMAP_ID);

    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(notifications()).toHaveLength(1);
  });

  it("counts a marker written at the very instant the row was created", async () => {
    const at = new Date(NOW.getTime() - HOUR);
    seed(IMAP_ID, at, at);

    await judge(IMAP_ID);

    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("keeps the 7-day window for a row older than it", async () => {
    seed(
      IMAP_ID,
      new Date(NOW.getTime() - 30 * 24 * HOUR),
      new Date(NOW.getTime() - 8 * 24 * HOUR),
    );

    await judge(IMAP_ID);

    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });
});

describe("Gmail ids: exactly the query they had", () => {
  it("dedupes against a marker older than the row, issuing the same where and no row lookup", async () => {
    seed(GMAIL_ID, new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - 2 * HOUR));
    const findFirst = vi.spyOn(db.model("notification"), "findFirst");
    db.reads.length = 0;

    await judge(GMAIL_ID);

    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        userId: USER,
        type: "email",
        title: "Urgent email",
        OR: [
          { message: { contains: `[${GMAIL_ID}]` } },
          { message: { contains: `[${GMAIL_ID},` } },
          { message: { contains: `,${GMAIL_ID},` } },
          { message: { contains: `,${GMAIL_ID}]` } },
        ],
        createdAt: { gte: new Date(NOW.getTime() - DEDUP_WINDOW_MS) },
      },
      select: { id: true },
    });
    expect(db.reads).not.toContain("emailMessage");
  });
});

/**
 * A repair re-ingests the INBOX window as new rows. Those are history: judged like any
 * row, but no PUSH. Mail received during the hold (at or after the first sighting,
 * `inboxUidValidityResetAt`) keeps its push.
 */
describe.each(
  IMAP_CASES,
)("$label: re-ingested history after a repair (B2b): judged, never pushed", (imap) => {
  beforeEach(() => {
    IMAP_ID = imap.id;
  });
  const RESET_AT = new Date(NOW.getTime() - 30 * 60_000);
  const account = {
    id: "acc-1",
    userId: USER,
    provider: imap.provider,
    email: imap.email,
    inboxUidValidityResetAt: RESET_AT,
  };
  const OLD_MARKER = new Date(NOW.getTime() - 8 * 24 * HOUR); // outside the 7-day window
  const fresh = () => new Date(NOW.getTime() - 60_000);

  it("does not push an IMAP row received before the reset, but judges it", async () => {
    seed(IMAP_ID, fresh(), OLD_MARKER, [account]);

    await judge(IMAP_ID, {
      receivedAt: new Date(RESET_AT.getTime() - 1),
      linkedInboxAccountId: "acc-1",
    });

    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(notifications()).toHaveLength(1);
    expect(db.tables.attentionItem).toEqual([
      expect.objectContaining({ sourceId: "email-new", tier: "PUSH" }),
    ]);
  });

  it("pushes IMAP mail received during the hold", async () => {
    seed(IMAP_ID, fresh(), OLD_MARKER, [account]);

    await judge(IMAP_ID, { receivedAt: RESET_AT, linkedInboxAccountId: "acc-1" });

    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });

  it("never looks at the accounts for a Gmail row", async () => {
    seed(GMAIL_ID, fresh(), OLD_MARKER, [account]);
    db.reads.length = 0;

    await judge(GMAIL_ID, {
      receivedAt: new Date(RESET_AT.getTime() - 1),
      linkedInboxAccountId: "acc-1",
    });

    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect(db.reads).not.toContain("linkedInboxAccount");
  });
});
