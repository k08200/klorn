/**
 * What a data-wipe fence rejection looks like (data-wipe-fence.ts): the app
 * check's error class and the predicate that also recognizes the database
 * trigger's.
 *
 * A leaf on purpose: it imports nothing. The failure reporters (sentry.ts,
 * report-failure.ts) skip a fence rejection, and the fence itself reports
 * through them; with the predicate in data-wipe-fence.ts that was an import
 * cycle under every catch in the API (failure-reporting-import-cycle.test.ts).
 */

/** In the trigger's exception text, so a rejected insert is recognizable. */
export const DATA_WIPE_FENCE_MARKER = "klorn_data_wipe_fence";

/** The trigger's SQLSTATE (migration 20261019010000_data_wipe_fence). */
export const DATA_WIPE_FENCE_SQLSTATE = "KW001";

export class DataWipeFenceError extends Error {
  readonly statusCode = 409;
  readonly code = "DATA_WIPE_IN_PROGRESS";

  constructor() {
    super("This account's data was wiped after this work began, so nothing was written.");
    this.name = "DataWipeFenceError";
  }
}

const PRISMA_REQUEST_ERRORS = new Set([
  "PrismaClientKnownRequestError",
  "PrismaClientUnknownRequestError",
]);

/**
 * True for the app check's error and for the trigger's. Prisma reports the
 * trigger as a known request error with `meta.code` KW001 for raw SQL, and as
 * an unknown request error whose message carries the code for a model query.
 * Only those classes count: a validation error echoes the caller's input, which
 * could contain the marker.
 */
export function isDataWipeFenceError(err: unknown): boolean {
  if (err instanceof DataWipeFenceError) return true;
  if (!(err instanceof Error) || !PRISMA_REQUEST_ERRORS.has(err.constructor.name)) return false;
  const meta = (err as { meta?: { code?: unknown } }).meta;
  if (meta?.code === DATA_WIPE_FENCE_SQLSTATE) return true;
  return (
    err.message.includes(DATA_WIPE_FENCE_MARKER) && err.message.includes(DATA_WIPE_FENCE_SQLSTATE)
  );
}
