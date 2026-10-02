/**
 * Hash-verify integration test — proves the firewall read path actually
 * re-hashes the email's current bytes and surfaces a mismatch as
 * `hashStale: true` on the response.
 *
 * The PR that added inputHash + the helper module (#468) shipped the WRITE
 * side. This test pins the READ side that the dev.to thread reply
 * promised: "if anything mutates those bytes between decision and read,
 * the stored hash and the recomputed hash diverge". Without this
 * integration the storage was empty calories.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const attentionUpdateMany = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ count: 1 })));

vi.mock("../mail/activity-sync.js", () => ({
  ensureRecentMailSync: vi.fn(async () => {}),
}));

import { computeAttentionInputHash } from "../judge/attention-input-hash.js";

const baseEmailFields = {
  from: "alice@example.com",
  subject: "Quarterly review draft",
  snippet: "Hi — the deck is attached.",
  labels: ["INBOX", "IMPORTANT"],
};

// Hash that matches `baseEmailFields` — stored at classify time.
const correctHash = computeAttentionInputHash(baseEmailFields);

// Hash that does NOT match — pretend a different snippet was classified
// before the snippet got mutated to its current value.
const staleStoredHash = computeAttentionInputHash({
  ...baseEmailFields,
  snippet: "Hi — the deck is attached. (mutated AFTER classify)",
});

const attentionRow = {
  id: "att-1",
  source: "EMAIL",
  sourceId: "email-1",
  type: "REPLY_NEEDED",
  title: baseEmailFields.subject,
  tier: "QUEUE",
  tierReason: "test fixture",
  priority: 50,
  surfacedAt: new Date("2026-06-02T00:00:00Z"),
  inputHash: correctHash, // overwritten per test below
  agentTierSetAt: null as Date | null, // set per test to model an MCP agent's lane change
  isManualOverride: false, // set per test to model a human's override
};

const emailRow: typeof baseEmailFields & {
  id: string;
  gmailId: string;
  needsReply?: boolean;
  repliedAt?: Date | null;
  proactiveDraft?: string | null;
} = {
  id: "email-1",
  gmailId: "gmail-1",
  ...baseEmailFields,
};

// Capture captureError calls so we can assert mismatch was logged.
const captureErrorMock = vi.fn();
vi.mock("../sentry.js", () => ({ captureError: captureErrorMock }));

// The self-heal path re-judges the stale row (lazy-imported by the route).
const judgeAndMirrorMock = vi.fn(async () => "QUEUE");
vi.mock("../judge/email-firewall.js", () => ({
  judgeAndMirrorEmail: judgeAndMirrorMock,
  // Identity stub: the heal path maps the DB row through this before
  // judging; a missing export would throw inside the heal's catch and mask
  // the behavior this file asserts. Kept a stub (not importOriginal) so the
  // hot-read-path tests still never load the judge's heavy module graph.
  toJudgeableEmailRow: (row: Record<string, unknown>) => row,
}));

vi.mock("../db.js", () => ({
  prisma: {
    attentionItem: {
      findMany: vi.fn(async () => [attentionRow]),
      updateMany: attentionUpdateMany,
    },
    pendingAction: { findMany: vi.fn(async () => []) },
    emailMessage: {
      findMany: vi.fn(async () => [emailRow]),
      // The heal re-fetches the FULL row (body included) before re-judging.
      findFirst: vi.fn(async () => ({ ...emailRow, body: null, receivedAt: new Date() })),
    },
    // Row-signal chips batch reply history per page; empty = no chips.
    contactEngagementScore: { findMany: vi.fn(async () => []) },
    // Company-domain chip lookup (fail-open, but a missing model would log
    // a TypeError to Sentry and pollute the assertions below).
    user: { findUnique: vi.fn(async () => ({ companyDomains: [] })) },
    senderLabel: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("../auth.js", () => ({
  resolveEffectiveJwtSecret: () => "test-secret",
  requireAuth: vi.fn(async () => {}),
  getUserId: vi.fn(() => "user-1"),
}));

vi.mock("../learning/trust-score.js", () => ({
  getTrustScoresBulk: vi.fn(async () => new Map()),
}));

// poc-judge is stubbed so the classifier read-path invariant
// (firewall-classifier-readpath.test.ts) continues to be respected here.
vi.mock("../judge/poc-judge.js", () => ({
  judgeEmail: vi.fn(() => {
    throw new Error("invariant violated: read path invoked poc-judge");
  }),
  judgeEmails: vi.fn(() => {
    throw new Error("invariant violated: read path invoked poc-judge (bulk)");
  }),
  POC_TIERS: ["SILENT", "QUEUE", "PUSH", "AUTO"],
  tierFromFeatures: vi.fn(() => ({ tier: "QUEUE", reason: "stub" })),
}));

const { firewallRoutes } = await import("../routes/firewall.js");

async function buildApp() {
  const app = Fastify();
  await app.register(firewallRoutes, { prefix: "/api/inbox/firewall" });
  return app;
}

interface FirewallItemWire {
  id: string;
  source: string;
  hashStale?: boolean;
}

interface FirewallResponseWire {
  tiers: Record<string, FirewallItemWire[]>;
}

function findItem(body: FirewallResponseWire, id: string): FirewallItemWire | undefined {
  for (const tier of Object.values(body.tiers)) {
    for (const row of tier) {
      if (row.id === id) return row;
    }
  }
  return undefined;
}

describe("GET /api/inbox/firewall — draftReady on the row", () => {
  async function rowEmail() {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
    await app.close();
    return findItem(res.json() as FirewallResponseWire, "att-1")?.email;
  }

  it("is true while a stored draft waits, false once answered or when none exists", async () => {
    attentionRow.inputHash = correctHash;
    expect((await rowEmail())?.draftReady).toBe(false);

    emailRow.needsReply = true;
    emailRow.proactiveDraft = "Hi — 3pm works.";
    try {
      const waiting = await rowEmail();
      expect(waiting?.draftReady).toBe(true);
      expect(waiting?.replyState).toBe("needsReply");

      emailRow.repliedAt = new Date("2026-09-28T01:00:00Z");
      const answered = await rowEmail();
      expect(answered?.draftReady).toBe(false);
      expect(answered?.replyState).toBe("replied");
    } finally {
      delete emailRow.needsReply;
      delete emailRow.proactiveDraft;
      delete emailRow.repliedAt;
    }
  });
});

describe("GET /api/inbox/firewall — hash verify integration", () => {
  beforeEach(async () => {
    captureErrorMock.mockClear();
    judgeAndMirrorMock.mockClear();
    attentionUpdateMany.mockReset();
    attentionUpdateMany.mockResolvedValue({ count: 1 });
    attentionRow.inputHash = correctHash;
    attentionRow.agentTierSetAt = null;
    attentionRow.isManualOverride = false;
    const { _resetHashMismatchDedupeForTests } = await import("../routes/firewall.js");
    _resetHashMismatchDedupeForTests();
  });

  it("does NOT mark hashStale when stored hash matches current bytes", async () => {
    attentionRow.inputHash = correctHash;
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as FirewallResponseWire;
    const item = findItem(body, "att-1");
    expect(item).toBeDefined();
    expect(item?.hashStale).toBeUndefined();
    expect(captureErrorMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("marks hashStale=true and captures Sentry error when stored hash diverges", async () => {
    attentionRow.inputHash = staleStoredHash;
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as FirewallResponseWire;
    const item = findItem(body, "att-1");
    expect(item).toBeDefined();
    expect(item?.hashStale).toBe(true);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureErrorMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/hash mismatch/i);
    expect(ctx?.tags?.scope).toBe("firewall.hashVerify");
    expect(ctx?.extra?.attentionItemId).toBe("att-1");
    expect(ctx?.extra?.emailDbId).toBe("email-1");
    // The heal fired: the stale row gets RE-JUDGED (which rewrites inputHash).
    await vi.waitFor(() => expect(judgeAndMirrorMock).toHaveBeenCalledTimes(1));
    await app.close();
  });

  it("alerts and heals only ONCE per (row, storedHash) — repeat reads stay silent", async () => {
    // Before this dedupe, the desktop's 60s poll re-paged the same benign
    // mutation forever: 333 Sentry events in the first 12 minutes of the DSN
    // going live (2026-07-20).
    attentionRow.inputHash = staleStoredHash;
    const app = await buildApp();

    const first = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
    expect(first.statusCode).toBe(200);
    await vi.waitFor(() => expect(judgeAndMirrorMock).toHaveBeenCalledTimes(1));
    expect(captureErrorMock).toHaveBeenCalledTimes(1);

    const second = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
    expect(second.statusCode).toBe(200);
    // Still flagged stale on the wire — clients keep seeing the truth…
    expect(findItem(second.json() as FirewallResponseWire, "att-1")?.hashStale).toBe(true);
    // …but no new page and no duplicate heal.
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(judgeAndMirrorMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("treats null stored hash as legacy (pre-PR #468) — no mismatch, no Sentry", async () => {
    attentionRow.inputHash = null as unknown as string;
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as FirewallResponseWire;
    const item = findItem(body, "att-1");
    expect(item).toBeDefined();
    expect(item?.hashStale).toBeUndefined();
    expect(captureErrorMock).not.toHaveBeenCalled();
    await app.close();
  });

  describe("a stale hash on an item whose lane must not be re-judged", () => {
    const AGENT_STAMP = new Date("2026-09-30T09:00:00Z");
    const CASES: Array<[string, { agentTierSetAt: Date | null; isManualOverride: boolean }]> = [
      ["an MCP agent set the lane", { agentTierSetAt: AGENT_STAMP, isManualOverride: false }],
      ["a human overrode the lane", { agentTierSetAt: null, isManualOverride: true }],
    ];

    /**
     * Model the database applying the refresh: it matches only a row that still
     * carries the human flag or the agent stamp (the WHERE's OR), and then the next
     * board read sees the new hash.
     */
    function applyRefreshToRow() {
      attentionUpdateMany.mockImplementation(async (...args: unknown[]) => {
        const { data } = args[0] as { data: { inputHash: string } };
        const carriesFlag = attentionRow.agentTierSetAt != null || attentionRow.isManualOverride;
        if (!carriesFlag) return { count: 0 };
        attentionRow.inputHash = data.inputHash;
        return { count: 1 };
      });
    }

    for (const [label, flags] of CASES) {
      it(`${label}: only the hash is refreshed — never re-judged (a read-state flip must not undo it)`, async () => {
        attentionRow.inputHash = staleStoredHash;
        Object.assign(attentionRow, flags);
        const app = await buildApp();

        const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
        expect(res.statusCode).toBe(200);
        expect(findItem(res.json() as FirewallResponseWire, "att-1")?.hashStale).toBe(true);

        await vi.waitFor(() => expect(attentionUpdateMany).toHaveBeenCalledTimes(1));
        expect(judgeAndMirrorMock).not.toHaveBeenCalled();
        const arg = attentionUpdateMany.mock.calls[0]?.[0] as {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        };
        // Only the hash columns move: never the tier, its reason, or either flag.
        expect(Object.keys(arg.data).sort()).toEqual(["inputHash", "inputHashAt"]);
        expect(arg.data.inputHash).toBe(correctHash);
        // Guarded on the row still being open AND still carrying the stamp or the flag,
        // so a flag cleared in the meantime makes the refresh match nothing.
        expect(arg.where).toEqual({
          userId: "user-1",
          source: "EMAIL",
          sourceId: "email-1",
          status: "OPEN",
          OR: [{ agentTierSetAt: { not: null } }, { isManualOverride: true }],
        });
        await app.close();
      });
    }

    it("after a refresh the next board read is no longer stale and heals nothing more", async () => {
      attentionRow.inputHash = staleStoredHash;
      attentionRow.isManualOverride = true;
      applyRefreshToRow();
      const app = await buildApp();

      await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
      await vi.waitFor(() => expect(attentionUpdateMany).toHaveBeenCalledTimes(1));
      captureErrorMock.mockClear();

      const second = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
      expect(findItem(second.json() as FirewallResponseWire, "att-1")?.hashStale).toBeUndefined();
      expect(captureErrorMock).not.toHaveBeenCalled();
      expect(attentionUpdateMany).toHaveBeenCalledTimes(1);
      expect(judgeAndMirrorMock).not.toHaveBeenCalled();
      await app.close();
    });

    it("falls through to a re-judge when the flag or stamp was cleared before the refresh ran (zero rows)", async () => {
      attentionRow.inputHash = staleStoredHash;
      attentionRow.isManualOverride = true;
      attentionUpdateMany.mockResolvedValue({ count: 0 });
      const app = await buildApp();

      await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
      // Two refresh attempts: the keep-lane one that matched nothing, then the one
      // after the re-judge (also matching nothing here: neither flag is set).
      await vi.waitFor(() => expect(attentionUpdateMany).toHaveBeenCalledTimes(2));
      expect(judgeAndMirrorMock).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("control: a stale hash on a judge-tiered item IS re-judged; the refresh after it can only match a flagged row", async () => {
      attentionRow.inputHash = staleStoredHash;
      applyRefreshToRow();
      const app = await buildApp();
      await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
      await vi.waitFor(() => expect(attentionUpdateMany).toHaveBeenCalledTimes(1));
      expect(judgeAndMirrorMock).toHaveBeenCalledTimes(1);
      // After the re-judge, never before it.
      expect(judgeAndMirrorMock.mock.invocationCallOrder[0]).toBeLessThan(
        attentionUpdateMany.mock.invocationCallOrder[0],
      );
      const arg = attentionUpdateMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
      expect(arg.where.OR).toEqual([{ agentTierSetAt: { not: null } }, { isManualOverride: true }]);
      // This row carries neither flag, so the refresh changed nothing.
      expect(attentionRow.inputHash).toBe(staleStoredHash);
      await app.close();
    });

    it("a human override that lands DURING the re-judge (write refused) still gets its hash refreshed, so the row does not stay stale", async () => {
      attentionRow.inputHash = staleStoredHash;
      applyRefreshToRow();
      // The heal started with no flag set; the override lands while the judge runs, so
      // the guarded write is refused ("preserved") and never refreshes the hash itself.
      judgeAndMirrorMock.mockImplementationOnce(async () => {
        attentionRow.isManualOverride = true;
        return "QUEUE";
      });
      const app = await buildApp();
      await app.inject({ method: "GET", url: "/api/inbox/firewall/" });

      await vi.waitFor(() => expect(attentionUpdateMany).toHaveBeenCalledTimes(1));
      expect(judgeAndMirrorMock).toHaveBeenCalledTimes(1);
      expect(attentionRow.inputHash).toBe(correctHash);

      // The hash-mismatch dedupe is per process, so a row left stale would stay
      // hashStale until a restart. It is not stale now.
      captureErrorMock.mockClear();
      const second = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
      expect(findItem(second.json() as FirewallResponseWire, "att-1")?.hashStale).toBeUndefined();
      expect(captureErrorMock).not.toHaveBeenCalled();
      await app.close();
    });

    it("every re-judge the heal starts is marked as a re-judge of an EXISTING item, so the write is guarded", async () => {
      attentionRow.inputHash = staleStoredHash;
      const app = await buildApp();
      await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
      await vi.waitFor(() => expect(judgeAndMirrorMock).toHaveBeenCalledTimes(1));
      const call = judgeAndMirrorMock.mock.calls[0] as unknown[];
      expect(call[4]).toEqual({ rejudge: true });
      await app.close();
    });
  });

  describe("agentSet on the wire (additive, only when an MCP agent set the lane)", () => {
    const itemJson = async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/inbox/firewall/" });
      await app.close();
      return findItem(res.json() as FirewallResponseWire, "att-1") as Record<string, unknown>;
    };

    it("is true for an agent-set item", async () => {
      attentionRow.agentTierSetAt = new Date("2026-09-30T09:00:00Z");
      expect((await itemJson()).agentSet).toBe(true);
    });

    it("is ABSENT, not false, otherwise — so a response with the flag off is byte-identical to main", async () => {
      const item = await itemJson();
      expect("agentSet" in item).toBe(false);
      attentionRow.isManualOverride = true;
      expect("agentSet" in (await itemJson())).toBe(false);
    });

    it("never leaks the stamp's time or the key id", async () => {
      attentionRow.agentTierSetAt = new Date("2026-09-30T09:00:00Z");
      const item = await itemJson();
      expect(Object.keys(item)).not.toContain("agentTierSetAt");
      expect(Object.keys(item)).not.toContain("agentTierKeyId");
    });
  });
});
