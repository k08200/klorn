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
};

const emailRow = {
  id: "email-1",
  gmailId: "gmail-1",
  ...baseEmailFields,
};

// Capture captureError calls so we can assert mismatch was logged.
const captureErrorMock = vi.fn();
vi.mock("../sentry.js", () => ({ captureError: captureErrorMock }));

// The self-heal path re-judges the stale row (lazy-imported by the route).
const judgeAndMirrorMock = vi.fn(async () => "QUEUE");
vi.mock("../judge/email-firewall.js", () => ({ judgeAndMirrorEmail: judgeAndMirrorMock }));

vi.mock("../db.js", () => ({
  prisma: {
    attentionItem: {
      findMany: vi.fn(async () => [attentionRow]),
    },
    pendingAction: { findMany: vi.fn(async () => []) },
    emailMessage: {
      findMany: vi.fn(async () => [emailRow]),
      // The heal re-fetches the FULL row (body included) before re-judging.
      findFirst: vi.fn(async () => ({ ...emailRow, body: null, receivedAt: new Date() })),
    },
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

describe("GET /api/inbox/firewall — hash verify integration", () => {
  beforeEach(async () => {
    captureErrorMock.mockClear();
    judgeAndMirrorMock.mockClear();
    attentionRow.inputHash = correctHash;
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
});
