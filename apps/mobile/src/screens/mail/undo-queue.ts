/**
 * Deferred commits with a client-side undo window.
 *
 * "Done" (swipe right) has no server un-dismiss, so the undo lives here: the
 * row is hidden at once, the request waits UNDO_WINDOW_MS, and undo inside the
 * window simply never sends it. Leaving the app (visibility hidden / pagehide)
 * flushes everything still waiting, so a quick swipe-then-close still lands.
 *
 * A lane move is the opposite case — the server move happens at once and the
 * server's own undo token reverses it — and uses `kind: "applied"` entries,
 * whose undo runs the reversal instead of cancelling a send.
 *
 * Pure apart from the injected clock: unit-tested with fake timers.
 */

export const UNDO_WINDOW_MS = 5_000;

export interface UndoEntry {
  id: string;
  /** What the snackbar says ("처리 완료" / "SILENT로 옮겼어요"). */
  message: string;
  /**
   * deferred: `commit` runs when the window closes (or on flush); undo cancels it.
   * applied:  already done on the server; undo runs `revert` (e.g. the lane undo route).
   */
  kind: "deferred" | "applied";
  commit?: () => Promise<unknown>;
  /** Puts the UI back (deferred) or reverses the server change (applied). */
  revert: () => Promise<unknown> | void;
  /** Called when a deferred commit fails, after the UI was put back. */
  onCommitError?: (err: unknown) => void;
}

export interface UndoSnapshot {
  /** The entry the snackbar shows (the newest one still open). */
  current: { id: string; message: string; count: number } | null;
}

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Open {
  entry: UndoEntry;
  timer: unknown;
}

export class UndoQueue {
  private open: Open[] = [];
  private listeners = new Set<() => void>();
  private snapshot: UndoSnapshot = { current: null };

  constructor(
    private readonly windowMs: number = UNDO_WINDOW_MS,
    private readonly timers: Timers = realTimers,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): UndoSnapshot => this.snapshot;

  private emit(): void {
    const last = this.open[this.open.length - 1];
    this.snapshot = {
      current: last
        ? { id: last.entry.id, message: last.entry.message, count: this.open.length }
        : null,
    };
    for (const listener of this.listeners) listener();
  }

  /** Open an undo window. A new entry with the same id replaces (and first settles) the old one. */
  push(entry: UndoEntry): void {
    const existing = this.open.find((o) => o.entry.id === entry.id);
    if (existing) this.settle(existing);
    const timer = this.timers.setTimeout(() => {
      const open = this.open.find((o) => o.entry === entry);
      if (open) this.settle(open);
    }, this.windowMs);
    this.open.push({ entry, timer });
    this.emit();
  }

  /** Close the window: run a deferred commit; an applied entry just stays done. */
  private settle(open: Open): void {
    this.timers.clearTimeout(open.timer);
    this.open = this.open.filter((o) => o !== open);
    const { entry } = open;
    if (entry.kind === "deferred" && entry.commit) {
      entry.commit().catch(async (err) => {
        await entry.revert();
        entry.onCommitError?.(err);
      });
    }
    this.emit();
  }

  /** Undo the newest open entry (the snackbar's button), or the one named. */
  async undo(id?: string): Promise<boolean> {
    const open = id ? this.open.find((o) => o.entry.id === id) : this.open[this.open.length - 1];
    if (!open) return false;
    this.timers.clearTimeout(open.timer);
    this.open = this.open.filter((o) => o !== open);
    this.emit();
    await open.entry.revert();
    return true;
  }

  /** Settle every open entry now (app going to the background, sign-out). */
  flush(): void {
    for (const open of [...this.open]) this.settle(open);
  }

  /** Close the snackbar without undoing (its × button); deferred work still commits on time. */
  dismissCurrent(): void {
    const last = this.open[this.open.length - 1];
    if (last) this.settle(last);
  }

  get size(): number {
    return this.open.length;
  }
}
