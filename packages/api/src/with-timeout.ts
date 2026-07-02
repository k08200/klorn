/**
 * with-timeout — bound a promise by wall-clock time.
 *
 * `withTimeout(work, ms, label)` races `work` against a timer that rejects with
 * a {@link TimeoutError} after `ms`. Whichever settles first wins; the timer is
 * always cleared in `finally` so a fast-resolving (or fast-rejecting) `work`
 * never leaves a dangling timeout handle alive.
 *
 * IMPORTANT — this does NOT cancel the underlying work. `Promise.race` only
 * stops *waiting*; a hung network call (e.g. a stalled googleapis request with
 * no AbortController) keeps running until it fails at the OS/TCP layer and its
 * result/rejection is then discarded. The value here is UNBLOCKING the caller
 * (e.g. the scheduler loop) so one hung account can't stall the whole tick.
 * Threading a real AbortController down into googleapis is a separate follow-up.
 */

/** Distinct error type so callers can tell a timeout from a work failure. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`Timed out after ${ms}ms: ${label}`));
    }, ms);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    // Clear on every exit path (work won, work threw, or timeout fired) so a
    // fast-settling `work` never leaves the timer pending.
    if (timer !== undefined) clearTimeout(timer);
  }
}
