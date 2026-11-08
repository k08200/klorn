/**
 * Error reporting for the Sent scan, the history import and their writes.
 * Their errors come from Prisma and Gmail, whose messages can quote query
 * values or headers (addresses, subjects). The log line and the Sentry event
 * carry the error's name and code only.
 */

import { isDataWipeFenceError } from "../privacy/data-wipe-fence.js";
import { captureError } from "../sentry.js";

export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

/**
 * One console line and one Sentry event, with no message text from `err`. A
 * write the data-wipe fence rejected is logged only: it is the fence working,
 * and the wrapper below would hide it from captureError's own fence filter.
 */
export function reportSentError(scope: string, err: unknown, userId: string): void {
  const name = errorName(err);
  const code = errorCode(err);
  console.warn(`[SENT] ${scope} failed:`, name, code ?? "");
  if (isDataWipeFenceError(err)) return;
  const safe = Object.assign(new Error(`${scope} failed (${name})`), { name });
  captureError(safe, { tags: { scope }, extra: { userId, code } });
}
