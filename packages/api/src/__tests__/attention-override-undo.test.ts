/**
 * Reversible lane override (productization plan P4, KEYBOARD_TRIAGE).
 *
 * Undoing a manual override must put back the lane AND leave the learning
 * state as if the override never happened: the DecisionLabel stamp this
 * override wrote, and the sender prior (which is derived from
 * AttentionItem.isManualOverride + updatedAt, so restoring those IS the
 * demotion). Runs against an in-memory fake that honours `where` guards and
 * rolls a batch transaction back when one operation rejects, like Prisma.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  items: [] as Record<string, unknown>[],
  labels: [] as Record<string, unknown>[],
}));

vi.mock("../db.js", () => {
  const same = (a: unknown, b: unknown): boolean =>
    a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([k, v]) => same(row[k], v));
  // Lazy like a PrismaPromise: nothing runs until awaited, so a batch
  // $transaction can execute the operations in order and roll back.
  const lazy = <T>(run: () => T) => ({
    // biome-ignore lint/suspicious/noThenProperty: the fake mirrors PrismaPromise, which is a lazy thenable
    then: (ok: (v: T) => unknown, fail?: (e: unknown) => unknown) =>
      new Promise<T>((resolve) => resolve(run())).then(ok, fail),
  });
  // Prisma.DbNull is how a Json column is set to SQL NULL; store it as null.
  const isDbNull = (v: unknown) =>
    typeof v === "object" && v !== null && v.constructor?.name === "DbNull";
  const pick = (row: Row, select?: Row): Row =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row };

  let txQueue: Promise<unknown> = Promise.resolve();
  const prisma = {
    attentionItem: {
      findFirst: vi.fn((args: { where: Row; select?: Row }) =>
        lazy(() => {
          const row = state.items.find((r) => matches(r, args.where));
          return row ? pick(row, args.select) : null;
        }),
      ),
      update: vi.fn((args: { where: Row; data: Row }) =>
        lazy(() => {
          const idx = state.items.findIndex((r) => matches(r, args.where));
          if (idx < 0) {
            throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
          }
          // @updatedAt: bumped unless the write supplies a value itself.
          const data = Object.fromEntries(
            Object.entries(args.data).map(([k, v]) => [k, isDbNull(v) ? null : v]),
          );
          const next = { ...state.items[idx], updatedAt: new Date(), ...data };
          state.items = state.items.map((r, i) => (i === idx ? next : r));
          return next;
        }),
      ),
    },
    decisionLabel: {
      updateMany: vi.fn((args: { where: Row; data: Row }) =>
        lazy(() => {
          let count = 0;
          state.labels = state.labels.map((r) => {
            if (!matches(r, args.where)) return r;
            count += 1;
            return { ...r, ...args.data };
          });
          return { count };
        }),
      ),
    },
    $executeRaw: vi.fn(async () => 0),
    // One transaction at a time, as row locks give on a real database: a
    // rollback must never restore a state another transaction wrote over.
    $transaction: vi.fn((ops: PromiseLike<unknown>[]) => {
      const run = async () => {
        const before = { items: state.items, labels: state.labels };
        try {
          const results: unknown[] = [];
          for (const op of ops) results.push(await op);
          return results;
        } catch (err) {
          state.items = before.items;
          state.labels = before.labels;
          throw err;
        }
      };
      const result = txQueue.then(run, run);
      txQueue = result.catch(() => undefined);
      return result;
    }),
  };
  return { prisma, db: prisma };
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import {
  OVERRIDE_UNDO_RETENTION_MS,
  OVERRIDE_UNDO_WINDOW_MS,
  overrideAttentionTier,
  sweepOverrideUndoSnapshots,
  undoAttentionOverride,
} from "../judge/attention-override.js";

const T0 = new Date("2026-10-03T09:00:00.000Z");
const JUDGED_AT = new Date("2026-10-01T08:00:00.000Z");

function seed(item: Row = {}, label: Row | null = {}) {
  state.items = [
    {
      id: "item-1",
      userId: "user-1",
      source: "EMAIL",
      sourceId: "email-1",
      tier: "PUSH",
      tierReason: "Judge: deadline today",
      isManualOverride: false,
      agentTierSetAt: null,
      agentTierKeyId: null,
      overrideUndoToken: null,
      overrideUndo: null,
      updatedAt: JUDGED_AT,
      ...item,
    },
  ];
  state.labels =
    label === null
      ? []
      : [
          {
            userId: "user-1",
            source: "EMAIL",
            sourceId: "email-1",
            shownTier: "PUSH",
            outcome: null,
            outcomeAt: null,
            ...label,
          },
        ];
}

const item = () => state.items[0];
const label = () => state.labels[0];

/** The learning-relevant projection of a row: what sender priors and corrections read. */
const learning = (row: Row) => ({
  tier: row.tier,
  tierReason: row.tierReason,
  isManualOverride: row.isManualOverride,
  agentTierSetAt: row.agentTierSetAt,
  agentTierKeyId: row.agentTierKeyId,
  updatedAt: row.updatedAt,
});

