/**
 * Where a failure was thrown, without what it said: the stack's frame lines.
 *
 * A leaf (no imports), so the failure reporters (report-failure.ts) and the
 * process-fault integrations Sentry is built with (sentry-process-faults.ts)
 * can both use it without an import cycle through sentry.ts.
 */

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
export function originalFrames(err: unknown): string | null {
  if (!(err instanceof Error) || typeof err.stack !== "string") return null;
  const header = err.message ? `${err.name}: ${err.message}` : err.name;
  if (!err.stack.startsWith(`${header}\n`)) return null;
  const frames = err.stack.slice(header.length + 1).split("\n");
  return frames.every((line) => STACK_FRAME.test(line)) ? frames.join("\n") : null;
}
