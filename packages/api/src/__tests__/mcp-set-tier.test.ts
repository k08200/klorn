/**
 * set_tier over MCP (step A2b of docs/providers/unified-platform-plan.md).
 *
 * The executor runs for real against an in-memory stand-in for the models it
 * touches (helpers/fake-db.ts evaluates the `where` it builds). What these tests
 * pin is the trust boundary: an agent's lane change is recorded as AGENT
 * provenance, never as a human override, never on the decision ledger, never
 * as a notification or a Gmail label, and never over a human's own move.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const forbidden = vi.hoisted(() => ({
  sendPushNotification: vi.fn(),
  pushNotification: vi.fn(),
  applyLaneLabel: vi.fn(),
  mailActionsFor: vi.fn(),
  overrideAttentionTier: vi.fn(),
  confirmAttentionTier: vi.fn(),
  notifyConversationsUpdated: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = new Proxy(
    {},
    { get: (_t, name) => (dbHolder.current as FakeDb).model(String(name)) },
  );
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: forbidden.captureError }));
vi.mock("../notify/push.js", () => ({ sendPushNotification: forbidden.sendPushNotification }));
vi.mock("../websocket.js", () => ({ pushNotification: forbidden.pushNotification }));
vi.mock("../mail/gmail-labels.js", () => ({
  applyLaneLabel: forbidden.applyLaneLabel,
  isLabelModeEnabled: () => true,
}));
vi.mock("../mail/providers/dispatch.js", () => ({ mailActionsFor: forbidden.mailActionsFor }));
vi.mock("../notify/conversations-updated.js", () => ({
  notifyConversationsUpdated: forbidden.notifyConversationsUpdated,
}));
vi.mock("../judge/attention-override.js", () => ({
  overrideAttentionTier: forbidden.overrideAttentionTier,
  confirmAttentionTier: forbidden.confirmAttentionTier,
}));

import { MANUAL_OVERRIDE_PREFIX } from "../judge/tiers.js";
import { executeSetTier } from "../mcp/set-tier.js";
import { WRITE_TOOL_SUCCESS } from "../mcp/write-call.js";

const USER = "user-1";
const KEY = "key-1";
const NOW = new Date("2026-09-30T10:00:00.000Z");

const email = (over: Row = {}): Row => ({
  id: "email-db-1",
  userId: USER,
  gmailId: "18c3f0a1b2c3d4e5",
  ...over,
});
const item = (over: Row = {}): Row => ({
  id: "item-1",
  userId: USER,
  source: "EMAIL",
  sourceId: "email-db-1",
  status: "OPEN",
  tier: "QUEUE",
  tierReason: "Visible in queue for manual review",
  isManualOverride: false,
  agentTierSetAt: null,
  agentTierKeyId: null,
  ...over,
});

let db: FakeDb;
function seed(rows: { emails?: Row[]; items?: Row[]; ledger?: Row[] }, hooks = {}): FakeDb {
  db = createFakeDb(
    {
      emailMessage: rows.emails ?? [email()],
      attentionItem: rows.items ?? [item()],
      decisionLabel: rows.ledger ?? [
        {
          userId: USER,
          source: "EMAIL",
          sourceId: "email-db-1",
          shownTier: "QUEUE",
          outcome: null,
        },
      ],
    },
    hooks,
  );
  dbHolder.current = db;
  return db;
}

const run = async (args: Record<string, unknown>, ctx = { userId: USER, apiKeyId: KEY }) =>
  JSON.parse(await executeSetTier(ctx, args)) as Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.unstubAllEnvs();
  for (const fn of Object.values(forbidden)) fn.mockReset();
  seed({});
});

describe("argument validation", () => {
  it.each([
    ["AUTO (retired v1 value)", "AUTO"],
    ["CALL (retired v1 value)", "CALL"],
    ["lowercase push", "push"],
    ["an invented sixth lane", "URGENT"],
    ["empty string", ""],
    ["a number", 7],
    ["null", null],
    ["an array", ["PUSH"]],
    ["undefined", undefined],
  ])("rejects tier = %s and touches nothing", async (_label, tier) => {
    const out = await run({ email_id: "18c3f0a1b2c3d4e5", tier });
    expect(out.error).toMatch(/PUSH, MEETING, QUEUE, INFO, SILENT/);
    expect(out.code).toBe("INVALID_ARGUMENT");
    expect(out.success).toBeUndefined();
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual({});
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
    ["a number", 42],
    ["an object", { id: "x" }],
    ["longer than any id", "a".repeat(257)],
  ])("rejects email_id that is %s and touches nothing", async (_label, emailId) => {
    const out = await run({ email_id: emailId, tier: "PUSH" });
    expect(out.error).toMatch(/email_id/);
    expect(out.code).toBe("INVALID_ARGUMENT");
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual({});
  });

  it.each(["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"])("accepts %s", async (tier) => {
    seed({ items: [item({ tier: tier === "INFO" ? "QUEUE" : "SILENT" })] });
    const out = await run({ email_id: "18c3f0a1b2c3d4e5", tier });
    expect(out.success).toBe(true);
    expect(out.tier).toBe(tier);
  });
});

describe("resolving the email and its open item", () => {
  it("resolves a provider (Gmail) id and a Klorn row id to the same item, scoped to the caller", async () => {
    const byGmail = await run({ email_id: "18c3f0a1b2c3d4e5", tier: "PUSH" });
    expect(byGmail.success).toBe(true);
    seed({});
    const byRowId = await run({ email_id: "email-db-1", tier: "PUSH" });
    expect(byRowId.success).toBe(true);
    expect(db.tables.attentionItem[0].tier).toBe("PUSH");
  });

  it("never reaches another user's message, even with the right id", async () => {
    seed({
      emails: [email({ userId: "someone-else" })],
      items: [item({ userId: "someone-else" })],
    });
    const out = await run({ email_id: "18c3f0a1b2c3d4e5", tier: "PUSH" });
    expect(out.code).toBe("NOT_FOUND");
    expect(db.writes.attentionItem).toBeUndefined();
    expect(db.tables.attentionItem[0].tier).toBe("QUEUE");
  });

  it("answers an explicit NOT_FOUND when the id matches no email", async () => {
    const out = await run({ email_id: "nope", tier: "PUSH" });
    expect(out.code).toBe("NOT_FOUND");
    expect(out.error).toMatch(/no open/i);
    expect(db.writes).toEqual({});
  });

  it.each([
    "RESOLVED",
    "DISMISSED",
    "SNOOZED",
  ])("answers an explicit NOT_FOUND for a %s item (only an OPEN item can change lane)", async (status) => {
    seed({ items: [item({ status })] });
    const out = await run({ email_id: "email-db-1", tier: "PUSH" });
    expect(out.code).toBe("NOT_FOUND");
    expect(db.writes.attentionItem).toBeUndefined();
  });

  it("answers an explicit NOT_FOUND for an email that has no attention item yet", async () => {
    seed({ items: [] });
    const out = await run({ email_id: "email-db-1", tier: "PUSH" });
    expect(out.code).toBe("NOT_FOUND");
  });
});

describe("a human always wins", () => {
  it("refuses, with an explicit result, when the item carries a human override — and writes nothing", async () => {
    seed({
      items: [
        item({
          tier: "SILENT",
          tierReason: `${MANUAL_OVERRIDE_PREFIX} — user moved to SILENT`,
          isManualOverride: true,
        }),
      ],
    });
    const out = await run({ email_id: "email-db-1", tier: "PUSH" });
    expect(out.code).toBe("MANUAL_OVERRIDE");
    expect(out.error).toMatch(/by hand|moved/i);
    expect(out.success).toBeUndefined();
    expect(db.writes).toEqual({});
    expect(db.tables.attentionItem[0]).toMatchObject({ tier: "SILENT", isManualOverride: true });
  });

  it("refuses even when the requested lane equals the human's (no-op must not look like consent)", async () => {
    seed({ items: [item({ tier: "SILENT", isManualOverride: true })] });
    const out = await run({ email_id: "email-db-1", tier: "SILENT" });
    expect(out.code).toBe("MANUAL_OVERRIDE");
  });

  it("holds when the human overrides between the read and the write (guarded write matches nothing)", async () => {
    seed(
      {},
      {
        beforeUpdateMany: (model: string) => {
          if (model !== "attentionItem") return;
          Object.assign(db.tables.attentionItem[0], { tier: "SILENT", isManualOverride: true });
        },
      },
    );
    const out = await run({ email_id: "email-db-1", tier: "PUSH" });
    expect(out.code).toBe("MANUAL_OVERRIDE");
    expect(db.tables.attentionItem[0]).toMatchObject({
      tier: "SILENT",
      isManualOverride: true,
      agentTierSetAt: null,
    });
  });

  it("reports NOT_FOUND, not a phantom success, when the item closes between the read and the write", async () => {
    seed(
      {},
      {
        beforeUpdateMany: (model: string) => {
          if (model === "attentionItem")
            Object.assign(db.tables.attentionItem[0], { status: "RESOLVED" });
        },
      },
    );
    const out = await run({ email_id: "email-db-1", tier: "PUSH" });
    expect(out.code).toBe("NOT_FOUND");
    expect(out.success).toBeUndefined();
  });
});

describe("agent provenance — never a human signal", () => {
  it("writes exactly tier, a distinct tierReason and the agent stamp; isManualOverride is never in the write", async () => {
    const out = await run({ email_id: "email-db-1", tier: "PUSH" });
    expect(out).toEqual({
      success: true,
      email_id: "email-db-1",
      previous_tier: "QUEUE",
      tier: "PUSH",
      changed: true,
    });
    const writes = db.writes.attentionItem;
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0].data ?? {}).sort()).toEqual([
      "agentTierKeyId",
      "agentTierSetAt",
      "tier",
      "tierReason",
    ]);
    expect(writes[0].data).toMatchObject({
      tier: "PUSH",
      agentTierKeyId: KEY,
      agentTierSetAt: NOW,
    });
    expect(db.tables.attentionItem[0].isManualOverride).toBe(false);
  });

  it("guards the write on the item still being open and not human-overridden", async () => {
    await run({ email_id: "email-db-1", tier: "PUSH" });
    expect(db.writes.attentionItem[0].where).toEqual({
      id: "item-1",
      userId: USER,
      status: "OPEN",
      isManualOverride: false,
    });
  });

  it("stamps a tierReason that does not carry the human-override prefix", async () => {
    await run({ email_id: "email-db-1", tier: "SILENT" });
    const reason = String(db.tables.attentionItem[0].tierReason);
    expect(reason.startsWith(MANUAL_OVERRIDE_PREFIX)).toBe(false);
    expect(reason.toLowerCase()).not.toContain("manual override");
    expect(reason).toMatch(/agent/i);
    expect(reason).toContain("SILENT");
  });

  it("does not stamp the decision ledger, so a later human stamp is never blocked", async () => {
    await run({ email_id: "email-db-1", tier: "PUSH" });
    expect(db.writes.decisionLabel).toBeUndefined();
    expect(db.tables.decisionLabel[0].outcome).toBeNull();
  });

  it("does not go through the human override path", async () => {
    await run({ email_id: "email-db-1", tier: "PUSH" });
    expect(forbidden.overrideAttentionTier).not.toHaveBeenCalled();
    expect(forbidden.confirmAttentionTier).not.toHaveBeenCalled();
  });

  it("a second agent change replaces the stamp and reports the agent's previous lane", async () => {
    await run({ email_id: "email-db-1", tier: "PUSH" });
    vi.setSystemTime(new Date("2026-09-30T11:00:00.000Z"));
    const out = await run(
      { email_id: "email-db-1", tier: "INFO" },
      { userId: USER, apiKeyId: "key-2" },
    );
    expect(out).toMatchObject({ previous_tier: "PUSH", tier: "INFO", changed: true });
    expect(db.tables.attentionItem[0]).toMatchObject({
      tier: "INFO",
      agentTierKeyId: "key-2",
      agentTierSetAt: new Date("2026-09-30T11:00:00.000Z"),
      isManualOverride: false,
    });
  });

  it("asking for the lane an item already has changes nothing and leaves provenance alone", async () => {
    const out = await run({ email_id: "email-db-1", tier: "QUEUE" });
    expect(out).toMatchObject({
      success: true,
      changed: false,
      previous_tier: "QUEUE",
      tier: "QUEUE",
    });
    expect(db.writes.attentionItem).toBeUndefined();
    expect(db.tables.attentionItem[0].agentTierSetAt).toBeNull();
  });

  it.each([
    ["null (unclassified)", null, "QUEUE"],
    ["CALL (retired, folds to PUSH)", "CALL", "PUSH"],
    ["AUTO (retired, folds to QUEUE)", "AUTO", "QUEUE"],
  ])("reports previous_tier for a legacy stored tier %s as a live lane", async (_l, stored, shown) => {
    seed({ items: [item({ tier: stored })] });
    const out = await run({ email_id: "email-db-1", tier: "SILENT" });
    expect(out.previous_tier).toBe(shown);
  });

  it("the success predicate accepts the success result and rejects every refusal", async () => {
    const predicate = WRITE_TOOL_SUCCESS.set_tier;
    expect(predicate(await run({ email_id: "email-db-1", tier: "PUSH" }))).toBe(true);
    expect(predicate(await run({ email_id: "email-db-1", tier: "AUTO" }))).toBe(false);
    expect(predicate(await run({ email_id: "missing", tier: "PUSH" }))).toBe(false);
    expect(predicate(null)).toBe(false);
    expect(predicate([])).toBe(false);
    expect(predicate({ success: "true" })).toBe(false);
  });
});

describe("side effects an injected agent must not trigger", () => {
  it("moving to PUSH fires no push, banner, Telegram message, bell row or client wake-up", async () => {
    await run({ email_id: "email-db-1", tier: "PUSH" });
    expect(forbidden.sendPushNotification).not.toHaveBeenCalled();
    expect(forbidden.pushNotification).not.toHaveBeenCalled();
    expect(forbidden.notifyConversationsUpdated).not.toHaveBeenCalled();
    expect(db.writes.notification).toBeUndefined();
  });

  it("moving to MEETING (which notifies when the judge picks it) fires nothing either", async () => {
    await run({ email_id: "email-db-1", tier: "MEETING" });
    expect(forbidden.sendPushNotification).not.toHaveBeenCalled();
    expect(db.writes.notification).toBeUndefined();
  });

  it("writes no Gmail label and opens no mail client, even with label mode on", async () => {
    vi.stubEnv("GMAIL_LABEL_MODE_ENABLED", "true");
    await run({ email_id: "email-db-1", tier: "PUSH" });
    expect(forbidden.applyLaneLabel).not.toHaveBeenCalled();
    expect(forbidden.mailActionsFor).not.toHaveBeenCalled();
  });

  it("writes only to the attention item table", async () => {
    await run({ email_id: "email-db-1", tier: "PUSH" });
    expect(Object.keys(db.writes)).toEqual(["attentionItem"]);
  });
});

describe("failure", () => {
  it("answers a generic UNAVAILABLE error and never leaks the database message", async () => {
    dbHolder.current = {
      model: () => ({
        findFirst: async () => {
          throw new Error("connection string postgres://user:secret@host/db refused");
        },
      }),
    };
    const out = await run({ email_id: "email-db-1", tier: "PUSH" });
    expect(out.code).toBe("UNAVAILABLE");
    expect(JSON.stringify(out)).not.toMatch(/postgres|secret|refused/);
    expect(forbidden.captureError).toHaveBeenCalledTimes(1);
  });
});
