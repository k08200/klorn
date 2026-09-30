/**
 * A re-judge of an EXISTING email item must never overwrite a decision made
 * while it ran (human-wins, GHSA-cxc5-fmqv-pxv6).
 *
 * The stale-hash heal re-judges in the background and ends in a write. The judge
 * call takes seconds, so a human override (or an MCP agent's lane change) can
 * land between the judge starting and the write. The old unconditional upsert
 * update branch replaced the tier and reset `isManualOverride`; the re-judge path
 * now writes through a guarded `updateMany` (mirror of fallback-rejudge) and, when
 * it matches nothing, skips every side effect that follows: the ledger refresh,
 * the wake-up, the push and the Gmail label.
 *
 * The real judgeAndMirrorEmail and upsertAttentionForEmailJudgement run over an
 * in-memory database (helpers/fake-db.ts); only the judge model and the
 * outward-facing notifiers are mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const judgeEmail = vi.hoisted(() => vi.fn());
const sendPushNotification = vi.hoisted(() => vi.fn(async () => ({})));
const pushNotification = vi.hoisted(() => vi.fn());
const notifyConversationsUpdated = vi.hoisted(() => vi.fn());
const applyLaneLabel = vi.hoisted(() => vi.fn(async () => "applied"));

vi.mock("../db.js", () => {
  const prisma = new Proxy(
    {},
    { get: (_t, name) => (dbHolder.current as FakeDb).model(String(name)) },
  );
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
vi.mock("../websocket.js", () => ({ pushNotification }));
vi.mock("../notify/conversations-updated.js", () => ({ notifyConversationsUpdated }));
vi.mock("../mail/gmail-labels.js", () => ({
  applyLaneLabel,
  isLabelModeEnabled: () => false,
  laneForLabelIds: vi.fn(async () => null),
}));

import { computeAttentionInputHash } from "../judge/attention-input-hash.js";
import { judgeAndMirrorEmail } from "../judge/email-firewall.js";

const USER = "user-1";
const NOW = new Date("2026-09-30T10:00:00.000Z");
const FEATURES = { confidence: 0.9, senderTrust: 0.8, reversibility: 0.5, urgency: 0.9 };
const JUDGEMENT = {
  tier: "PUSH",
  reason: "Urgent and confident",
  features: FEATURES,
  source: "llm",
  autoEligible: false,
};

const EMAIL = {
  id: "email-1",
  gmailId: "g-email-1",
  from: "Alice <alice@vc.example>",
  subject: "Term sheet",
  snippet: "Please review",
  labels: ["INBOX"],
  receivedAt: new Date(NOW.getTime() - 60_000),
  linkedInboxAccountId: null,
};

const STALE_HASH = computeAttentionInputHash({
  from: EMAIL.from,
  subject: EMAIL.subject,
  snippet: EMAIL.snippet,
  labels: ["INBOX", "UNREAD"],
});

const existingItem = (over: Row = {}): Row => ({
  id: "item-1",
  userId: USER,
  source: "EMAIL",
  sourceId: EMAIL.id,
  status: "OPEN",
  tier: "QUEUE",
  tierReason: "Visible in queue for manual review",
  isManualOverride: false,
  agentTierSetAt: null,
  agentTierKeyId: null,
  autoEligible: false,
  inputHash: STALE_HASH,
  ...over,
});

let db: FakeDb;
const seed = (items: Row[]) => {
  db = createFakeDb({ attentionItem: items, decisionLabel: [], notification: [], user: [] });
  dbHolder.current = db;
};
const itemRow = () => db.tables.attentionItem[0];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  judgeEmail.mockReset();
  judgeEmail.mockResolvedValue(JUDGEMENT);
  for (const fn of [
    sendPushNotification,
    pushNotification,
    notifyConversationsUpdated,
    applyLaneLabel,
  ]) {
    fn.mockClear();
  }
  seed([existingItem()]);
});

/** Everything that must NOT happen when the re-judge lost the race. */
function expectNoSideEffects() {
  expect(db.writes.decisionLabel).toBeUndefined();
  expect(db.writes.notification).toBeUndefined();
  expect(sendPushNotification).not.toHaveBeenCalled();
  expect(pushNotification).not.toHaveBeenCalled();
  expect(notifyConversationsUpdated).not.toHaveBeenCalled();
  expect(applyLaneLabel).not.toHaveBeenCalled();
}

