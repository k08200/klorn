/**
 * A semaphore with a bounded queue and a deadline, for the Klorn mailbox's
 * inbound webhook (step E1b of docs/providers/unified-platform-plan.md). Resend
 * retries, so work that cannot start soon is better refused at once (503) than
 * queued without a bound:
 * - past `maxQueue` waiters a call is `busy`;
 * - a waiter whose deadline passed while it queued is `expired` and never runs;
 * - work still running at its deadline is `expired` too, and its slot is freed
 *   then: a hung database call (this path has no statement timeout) cannot hold
 *   a slot forever. That work may still finish in the background; a failure it
 *   reports after the deadline goes to `onLateError`.
 * A finished call hands its slot straight to the next waiter.
 */

export type SlotResult<T> = { ran: true; value: T } | { ran: false; reason: "busy" | "expired" };

const TIMED_OUT = Symbol("timed-out");

async function untilDeadline<T>(
  work: Promise<T>,
  remainingMs: number,
): Promise<T | typeof TIMED_OUT> {
  if (!Number.isFinite(remainingMs)) return work;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, remainingMs));
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export class BoundedSlots {
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxQueue: number,
  ) {}

  async run<T>(
    fn: () => Promise<T>,
    expired: () => boolean,
    remainingMs: () => number = () => Number.POSITIVE_INFINITY,
    onLateError: (err: unknown) => void = () => {},
  ): Promise<SlotResult<T>> {
    if (this.running < this.concurrency) {
      this.running += 1;
    } else {
      if (this.waiters.length >= this.maxQueue) return { ran: false, reason: "busy" };
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      if (expired()) return { ran: false, reason: "expired" };
      let timedOut = false;
      const work = fn();
      work.catch((err: unknown) => {
        if (timedOut) onLateError(err);
      });
      const value = await untilDeadline(work, remainingMs());
      if (value !== TIMED_OUT) return { ran: true, value };
      timedOut = true;
      return { ran: false, reason: "expired" };
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}
