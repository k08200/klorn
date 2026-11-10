/**
 * withStatementTimeout — the lane reads' guard: the work runs in one
 * transaction whose first statement is `SET LOCAL statement_timeout`, so a
 * slow scan is cancelled by Postgres instead of holding a pooled connection,
 * and a cancellation surfaces as QueryTimeoutError (the routes answer 503).
 */

import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeRaw = vi.hoisted(() => vi.fn(async (_sql: unknown) => 0));
const transaction = vi.hoisted(() =>
  vi.fn(async (fn: (tx: unknown) => Promise<unknown>, _options?: unknown) =>
    fn({ $executeRaw: executeRaw }),
  ),
);

vi.mock("../db.js", () => {
  const prisma = { $transaction: transaction };
  return { prisma, db: prisma };
});

import {
  isStatementTimeout,
  LANE_QUERY_TIMEOUT_MS,
  QueryTimeoutError,
  withStatementTimeout,
} from "../db-statement-timeout.js";

function sqlText(sql: unknown): string {
  const { strings, values } = sql as { strings: string[]; values: unknown[] };
  return strings.join("?").replace(/\s+/g, " ").trim() + (values.length ? ` ${values}` : "");
}

beforeEach(() => {
  executeRaw.mockClear();
  transaction.mockClear();
});

describe("withStatementTimeout", () => {
  it("sets a transaction-local statement_timeout before the work and returns its result", async () => {
    const order: string[] = [];
    executeRaw.mockImplementationOnce(async (sql: unknown) => {
      order.push(sqlText(sql));
      return 0;
    });
    const result = await withStatementTimeout(async (tx) => {
      order.push("work");
      expect(tx).toBeDefined();
      return 42;
    });
    expect(result).toBe(42);
    expect(order).toEqual([`SET LOCAL statement_timeout = ${LANE_QUERY_TIMEOUT_MS}`, "work"]);
    expect(LANE_QUERY_TIMEOUT_MS).toBe(3000);
    // The transaction itself outlives the statement timeout, so Postgres cancels first.
    const options = transaction.mock.calls[0]?.[1] as { timeout: number };
    expect(options.timeout).toBeGreaterThan(LANE_QUERY_TIMEOUT_MS);
  });

  it("maps a Postgres statement cancellation (57014) to QueryTimeoutError", async () => {
    const cancelled = new Prisma.PrismaClientKnownRequestError(
      "Raw query failed. Code: `57014`. Message: `canceling statement due to statement timeout`",
      { code: "P2010", clientVersion: "test", meta: { code: "57014" } },
    );
    await expect(
      withStatementTimeout(async () => {
        throw cancelled;
      }),
    ).rejects.toBeInstanceOf(QueryTimeoutError);
  });

  it("maps an expired interactive transaction (P2028) to QueryTimeoutError", async () => {
    const expired = new Prisma.PrismaClientKnownRequestError("Transaction already closed", {
      code: "P2028",
      clientVersion: "test",
    });
    transaction.mockRejectedValueOnce(expired);
    await expect(withStatementTimeout(async () => 1)).rejects.toBeInstanceOf(QueryTimeoutError);
  });

  it("rethrows any other failure unchanged", async () => {
    const boom = new Error("connection refused");
    await expect(
      withStatementTimeout(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("refuses a timeout that is not a positive integer (it is interpolated into SET)", async () => {
    await expect(withStatementTimeout(async () => 1, 0)).rejects.toThrow(RangeError);
    await expect(withStatementTimeout(async () => 1, 1.5)).rejects.toThrow(RangeError);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("isStatementTimeout", () => {
  it("recognises the message when the driver gives no code", () => {
    expect(isStatementTimeout(new Error("canceling statement due to statement timeout"))).toBe(
      true,
    );
    expect(isStatementTimeout(new Error("unique constraint failed"))).toBe(false);
    expect(isStatementTimeout("nope")).toBe(false);
  });
});
