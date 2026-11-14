/**
 * The firewall ring's reason line (NC1): for a user under policy v3 the push
 * and the live desktop frame carry the stored evidence quote — only when it
 * re-checks against the mail — and otherwise the judge's reason. Real
 * deliverFirewallPush over the in-memory database; notifiers mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const sendPushNotification = vi.hoisted(() => vi.fn(async () => ({ dispatchedAt: null })));
const pushNotification = vi.hoisted(() => vi.fn());

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../notify/push.js", () => ({ sendPushNotification }));
vi.mock("../websocket.js", () => ({ pushNotification }));
vi.mock("../notify/desktop-alert.js", () => ({ desktopAlertTag: vi.fn(async () => ({})) }));

import { deliverFirewallPush } from "../judge/firewall-push.js";

const USER = "user-1";
const NOW = new Date("2026-11-14T01:00:00.000Z");
const BODY = "Hi Alice, please sign the contract by 5pm today so we can start. Thanks";

const email = {
  id: "email-1",
  gmailId: "g-1",
  from: "Bob Lee <bob@example.com>",
  subject: "Contract",
  snippet: "Hi Alice, please sign",
  body: BODY,
  labels: ["INBOX"],
  receivedAt: new Date(NOW.getTime() - 60_000),
};

function seed(evidence: string) {
  const item: Row = {
    id: "item-1",
    userId: USER,
    source: "EMAIL",
    sourceId: "email-1",
    type: "REPLY_NEEDED",
    title: "Contract",
    tier: "PUSH",
    tierReason: "Signature needed today",
    status: "OPEN",
    v3PolicyVersion: "v3.1",
    v3Decision: {
      basis: "llm",
      reasons: [{ code: "ask_due_soon", fact: "asks[0]", evidence, params: {} }],
      threadTurn: null,
    },
  };
  const db = createFakeDb({ attentionItem: [item], emailMessage: [], decisionLabel: [] });
  dbHolder.current = db;
}

const payload = () =>
  (sendPushNotification.mock.calls[0] as unknown as [string, { title: string; body: string }])[1];
const frameMail = () =>
  (
    pushNotification.mock.calls[0] as unknown as [string, { mail: { title: string; body: string } }]
  )[1].mail;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.JUDGE_V3_POLICY = "true";
  process.env.JUDGE_V3_SHADOW = "true";
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.JUDGE_V3_POLICY;
  delete process.env.JUDGE_V3_SHADOW;
});

describe("deliverFirewallPush — reason line", () => {
  it("policy v3, quote in the mail: push and frame show the quote, identically", async () => {
    seed("please sign the contract by 5pm today");
    await deliverFirewallPush(USER, email, { id: "bell-1", createdAt: NOW }, "en");
    expect(payload().title).toBe("Bob Lee");
    expect(payload().body).toBe("Contract\n“please sign the contract by 5pm today”");
    expect(frameMail()).toMatchObject({ title: payload().title, body: payload().body });
  });

  it("policy v3, quote NOT in the mail: the short reason, never the quote", async () => {
    seed("wire the payment to the new account today");
    await deliverFirewallPush(USER, email, { id: "bell-1", createdAt: NOW }, "en");
    expect(payload().body).toBe("Contract\nSignature needed today");
    expect(frameMail().body).toBe(payload().body);
  });

  it("outside policy v3: the short reason even when stored evidence exists", async () => {
    delete process.env.JUDGE_V3_POLICY;
    seed("please sign the contract by 5pm today");
    await deliverFirewallPush(USER, email, { id: "bell-1", createdAt: NOW }, "en");
    expect(payload().body).toBe("Contract\nSignature needed today");
  });
});
