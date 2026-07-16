import { beforeEach, describe, expect, it, vi } from "vitest";

interface RawCall {
  strings: string[];
  values: unknown[];
}

const { rawCalls, fakeTx, prismaMock } = vi.hoisted(() => {
  const calls: RawCall[] = [];
  // A fake interactive-transaction client: records $executeRaw tagged-template
  // calls so we can assert the exact set_config issued, and lets us prove the
  // same tx handle is passed through to the callback.
  const tx = {
    $executeRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ strings: [...strings], values });
      return Promise.resolve(1);
    }),
    __brand: "tx" as const,
  };
  return {
    rawCalls: calls,
    fakeTx: tx,
    prismaMock: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    },
  };
});

vi.mock("../db.js", () => ({
  prisma: prismaMock,
  INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 },
}));

import { withSystem, withTenant } from "../db-tenant.js";

function lastSetConfig(): RawCall {
  const call = rawCalls.find((c) => c.strings.join("").includes("set_config"));
  if (!call) throw new Error("no set_config call recorded");
  return call;
}

describe("db-tenant", () => {
  beforeEach(() => {
    rawCalls.length = 0;
    prismaMock.$transaction.mockClear();
    fakeTx.$executeRaw.mockClear();
  });

  it("withTenant runs inside one interactive transaction", async () => {
    await withTenant("user-123", async () => "ok");
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("withTenant and withSystem pass pool-sized $transaction options (#845 P2028 class)", async () => {
    await withTenant("user-123", async () => "ok");
    await withSystem(async () => "ok");
    for (const call of prismaMock.$transaction.mock.calls) {
      const opts = call[1] as { maxWait?: number; timeout?: number } | undefined;
      expect(opts?.maxWait).toBeGreaterThanOrEqual(10_000);
      expect(opts?.timeout).toBeGreaterThanOrEqual(15_000);
    }
  });

  it("withTenant sets app.current_user_id to the userId, transaction-local", async () => {
    await withTenant("user-123", async () => undefined);
    const call = lastSetConfig();
    // set_config(name, value, is_local) — is_local=true means SET LOCAL so the
    // GUC is scoped to this transaction, never leaking to a pooled connection.
    // Both name and value are function args, so both travel as bound params.
    const sql = call.strings.join("?");
    expect(sql).toContain("set_config");
    expect(sql).toContain("true"); // is_local literal in the template
    expect(call.values).toEqual(["app.current_user_id", "user-123"]);
  });

  it("withTenant passes the same tx handle to the callback (queries must use it)", async () => {
    let received: unknown;
    await withTenant("u", async (tx) => {
      received = tx;
    });
    expect(received).toBe(fakeTx);
  });

  it("withTenant returns the callback's value", async () => {
    const out = await withTenant("u", async () => ({ n: 42 }));
    expect(out).toEqual({ n: 42 });
  });

  it("withTenant parameterizes the userId (no string interpolation → injection-safe)", async () => {
    const evil = '\'; DROP TABLE "User"; --';
    await withTenant(evil, async () => undefined);
    const call = lastSetConfig();
    // The userId travels as a bound value, never spliced into the SQL text.
    expect(call.values).toContain(evil);
    expect(call.strings.join("")).not.toContain("DROP TABLE");
  });

  it("withSystem sets app.bypass_rls=on transaction-local", async () => {
    await withSystem(async () => undefined);
    const call = lastSetConfig();
    const sql = call.strings.join("?");
    expect(sql).toContain("set_config");
    expect(call.values).toEqual(["app.bypass_rls", "on"]);
  });

  it("withSystem passes the tx handle and returns the callback value", async () => {
    let received: unknown;
    const out = await withSystem(async (tx) => {
      received = tx;
      return "done";
    });
    expect(received).toBe(fakeTx);
    expect(out).toBe("done");
  });
});
