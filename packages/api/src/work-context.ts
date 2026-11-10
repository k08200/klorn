/**
 * When the current unit of work began: an HTTP request, one scheduler tick, or
 * anything those start (timers, promises, queued LLM calls), which inherit it
 * through AsyncLocalStorage.
 *
 * The data-wipe fence (privacy/data-wipe-fence.ts) uses it to reject a write
 * from work that began before a user's data was wiped. Such work can still hold
 * that user's token or mail in memory, and Gmail calls have no timeout and the
 * background LLM queue has no cap, so it can write hours later.
 *
 * Outside any work the start is the process start. That default is
 * conservative: code that forgot to start a work is treated as old, so it can
 * never slip a stale write past the fence. Every scheduler interval must wrap
 * its tick in `newWork`; a guard test enforces that.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance } from "fastify";

interface Work {
  startedAt: Date;
}

const storage = new AsyncLocalStorage<Work>();

export const PROCESS_STARTED_AT = new Date();

export function workStartedAt(): Date {
  return storage.getStore()?.startedAt ?? PROCESS_STARTED_AT;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Run `fn` as a new unit of work that starts now. A returned thenable is
 * started inside the work: a Prisma query is lazy and runs only when `.then`
 * is called, which for `runAsNewWork(() => prisma.x.create(...))` would be
 * the caller's `await`, outside the work.
 */
export function runAsNewWork<T>(fn: () => T): T {
  return storage.run({ startedAt: new Date() }, () => {
    const result = fn();
    return (isThenable(result) ? Promise.resolve(result) : result) as T;
  });
}

/** Wrap a scheduler tick so every call of it is a new unit of work. */
export function newWork<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args: A) => runAsNewWork(() => fn(...args));
}

/**
 * Every request is a unit of work. The hook is preValidation, after the body
 * was parsed: the parser runs from the socket's stream events, which would not
 * carry a context entered earlier.
 */
export function registerWorkContextHook(app: FastifyInstance): void {
  app.addHook("preValidation", (_request, _reply, done) => {
    runAsNewWork(done);
  });
}
