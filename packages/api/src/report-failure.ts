/**
 * The reporting path shared by llm/report-llm-failure.ts and
 * report-db-failure.ts: a failure goes to the console and Sentry as a fixed
 * label plus facts (class, codes, sizes), never as the error object, whose
 * message and `cause` Sentry sends and Node's console prints.
 *
 * Each reporter decides which facts are safe for its kind of failure; this
 * module only formats the line and builds the Sentry event.
 */
import { isDataWipeFenceError } from "./privacy/data-wipe-fence.js";
import { captureError } from "./sentry.js";

export interface FailureSentryContext {
  /** Sentry tags, e.g. the existing `scope`. Keep a site's scope unchanged so its alerts keep matching. */
  readonly tags: Readonly<Record<string, string>>;
  /**
   * Ids and operational context (provider, key kind, model, route). Never
   * content. A key a fact also uses (errorName, status, …) is overwritten by
   * the fact.
   */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface FailureLogOptions {
  readonly level?: "warn" | "error";
  /** Ids and counters for the line, e.g. { userId, emailId }. Never content. */
  readonly ids?: Readonly<Record<string, string | number | null | undefined>>;
}

/** One console line: `<label> (userId=u1): <facts>`. */
export function logFailureFacts(label: string, facts: string, options: FailureLogOptions): void {
  const ids = Object.entries(options.ids ?? {})
    .map(([key, value]) => `${key}=${value ?? "-"}`)
    .join(", ");
  const head = ids === "" ? label : `${label} (${ids})`;
  const line = `${head}: ${facts}`;
  if (options.level === "error") console.error(line);
  else console.warn(line);
}

/** A stack line that names a frame (function and file position), never message text. */
const STACK_FRAME = /^\s+at /;

/**
 * The original's stack frames without its `Name: message` header, so Sentry
 * still shows where the failure was thrown. V8 writes that header from the
 * error's name and message when the stack is first read; when it cannot be
 * matched exactly (the message changed after the stack was read), or anything
 * after it is not a frame line, no frames are kept rather than risk message
 * text, which can span lines.
 */
function originalFrames(err: unknown): string | null {
  if (!(err instanceof Error) || typeof err.stack !== "string") return null;
  const header = err.message ? `${err.name}: ${err.message}` : err.name;
  if (!err.stack.startsWith(`${header}\n`)) return null;
  const frames = err.stack.slice(header.length + 1).split("\n");
  return frames.every((line) => STACK_FRAME.test(line)) ? frames.join("\n") : null;
}

/**
 * Send Sentry a fresh Error (label plus class name, no cause) carrying the
 * original's stack frames, with the facts in `extra`. A data-wipe fence
 * rejection is skipped, as captureError skips it for the raw error.
 */
export function captureFailureFacts(
  label: string,
  err: unknown,
  /** Spread whole into `extra`; every field must be safe to send. */
  facts: Readonly<{ errorName: string }>,
  context: FailureSentryContext,
): void {
  if (isDataWipeFenceError(err)) return;
  const reported = new Error(`${label} (${facts.errorName})`);
  const frames = originalFrames(err);
  if (frames !== null) reported.stack = `Error: ${reported.message}\n${frames}`;
  captureError(reported, {
    tags: { ...context.tags },
    extra: { ...context.extra, ...facts },
  });
}
