/**
 * A deadline for the one request a Klorn drive sheet sends (create, rename,
 * move, delete). The sheet cannot be dismissed while its request runs, and
 * apiFetch has no timeout of its own, so a stalled request would hold the
 * sheet for good. At the deadline the request is aborted and fails with
 * DriveTimeoutError: the sheet is free again and says so. The server may
 * still have done it, so the caller reads the list again. Uploads have no
 * deadline: a 25 MiB file can rightly take a while.
 */

/** Create a folder, rename, move: metadata only. */
export const EDIT_TIMEOUT_MS = 30_000;
/** A folder delete removes up to 1,000 objects in batches of 8 (D3). */
export const DELETE_TIMEOUT_MS = 60_000;

export class DriveTimeoutError extends Error {
  constructor() {
    super("drive request timed out");
    this.name = "DriveTimeoutError";
  }
}

/** Runs `request` with a signal that aborts at `ms`; past it, DriveTimeoutError. */
export async function withTimeout<T>(
  ms: number,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  try {
    return await request(controller.signal);
  } catch (err) {
    // The abort surfaces as the fetch's own AbortError: say what it was.
    if (timedOut) throw new DriveTimeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
