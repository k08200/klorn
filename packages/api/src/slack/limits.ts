/**
 * In-process fixed-window counters for the public Slack webhook
 * (docs/providers/slack.md §12). The route turns off the global per-address
 * limiter (Slack delivers every workspace's events from shared addresses) and
 * uses two of these instead:
 *
 * - per client address, counting only FAILED requests (unknown hook, bad or
 *   missing signature), checked before any database lookup — a prober is cut
 *   off, Slack's shared addresses are not;
 * - per hook, counting only requests whose signature verified — someone who
 *   learned a hook id cannot burn its budget without the signing secret.
 *
 * Bounded memory: past MAX_KEYS live keys the expired ones are dropped, and if
 * that is not enough the map is cleared (fail open, never grow without bound).
 */

export const MAX_KEYS = 10_000;

interface Window {
  start: number;
  count: number;
}

export class WindowCounter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private current(key: string, now: number): Window | null {
    const window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) return null;
    return window;
  }

  /** True when this key already used its budget in the current window. */
  exceeded(key: string, now: number): boolean {
    const window = this.current(key, now);
    return window !== null && window.count >= this.max;
  }

  /** Counts one hit; true when it is still within the budget. */
  hit(key: string, now: number): boolean {
    const window = this.current(key, now);
    if (window) {
      const count = window.count + 1;
      this.windows.set(key, { start: window.start, count });
      return count <= this.max;
    }
    if (this.windows.size >= MAX_KEYS) this.prune(now);
    this.windows.set(key, { start: now, count: 1 });
    return this.max >= 1;
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
    if (this.windows.size >= MAX_KEYS) this.windows.clear();
  }

  /** Test seam. */
  reset(): void {
    this.windows.clear();
  }
}
