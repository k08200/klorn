/**
 * backfillEmailAttentionItems — the durable safety net that re-judges emails
 * the fire-and-forget inline path left without an AttentionItem (so they never
 * appear in the firewall). db.js and the judge pipeline are mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const emailFindMany = vi.hoisted(() => vi.fn());
const attentionFindMany = vi.hoisted(() => vi.fn());
const notifFindFirst = vi.hoisted(() => vi.fn(async () => null));
const notifCreate = vi.hoisted(() => vi.fn(async () => ({ id: "n1", createdAt: new Date() })));
const judgeEmail = vi.hoisted(() => vi.fn());
const upsert = vi.hoisted(() => vi.fn(async () => {}));
const buildJudgeContext = vi.hoisted(() =>
  vi.fn(async () => ({ corrections: [], senderPrior: null })),
);
const captureError = vi.hoisted(() => vi.fn());
const sendPushNotification = vi.hoisted(() => vi.fn(async () => ({})));
const pushNotification = vi.hoisted(() => vi.fn());
const findOpenEmailAttentionItemId = vi.hoisted(() => vi.fn(async () => null));
// Hoisted so the BYOK resolve-once invariant is assertable: this is the lookup
// getUserLlmCredentials performs, and the whole point of the batch pattern is
// that it fires once per sweep, not once per email.
const userFindUnique = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../db.js", () => {
  const prisma = {
    emailMessage: { findMany: emailFindMany },
    attentionItem: { findMany: attentionFindMany },
    notification: { findFirst: notifFindFirst, create: notifCreate },
    // judgeAndMirrorEmail resolves the user's BYOK credentials; a keyless user
    // (null) yields {} and the call falls through to the shared env key.
    user: { findUnique: userFindUnique },
  };
  return { prisma, db: prisma };
});
vi.mock("../judge/poc-judge.js", () => ({ judgeEmail }));
vi.mock("../judge/judge-context.js", () => ({ buildJudgeContext }));
vi.mock("../judge/attention-mirror.js", () => ({ upsertAttentionForEmailJudgement: upsert }));
vi.mock("../sentry.js", () => ({ captureError }));
// Dynamically imported by the PUSH-tier push path.
vi.mock("../notify/push.js", () => ({ sendPushNotification }));
vi.mock("../websocket.js", () => ({ pushNotification }));
vi.mock("../judge/attention-override.js", () => ({ findOpenEmailAttentionItemId }));

import { backfillEmailAttentionItems, judgeAndMirrorEmail } from "../mail/email-sync.js";

const T0 = new Date("2026-06-14T00:00:00Z");

function email(id: string, receivedAt: Date) {
  return {
    id,
    gmailId: `g-${id}`,
    from: `s-${id}@x.com`,
    subject: id,
    snippet: null,
    labels: [] as string[],
    receivedAt,
  };
}
const recent = (id: string, minsAgo: number) =>
  email(id, new Date(T0.getTime() - minsAgo * 60_000));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  emailFindMany.mockReset();
  attentionFindMany.mockReset();
  notifFindFirst.mockReset();
  notifFindFirst.mockResolvedValue(null);
  notifCreate.mockClear();
  notifCreate.mockResolvedValue({ id: "n1", createdAt: T0 });
  judgeEmail.mockReset();
  judgeEmail.mockResolvedValue({ tier: "QUEUE", reason: "r", features: {}, source: "llm" });
  upsert.mockClear();
  captureError.mockClear();
  sendPushNotification.mockClear();
  pushNotification.mockClear();
  findOpenEmailAttentionItemId.mockReset();
  findOpenEmailAttentionItemId.mockResolvedValue(null);
  userFindUnique.mockReset();
  userFindUnique.mockResolvedValue(null); // keyless user → {} → shared-env path
});

const judgedSubjects = () => judgeEmail.mock.calls.map((c) => c[0].subject);

describe("backfillEmailAttentionItems", () => {
  it("no-ops when there are no recent emails", async () => {
    emailFindMany.mockResolvedValue([]);
    const n = await backfillEmailAttentionItems("u1");
    expect(n).toBe(0);
    expect(attentionFindMany).not.toHaveBeenCalled();
    expect(judgeEmail).not.toHaveBeenCalled();
  });

  it("only judges emails that have no AttentionItem yet", async () => {
    emailFindMany.mockResolvedValue([recent("a", 1), recent("b", 2), recent("c", 3)]);
    attentionFindMany.mockResolvedValue([{ sourceId: "b" }]); // b already judged
    const n = await backfillEmailAttentionItems("u1");
    expect(n).toBe(2);
    expect(judgedSubjects().sort()).toEqual(["a", "c"]);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("no-ops (no judging) when every recent email already has an AttentionItem", async () => {
    emailFindMany.mockResolvedValue([recent("a", 1), recent("b", 2)]);
    attentionFindMany.mockResolvedValue([{ sourceId: "a" }, { sourceId: "b" }]);
    const n = await backfillEmailAttentionItems("u1");
    expect(n).toBe(0);
    expect(judgeEmail).not.toHaveBeenCalled();
  });

  it("caps work at the batch limit so a big backlog drains over several ticks", async () => {
    const many = Array.from({ length: 30 }, (_, i) => recent(`e${i}`, i + 1));
    emailFindMany.mockResolvedValue(many);
    attentionFindMany.mockResolvedValue([]);
    const n = await backfillEmailAttentionItems("u1");
    expect(n).toBe(10); // BACKFILL_BATCH
    expect(judgeEmail).toHaveBeenCalledTimes(10);
  });

  it("resolves the user's BYOK credentials once for the whole sweep, not per email", async () => {
    // The invariant the resolve-once pattern exists to guarantee: a backlog of
    // N emails for one user costs ONE credential lookup, not N. The sweep
    // resolves before the loop and threads the result into every
    // judgeAndMirrorEmail, whose `credentials ?? resolve` then short-circuits.
    emailFindMany.mockResolvedValue([recent("a", 1), recent("b", 2), recent("c", 3)]);
    attentionFindMany.mockResolvedValue([]);

    await backfillEmailAttentionItems("u1");

    expect(judgeEmail).toHaveBeenCalledTimes(3);
    expect(userFindUnique).toHaveBeenCalledTimes(1); // resolve-once, not 3
    // keyless user → {} → every judge call carries the shared-env credentials
    for (const call of judgeEmail.mock.calls) {
      expect(call[3]).toEqual({});
    }
  });

  it("drains oldest-first (arrival order), not newest-first", async () => {
    // findMany returns newest-first (receivedAt desc); the sweep reverses so
    // the oldest stranded mail is judged first.
    emailFindMany.mockResolvedValue([recent("new", 1), recent("mid", 2), recent("old", 3)]);
    attentionFindMany.mockResolvedValue([]);
    await backfillEmailAttentionItems("u1");
    expect(judgedSubjects()).toEqual(["old", "mid", "new"]);
  });

  it("swallows a per-email failure and keeps going (count excludes the failure)", async () => {
    emailFindMany.mockResolvedValue([recent("a", 1), recent("b", 2), recent("c", 3)]);
    attentionFindMany.mockResolvedValue([]);
    judgeEmail
      .mockResolvedValueOnce({ tier: "QUEUE", reason: "r", features: {}, source: "llm" })
      .mockRejectedValueOnce(new Error("LLM blip"))
      .mockResolvedValueOnce({ tier: "QUEUE", reason: "r", features: {}, source: "llm" });
    const n = await backfillEmailAttentionItems("u1");
    expect(n).toBe(2);
    expect(judgeEmail).toHaveBeenCalledTimes(3);
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});

describe("judgeAndMirrorEmail — PUSH tier drives a real push", () => {
  const pushTier = () =>
    judgeEmail.mockResolvedValue({
      tier: "PUSH",
      reason: "moderator feedback",
      features: { confidence: 0.9, senderTrust: 0.6, reversibility: 0.9, urgency: 0.7 },
      source: "llm",
    });

  it("sends a push when the judge tiers a recent email PUSH (the core fix)", async () => {
    pushTier();
    const tier = await judgeAndMirrorEmail("u1", recent("hn", 5));
    expect(tier).toBe("PUSH");
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect(sendPushNotification.mock.calls[0][2]).toBe("email_urgent");
    expect(pushNotification).toHaveBeenCalledTimes(1); // in-app bell toast
    // Bell row carries the [gmailId] dedup marker.
    expect(notifCreate.mock.calls[0][0].data.message).toContain("[g-hn]");
  });

  it("does NOT push a QUEUE/SILENT tier", async () => {
    judgeEmail.mockResolvedValue({ tier: "QUEUE", reason: "r", features: {}, source: "llm" });
    await judgeAndMirrorEmail("u1", recent("q", 5));
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("does NOT push a backfilled OLD email, even if tiered PUSH (no stale interrupt)", async () => {
    pushTier();
    await judgeAndMirrorEmail("u1", recent("old", 8 * 60)); // 8h ago, past the 6h window
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(notifCreate).not.toHaveBeenCalled();
  });

  it("dedups — skips the push when a notification for this gmailId already exists", async () => {
    pushTier();
    notifFindFirst.mockResolvedValue({ id: "existing" });
    await judgeAndMirrorEmail("u1", recent("dup", 5));
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(notifCreate).not.toHaveBeenCalled();
  });

  it("never lets a push failure break classification (returns the tier regardless)", async () => {
    pushTier();
    sendPushNotification.mockRejectedValueOnce(new Error("push provider down"));
    const tier = await judgeAndMirrorEmail("u1", recent("err", 5));
    expect(tier).toBe("PUSH");
    expect(captureError).toHaveBeenCalled();
  });

  it("self-resolves BYOK credentials when the caller passes none (inline path)", async () => {
    // The single-email entry point (no `credentials` arg) must resolve them
    // itself via `credentials ?? await getUserLlmCredentials(userId)`, so an
    // inline judge bills the user's own key too — not just the batch callers.
    judgeEmail.mockResolvedValue({ tier: "QUEUE", reason: "r", features: {}, source: "llm" });

    await judgeAndMirrorEmail("u1", recent("solo", 5));

    expect(userFindUnique).toHaveBeenCalledTimes(1); // self-resolve fired
    expect(judgeEmail.mock.calls[0][3]).toEqual({}); // keyless → shared-env creds reach the judge
  });
});