describe("re-judging an existing item (the stale-hash heal)", () => {
  it("re-judges a plain stale item: tier replaced, hash refreshed, ledger and notifiers run as before", async () => {
    await judgeAndMirrorEmail(USER, EMAIL, undefined, undefined, { rejudge: true });
    expect(itemRow()).toMatchObject({
      tier: "PUSH",
      tierReason: "Urgent and confident",
      isManualOverride: false,
      agentTierSetAt: null,
    });
    expect(itemRow().inputHash).toBe(
      computeAttentionInputHash({
        from: EMAIL.from,
        subject: EMAIL.subject,
        snippet: EMAIL.snippet,
        labels: EMAIL.labels,
      }),
    );
    expect(db.tables.decisionLabel).toHaveLength(1);
    expect(notifyConversationsUpdated).toHaveBeenCalledTimes(1);
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect(applyLaneLabel).toHaveBeenCalledTimes(1);
  });

  it("writes through a guarded updateMany that requires no human override and no agent stamp", async () => {
    await judgeAndMirrorEmail(USER, EMAIL, undefined, undefined, { rejudge: true });
    const writes = db.writes.attentionItem;
    expect(writes).toHaveLength(1);
    expect(writes[0].op).toBe("updateMany");
    expect(writes[0].where).toEqual({
      userId: USER,
      source: "EMAIL",
      sourceId: EMAIL.id,
      isManualOverride: false,
      agentTierSetAt: null,
    });
  });

  it("keeps a human override that lands between the judge starting and the write — and fires nothing", async () => {
    judgeEmail.mockImplementation(async () => {
      Object.assign(itemRow(), {
        tier: "SILENT",
        tierReason: "Manual override — user moved to SILENT",
        isManualOverride: true,
      });
      return JUDGEMENT;
    });
    await judgeAndMirrorEmail(USER, EMAIL, undefined, undefined, { rejudge: true });
    expect(itemRow()).toMatchObject({ tier: "SILENT", isManualOverride: true });
    expect(itemRow().inputHash).toBe(STALE_HASH);
    expectNoSideEffects();
  });

  it("keeps an MCP agent's lane that lands between the judge starting and the write — and fires nothing", async () => {
    const stamp = new Date("2026-09-30T10:00:05.000Z");
    judgeEmail.mockImplementation(async () => {
      Object.assign(itemRow(), {
        tier: "INFO",
        tierReason: "Agent change — moved to INFO by a connected agent",
        agentTierSetAt: stamp,
        agentTierKeyId: "key-1",
      });
      return JUDGEMENT;
    });
    await judgeAndMirrorEmail(USER, EMAIL, undefined, undefined, { rejudge: true });
    expect(itemRow()).toMatchObject({
      tier: "INFO",
      agentTierSetAt: stamp,
      agentTierKeyId: "key-1",
    });
    expectNoSideEffects();
  });

  it("does nothing, and creates nothing, for an item that no longer exists", async () => {
    seed([]);
    await judgeAndMirrorEmail(USER, EMAIL, undefined, undefined, { rejudge: true });
    expect(db.tables.attentionItem).toHaveLength(0);
    expectNoSideEffects();
  });

  it("an item that already carries a human override is not even touched", async () => {
    seed([existingItem({ tier: "SILENT", isManualOverride: true })]);
    await judgeAndMirrorEmail(USER, EMAIL, undefined, undefined, { rejudge: true });
    expect(itemRow()).toMatchObject({ tier: "SILENT", isManualOverride: true });
    expectNoSideEffects();
  });
});

describe("a NEW item (ingest and backfill) keeps the plain upsert", () => {
  it("creates the item and runs every side effect", async () => {
    seed([]);
    await judgeAndMirrorEmail(USER, EMAIL);
    expect(db.tables.attentionItem).toHaveLength(1);
    expect(itemRow()).toMatchObject({ tier: "PUSH", isManualOverride: false, status: "OPEN" });
    expect(db.writes.attentionItem[0].op).toBe("upsert");
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect(notifyConversationsUpdated).toHaveBeenCalledTimes(1);
  });
});
