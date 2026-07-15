/**
 * fetchSenderItems query shape under the SENDER_ADDRESS_INDEX_ENABLED flag.
 *
 * OFF (default): the legacy substring path — `from: { contains, mode }` plus a
 * JS-side extractEmailAddress re-check. ZERO behavior change.
 *
 * ON: an indexed equality lookup on the normalized `fromAddress` column, no
 * `from` contains filter and no JS re-check (equality is exact; senderAddress
 * is already lowercased). Both paths must yield the same ownIds so the
 * downstream attentionItem query is unchanged.
 *
 * Prisma is mocked at the db.js boundary (repo convention); no real DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const attentionFindMany = vi.hoisted(() => vi.fn());
const emailFindMany = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  db: {
    attentionItem: { findMany: attentionFindMany },
    emailMessage: { findMany: emailFindMany },
  },
  prisma: {},
}));

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../learning/trust-score.js", () => ({
  getTrustScore: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../learning/interaction-graph.js", () => ({
  getCachedInteractionNode: vi.fn(() => Promise.resolve(null)),
}));

import { buildJudgeContext } from "../judge-context.js";

const ORIGINAL_FLAG = process.env.SENDER_ADDRESS_INDEX_ENABLED;

beforeEach(() => {
  attentionFindMany.mockReset();
  emailFindMany.mockReset();
  attentionFindMany.mockResolvedValue([]);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.SENDER_ADDRESS_INDEX_ENABLED;
  else process.env.SENDER_ADDRESS_INDEX_ENABLED = ORIGINAL_FLAG;
});

/** The sender-history query is the emailMessage.findMany that filters by userId. */
function senderHistoryCall() {
  return emailFindMany.mock.calls.find(
    (c) => (c[0].where as Record<string, unknown>).userId !== undefined,
  );
}

describe("fetchSenderItems query shape — SENDER_ADDRESS_INDEX_ENABLED off (default)", () => {
  it("uses the legacy `from: { contains }` substring filter", async () => {
    delete process.env.SENDER_ADDRESS_INDEX_ENABLED;
    emailFindMany.mockResolvedValue([{ id: "e1", from: "Alice <alice@corp.com>" }]);

    await buildJudgeContext("u1", { from: "Alice <alice@corp.com>" });

    const where = senderHistoryCall()?.[0].where as Record<string, unknown>;
    expect(where.from).toEqual({ contains: "alice@corp.com", mode: "insensitive" });
    expect(where.fromAddress).toBeUndefined();
  });

  it("keeps the JS address re-check that drops substring-matching senders", async () => {
    delete process.env.SENDER_ADDRESS_INDEX_ENABLED;
    emailFindMany.mockResolvedValue([
      { id: "real1", from: "Alice <alice@corp.com>" },
      { id: "bad1", from: "Malice <malice@corp.com>" },
    ]);

    await buildJudgeContext("u1", { from: "Alice <alice@corp.com>" });

    const historyCall = attentionFindMany.mock.calls.find(
      (c) => !("isManualOverride" in (c[0].where as Record<string, unknown>)),
    );
    expect((historyCall?.[0].where.sourceId as { in: string[] }).in).toEqual(["real1"]);
  });
});

describe("fetchSenderItems query shape — SENDER_ADDRESS_INDEX_ENABLED on", () => {
  it("uses an indexed `fromAddress` equality filter with no `from` contains", async () => {
    process.env.SENDER_ADDRESS_INDEX_ENABLED = "true";
    emailFindMany.mockResolvedValue([{ id: "e1" }]);

    await buildJudgeContext("u1", { from: "Alice <alice@corp.com>" });

    const where = senderHistoryCall()?.[0].where as Record<string, unknown>;
    expect(where.fromAddress).toBe("alice@corp.com");
    expect(where.from).toBeUndefined();
  });

  it("selects only ids (no `from`) and skips the JS re-check — equality is exact", async () => {
    process.env.SENDER_ADDRESS_INDEX_ENABLED = "1";
    emailFindMany.mockResolvedValue([{ id: "real1" }, { id: "real2" }]);

    await buildJudgeContext("u1", { from: "Alice <alice@corp.com>" });

    const call = senderHistoryCall();
    expect(call?.[0].select).toEqual({ id: true });

    const historyCall = attentionFindMany.mock.calls.find(
      (c) => !("isManualOverride" in (c[0].where as Record<string, unknown>)),
    );
    expect((historyCall?.[0].where.sourceId as { in: string[] }).in).toEqual(["real1", "real2"]);
  });

  it("still excludes the email being judged from its own history", async () => {
    process.env.SENDER_ADDRESS_INDEX_ENABLED = "yes";
    emailFindMany.mockResolvedValue([]);

    await buildJudgeContext("u1", { from: "A <a@b.com>", excludeEmailId: "self-id" });

    const where = senderHistoryCall()?.[0].where as Record<string, unknown>;
    expect(where.id).toEqual({ not: "self-id" });
  });
});
