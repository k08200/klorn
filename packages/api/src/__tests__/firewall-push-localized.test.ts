/**
 * The firewall PUSH notification speaks the user's notification language
 * (AutomationConfig.notificationLanguage), like the briefings and draft banners:
 * the bell row title, the "(no subject)" stand-in and the device push body.
 *
 * The bell row title is also part of the 7-day dedupe key, shared with the
 * urgent sweep. Localizing it must not let a mail ring twice: a row written in
 * one language still silences the mail after the user switches language, and
 * the English rows written before this change still count after deploy.
 *
 * The real judgeAndMirrorEmail runs over the in-memory database, with the
 * user's language read from a seeded AutomationConfig row (no mock of the
 * resolver); only the judge and the outward-facing notifiers are mocked.
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
import { NOTIFICATION_LANGUAGES, notificationCopy } from "../notify/notification-strings.js";

const USER = "user-1";
const NOW = new Date("2026-11-07T10:00:00.000Z");
const HOUR = 60 * 60_000;
const GMAIL_ID = "18c2f0a1b2c3d4e5";

let db: FakeDb;

/** `language` undefined: the user has no AutomationConfig row at all. */
function seed(language: string | undefined, priorNotifications: Row[] = []) {
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
    notification: priorNotifications,
    user: [],
  });
  dbHolder.current = db;
}

/** An earlier bell row naming this mail in its `[id]` marker. */
const priorRow = (title: string, type = "email"): Row => ({
  id: `prior-${title}`,
  userId: USER,
  type,
  title,
  message: `Alice: Contract [${GMAIL_ID}]`,
  createdAt: new Date(NOW.getTime() - 2 * HOUR),
});

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

const notifications = (): Row[] => db.tables.notification ?? [];
const written = (): Row[] =>
  notifications().filter((n) => String(n.id).startsWith("prior-") === false);
const pushPayload = () =>
  (sendPushNotification.mock.calls[0] as unknown as [string, { title: string; body: string }])[1];
const wsPayload = () =>
  (pushNotification.mock.calls[0] as unknown as [string, { title: string; message: string }])[1];

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
  pushNotification.mockClear();
});

describe("the PUSH notification follows the user's notification language", () => {
  it("writes the Korean bell title, live frame title and no-subject stand-in for a ko user", async () => {
    seed("ko");

    await judge("");

    const [row] = written();
    expect(row.title).toBe("긴급 메일");
    expect(row.message).toBe(`Alice: (제목 없음) [${GMAIL_ID}]`);
    expect(wsPayload().title).toBe("긴급 메일");
    expect(wsPayload().message).toBe("Alice: (제목 없음)");
    expect(pushPayload().body).toBe("(제목 없음)");
    expect(pushPayload().title).toBe("Klorn — Alice");
  });

  it.each(NOTIFICATION_LANGUAGES)("%s: every surface uses that language's copy", async (lang) => {
    seed(lang);

    await judge("");

    const copy = notificationCopy(lang);
    const [row] = written();
    expect(row.title).toBe(copy.urgentMailTitle);
    expect(row.message).toBe(`Alice: ${copy.noSubject} [${GMAIL_ID}]`);
    expect(wsPayload().title).toBe(copy.urgentMailTitle);
    expect(pushPayload().body).toBe(copy.noSubject);
  });

  it("keeps the subject as written: only Klorn's own words are translated", async () => {
    seed("ja");

    await judge("Q4 contract — please sign");

    expect(written()[0].message).toBe(`Alice: Q4 contract — please sign [${GMAIL_ID}]`);
    expect(pushPayload().body).toBe("Q4 contract — please sign");
  });

  it.each([
    ["a user with no automation config", undefined],
    ["an unshipped language", "pt-BR"],
  ])("falls back to English for %s", async (_label, language) => {
    seed(language);

    await judge("");

    expect(written()[0].title).toBe("Urgent email");
    expect(pushPayload().body).toBe("(no subject)");
  });

  it("folds a regional tag onto the shipped base language", async () => {
    seed("zh-Hans");

    await judge();

    expect(written()[0].title).toBe(notificationCopy("zh").urgentMailTitle);
  });
});

describe("the 7-day dedupe does not depend on the title's language", () => {
  it("a row written in Korean still silences the mail after the user switches to English", async () => {
    seed("en", [priorRow("긴급 메일")]);

    await judge();

    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(notifications()).toHaveLength(1);
  });

  it("an English row written before this change still silences the mail for a ko user", async () => {
    seed("ko", [priorRow("Urgent email")]);

    await judge();

    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(notifications()).toHaveLength(1);
  });

  it("the older Korean urgent title the sweep wrote still counts", async () => {
    seed("de", [priorRow("긴급 이메일")]);

    await judge();

    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it.each(
    NOTIFICATION_LANGUAGES,
  )("a row titled in %s silences the mail whatever the user's language now is", async (lang) => {
    seed(lang === "en" ? "fr" : "en", [priorRow(notificationCopy(lang).urgentMailTitle)]);

    await judge();

    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("an unrelated email notification naming the same id does not silence the mail", async () => {
    seed("ko", [priorRow("Draft ready")]);

    await judge();

    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect(written()).toHaveLength(1);
  });
});
