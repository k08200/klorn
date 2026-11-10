/**
 * A ceiling on how long a read may hold a database connection.
 *
 * The lane reads (the thread-grouped page and the lane counts) scan a user's
 * whole mailbox. On a large mailbox, or a busy instance, one of them must not
 * hold a pooled connection for tens of seconds. `withStatementTimeout` runs
 * the work in one interactive transaction whose first statement is
 * `SET LOCAL statement_timeout`, so Postgres itself cancels a statement past
 * the limit and the setting ends with the transaction (it never leaks to the
 * next user of a pooled connection, including through a transaction-mode
 * pooler). A cancellation — or the transaction expiring — surfaces as
 * QueryTimeoutError, which the routes answer as a retryable 503.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";

/** The lane reads' statement ceiling. */
export const LANE_QUERY_TIMEOUT_MS = 3000;

/** Postgres SQLSTATE for a statement cancelled by statement_timeout. */
const PG_QUERY_CANCELED = "57014";
/** Prisma: raw query failed (the SQLSTATE is in meta.code). */
const PRISMA_RAW_QUERY_FAILED = "P2010";
/** Prisma: interactive transaction error (expired, closed, or no connection in time). */
const PRISMA_TRANSACTION_API_ERROR = "P2028";
/** Head-room past the statement ceiling, so Postgres cancels before Prisma expires the transaction. */
const TRANSACTION_HEADROOM_MS = 2000;
/** Queue for a pooled connection like a plain query does (see INTERACTIVE_TX_OPTIONS in db.ts). */
const TRANSACTION_MAX_WAIT_MS = 10_000;

export class QueryTimeoutError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Query exceeded its statement timeout", options);
    this.name = "QueryTimeoutError";
  }
}

export function isStatementTimeout(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === PRISMA_TRANSACTION_API_ERROR) return true;
    const sqlState = (err.meta as { code?: unknown } | undefined)?.code;
    if (err.code === PRISMA_RAW_QUERY_FAILED && sqlState === PG_QUERY_CANCELED) return true;
  }
  if (err instanceof Error) {
    return /canceling statement due to statement timeout/i.test(err.message);
  }
  return false;
}

export async function withStatementTimeout<T>(
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  timeoutMs: number = LANE_QUERY_TIMEOUT_MS,
): Promise<T> {
  // The value is spliced into SET (which takes no bind parameters), so it
  // must be a plain positive integer — never caller-controlled text.
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`statement timeout must be a positive integer, got ${timeoutMs}`);
  }
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SET LOCAL statement_timeout = ${Prisma.raw(String(timeoutMs))}`,
        );
        return run(tx);
      },
      { maxWait: TRANSACTION_MAX_WAIT_MS, timeout: timeoutMs + TRANSACTION_HEADROOM_MS },
    );
  } catch (err) {
    if (isStatementTimeout(err)) throw new QueryTimeoutError({ cause: err });
    throw err;
  }
}
