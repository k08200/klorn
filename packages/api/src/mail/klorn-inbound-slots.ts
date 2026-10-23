/**
 * A semaphore with a bounded queue, for the Klorn mailbox's inbound webhook
 * (step E1b of docs/providers/unified-platform-plan.md). Resend retries, so work
 * that cannot start soon is better refused at once (503) than queued without a
 * bound: past `maxQueue` waiters a call is `busy`, and a waiter whose deadline
 * passed while it queued is `expired` and never runs. A finished call hands its
 * slot straight to the next waiter.
 */

export type SlotResult<T> = { ran: true; value: T } | { ran: false; reason: "busy" | "expired" };

export class BoundedSlots {
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxQueue: number,
  ) {}

  async run<T>(fn: () => Promise<T>, expired: () => boolean): Promise<SlotResult<T>> {
    if (this.running < this.concurrency) {
      this.running += 1;
    } else {
      if (this.waiters.length >= this.maxQueue) return { ran: false, reason: "busy" };
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      if (expired()) return { ran: false, reason: "expired" };
      return { ran: true, value: await fn() };
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}