async function override(tier: "PUSH" | "MEETING" | "QUEUE" | "INFO" | "SILENT") {
  const result = await overrideAttentionTier("user-1", "item-1", tier, { reversible: true });
  if (!result.ok || !result.undo) throw new Error("expected a reversible override");
  return result.undo;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.stubEnv("KEYBOARD_TRIAGE", "true");
  seed();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("overrideAttentionTier with KEYBOARD_TRIAGE off", () => {
  it("writes no undo snapshot and returns no undo handle", async () => {
    vi.stubEnv("KEYBOARD_TRIAGE", "");
    const result = await overrideAttentionTier("user-1", "item-1", "QUEUE", { reversible: true });
    expect(result).toEqual({ ok: true, tier: "QUEUE" });
    expect(item().overrideUndoToken).toBeNull();
    expect(item().overrideUndo).toBeNull();
  });

  it("refuses an undo as a conflict (nothing was recorded)", async () => {
    vi.stubEnv("KEYBOARD_TRIAGE", "");
    await overrideAttentionTier("user-1", "item-1", "QUEUE", { reversible: true });
    expect(await undoAttentionOverride("user-1", "item-1", "any")).toEqual({
      ok: false,
      reason: "conflict",
    });
  });
});

describe("undoAttentionOverride", () => {
  it("restores the lane, the reason, the manual flag and updatedAt", async () => {
    const before = learning(item());
    const undo = await override("QUEUE");
    expect(item().tier).toBe("QUEUE");
    expect(item().isManualOverride).toBe(true);
    expect(new Date(undo.expiresAt).getTime()).toBe(T0.getTime() + OVERRIDE_UNDO_WINDOW_MS);

    vi.setSystemTime(T0.getTime() + 5_000);
    const result = await undoAttentionOverride("user-1", "item-1", undo.token);

    expect(result).toEqual({ ok: true, tier: "PUSH", alreadyUndone: false });
    expect(learning(item())).toEqual(before);
    expect(item().overrideUndoToken).toBeNull();
  });

  it("removes the ledger stamp this override wrote, reopening first-stamp-wins", async () => {
    const undo = await override("QUEUE");
    expect(label().outcome).toBe("OVERRIDE:QUEUE");

    await undoAttentionOverride("user-1", "item-1", undo.token);
    expect(label().outcome).toBeNull();
    expect(label().outcomeAt).toBeNull();

    // The row is unstamped again, so the user's next real move is the one recorded.
    await override("SILENT");
    expect(label().outcome).toBe("OVERRIDE:SILENT");
  });

  it("leaves a ledger stamp it did not write (an earlier CONFIRM wins)", async () => {
    const confirmedAt = new Date("2026-10-02T00:00:00.000Z");
    seed({}, { outcome: "CONFIRM:PUSH", outcomeAt: confirmedAt });
    const undo = await override("QUEUE");
    expect(label().outcome).toBe("CONFIRM:PUSH");

    await undoAttentionOverride("user-1", "item-1", undo.token);
    expect(label()).toMatchObject({ outcome: "CONFIRM:PUSH", outcomeAt: confirmedAt });
  });

  it("demotes the sender prior: the row stops counting as a manual override", async () => {
    // The override prior is "≥2 identical isManualOverride rows for this
    // sender" (judge-context.buildPrior). This row was the second one.
    const undo = await override("QUEUE");
    expect(item().isManualOverride).toBe(true);
    await undoAttentionOverride("user-1", "item-1", undo.token);
    expect(item().isManualOverride).toBe(false);
    // updatedAt is put back too, so the history prior's freshness window is not extended.
    expect(item().updatedAt).toEqual(JUDGED_AT);
  });

  it("undoing the second of two overrides returns to the first, still manual", async () => {
    await override("QUEUE");
    const afterFirst = learning(item());
    vi.setSystemTime(T0.getTime() + 2_000);
    const second = await override("SILENT");

    const result = await undoAttentionOverride("user-1", "item-1", second.token);
    expect(result).toEqual({ ok: true, tier: "QUEUE", alreadyUndone: false });
    expect(learning(item())).toEqual(afterFirst);
    // The first override's stamp is the ground truth and stays.
    expect(label().outcome).toBe("OVERRIDE:QUEUE");
  });

  it("only the most recent override is reversible", async () => {
    const first = await override("QUEUE");
    await override("SILENT");
    expect(await undoAttentionOverride("user-1", "item-1", first.token)).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(item().tier).toBe("SILENT");
    expect(label().outcome).toBe("OVERRIDE:QUEUE");
  });

  it("override → undo → override: the stale token cannot undo the new override", async () => {
    const first = await override("QUEUE");
    await undoAttentionOverride("user-1", "item-1", first.token);
    const second = await override("QUEUE");

    expect(await undoAttentionOverride("user-1", "item-1", first.token)).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(item().tier).toBe("QUEUE");
    expect(item().isManualOverride).toBe(true);
    expect(label().outcome).toBe("OVERRIDE:QUEUE");

    expect(await undoAttentionOverride("user-1", "item-1", second.token)).toMatchObject({
      ok: true,
      tier: "PUSH",
    });
    expect(label().outcome).toBeNull();
  });

  it("is idempotent: a second undo with the same token reports success and changes nothing", async () => {
    const undo = await override("QUEUE");
    await undoAttentionOverride("user-1", "item-1", undo.token);
    const snapshot = { ...item() };

    const again = await undoAttentionOverride("user-1", "item-1", undo.token);
    expect(again).toEqual({ ok: true, tier: "PUSH", alreadyUndone: true });
    expect(item()).toEqual(snapshot);
  });

  it("refuses after the server-side window", async () => {
    const undo = await override("QUEUE");
    vi.setSystemTime(T0.getTime() + OVERRIDE_UNDO_WINDOW_MS + 1);
    expect(await undoAttentionOverride("user-1", "item-1", undo.token)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(item().tier).toBe("QUEUE");
    expect(label().outcome).toBe("OVERRIDE:QUEUE");
  });

  it("does not accept another user's item", async () => {
    const undo = await override("QUEUE");
    expect(await undoAttentionOverride("user-2", "item-1", undo.token)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(item().tier).toBe("QUEUE");
    expect(label().outcome).toBe("OVERRIDE:QUEUE");
  });

  it("refuses when the judge re-decided the row since the override", async () => {
    const undo = await override("QUEUE");
    // attention-mirror rewrites the row: judge tier, isManualOverride false.
    state.items = [
      { ...item(), tier: "INFO", tierReason: "Judge: receipt", isManualOverride: false },
    ];

    expect(await undoAttentionOverride("user-1", "item-1", undo.token)).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(item().tier).toBe("INFO");
    // No half-undo: the ledger stamp is untouched when the row is not restored.
    expect(label().outcome).toBe("OVERRIDE:QUEUE");
  });

  it("rolls back the ledger when the row changes between the check and the write", async () => {
    const undo = await override("QUEUE");
    const findFirst = (
      prisma as unknown as { attentionItem: { findFirst: ReturnType<typeof vi.fn> } }
    ).attentionItem.findFirst;
    const real = findFirst.getMockImplementation() as (args: unknown) => PromiseLike<Row | null>;
    // The pre-check sees the override; the judge lands right after it.
    findFirst.mockImplementationOnce((args: unknown) => ({
      // biome-ignore lint/suspicious/noThenProperty: lazy thenable, as above
      then: (ok: (v: Row | null) => unknown) =>
        Promise.resolve(real(args)).then((row) => {
          state.items = [{ ...item(), tier: "INFO", isManualOverride: false }];
          return ok(row);
        }),
    }));

    expect(await undoAttentionOverride("user-1", "item-1", undo.token)).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(item().tier).toBe("INFO");
    expect(label().outcome).toBe("OVERRIDE:QUEUE");
  });

  it("never resurrects a retired lane: a legacy AUTO / CALL row comes back folded", async () => {
    seed({ tier: "AUTO" });
    const auto = await override("PUSH");
    expect(await undoAttentionOverride("user-1", "item-1", auto.token)).toMatchObject({
      ok: true,
      tier: "QUEUE",
    });
    expect(item().tier).toBe("QUEUE");

    seed({ tier: "CALL" });
    const call = await override("QUEUE");
    await undoAttentionOverride("user-1", "item-1", call.token);
    expect(item().tier).toBe("PUSH");
  });

  it("restores a not-yet-judged row to no lane", async () => {
    seed({ tier: null, tierReason: null });
    const undo = await override("QUEUE");
    expect(await undoAttentionOverride("user-1", "item-1", undo.token)).toEqual({
      ok: true,
      tier: null,
      alreadyUndone: false,
    });
    expect(item().tier).toBeNull();
  });

  it("puts an agent's stamp back so its lane stays out of learning (agentTierSetAt)", async () => {
    const agentAt = new Date("2026-10-02T12:00:00.000Z");
    seed({
      tier: "INFO",
      tierReason: "Agent change — moved to INFO by a connected agent",
      agentTierSetAt: agentAt,
      agentTierKeyId: "key-9",
    });
    const undo = await override("PUSH");
    expect(item().agentTierSetAt).toBeNull();

    await undoAttentionOverride("user-1", "item-1", undo.token);
    expect(item()).toMatchObject({
      tier: "INFO",
      isManualOverride: false,
      agentTierSetAt: agentAt,
      agentTierKeyId: "key-9",
    });
  });

  it("works on a linked-inbox item with no ledger row, touching only that row", async () => {
    seed({ id: "item-1", sourceId: "email-linked" }, null);
    state.items = [
      ...state.items,
      { ...item(), id: "item-primary", sourceId: "email-primary", tier: "QUEUE" },
    ];
    const undo = await override("SILENT");
    expect(await undoAttentionOverride("user-1", "item-1", undo.token)).toMatchObject({
      ok: true,
      tier: "PUSH",
    });
    expect(state.items[1]).toMatchObject({ id: "item-primary", tier: "QUEUE" });
  });

  it("treats a garbage snapshot as a conflict instead of throwing", async () => {
    seed({ overrideUndoToken: "tok", overrideUndo: { token: "tok", at: "not-a-date" } });
    expect(await undoAttentionOverride("user-1", "item-1", "tok")).toEqual({
      ok: false,
      reason: "conflict",
    });
  });
});

describe("reversible is opt-in (flag on)", () => {
  it("a caller that does not ask (Telegram, Gmail label correction) records no snapshot or token", async () => {
    const result = await overrideAttentionTier("user-1", "item-1", "QUEUE");
    expect(result).toEqual({ ok: true, tier: "QUEUE" });
    expect(item().overrideUndoToken).toBeNull();
    expect(item().overrideUndo).toBeNull();
    expect(label().outcome).toBe("OVERRIDE:QUEUE");
  });

  it("and it retires the token of an earlier reversible override on that row", async () => {
    const first = await override("QUEUE");
    // Same lane again, from Telegram: the row would still look like `first`'s.
    await overrideAttentionTier("user-1", "item-1", "QUEUE");
    expect(item().overrideUndoToken).toBeNull();
    expect(item().overrideUndo).toBeNull();
    expect(await undoAttentionOverride("user-1", "item-1", first.token)).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(item()).toMatchObject({ tier: "QUEUE", isManualOverride: true });
  });
});

describe("two quick overrides on one row", () => {
  it("A → B → undo B: back to A's state, A's stamp intact, A no longer undoable", async () => {
    const a = await override("QUEUE");
    const afterA = learning(item());
    vi.setSystemTime(T0.getTime() + 50);
    const b = await override("SILENT");

    expect(await undoAttentionOverride("user-1", "item-1", b.token)).toEqual({
      ok: true,
      tier: "QUEUE",
      alreadyUndone: false,
    });
    expect(learning(item())).toEqual(afterA);
    expect(label()).toMatchObject({ outcome: "OVERRIDE:QUEUE", outcomeAt: T0 });
    expect(item().overrideUndoToken).toBeNull();
    expect(await undoAttentionOverride("user-1", "item-1", a.token)).toEqual({
      ok: false,
      reason: "conflict",
    });
  });

  it("concurrent A and B never both snapshot the original row", async () => {
    const [a, b] = await Promise.all([
      overrideAttentionTier("user-1", "item-1", "QUEUE", { reversible: true }),
      overrideAttentionTier("user-1", "item-1", "SILENT", { reversible: true }),
    ]);
    if (!a.ok || !b.ok || !a.undo || !b.undo) throw new Error("expected two reversible overrides");

    // One landed first; the other re-read and landed on top of it.
    const last = item().overrideUndoToken === a.undo.token ? a : b;
    const first = last === a ? b : a;
    expect(item().tier).toBe(last.tier);
    expect(label().outcome).toBe(`OVERRIDE:${first.tier}`);

    // Undoing the last one returns to the FIRST override, not to the judge's
    // row: still manual, still carrying the stamp that is on the ledger.
    expect(await undoAttentionOverride("user-1", "item-1", last.undo?.token ?? "")).toMatchObject({
      ok: true,
      tier: first.tier,
    });
    expect(item()).toMatchObject({ tier: first.tier, isManualOverride: true });
    expect(label().outcome).toBe(`OVERRIDE:${first.tier}`);
  });

  it("gives up with a conflict when the row keeps changing underneath it", async () => {
    const update = (prisma as unknown as { attentionItem: { update: ReturnType<typeof vi.fn> } })
      .attentionItem.update;
    update.mockImplementation(() => ({
      // biome-ignore lint/suspicious/noThenProperty: lazy thenable, as above
      then: (_ok: unknown, fail: (e: unknown) => unknown) =>
        Promise.reject(Object.assign(new Error("not found"), { code: "P2025" })).catch(fail),
    }));
    try {
      expect(
        await overrideAttentionTier("user-1", "item-1", "QUEUE", { reversible: true }),
      ).toEqual({ ok: false, reason: "conflict" });
      expect(label().outcome).toBeNull();
    } finally {
      update.mockReset();
    }
  });
});

describe("snapshot retention", () => {
  it("sweeps snapshots older than the retention with one parameterized statement", async () => {
    const executeRaw = (prisma as unknown as { $executeRaw: ReturnType<typeof vi.fn> }).$executeRaw;
    executeRaw.mockResolvedValueOnce(3);
    const now = new Date("2026-10-05T00:00:00.000Z");
    expect(await sweepOverrideUndoSnapshots(now)).toBe(3);
    const [strings, cutoff] = executeRaw.mock.calls[0] as [TemplateStringsArray, Date];
    expect(strings.join("?")).toMatch(/UPDATE "AttentionItem"[\s\S]*"overrideUndo" IS NOT NULL/);
    expect(cutoff).toEqual(new Date(now.getTime() - OVERRIDE_UNDO_RETENTION_MS));
  });
});
