/**
 * Report a database failure to the console and Sentry without its words.
 *
 * A Prisma error can quote the call it rejected. A PrismaClientValidationError
 * renders the whole call, values included, into its message in every
 * errorFormat (production runs "minimal"): a Slack message's text, an imported
 * KakaoTalk line, a reminder title that quotes a mail subject. A raw-query
 * failure carries Postgres's message, which quotes the bad value. Sentry sends
 * an error's message and Node's console prints it. So a catch over such rows
 * reports through here: a fixed label, the failure's facts (dbFailureFacts:
 * class, code, model, operation, status, message length) and the
 * caller's ids. Never the error object itself.
 *
 * Those catches also wrap the calls beside the database ones (Google, Outlook
 * and CalDAV calendars, web push, mail sends), whose errors can quote the
 * events or addresses they carried; the same facts cover them (the HTTP
 * status, a system code such as ECONNRESET).
 *
 * The label is operator text written in code. Never interpolate content into
 * it; put ids in `ids` / `extra` (db-failure-redaction-guard.test.ts holds
 * every call to a string literal).
 */
import { dbFailureFacts, formatDbFailureFacts } from "./db-failure-facts.js";
import {
  captureFailureFacts,
  type FailureLogOptions,
  type FailureSentryContext,
  logFailureFacts,
} from "./report-failure.js";

export { type DbFailureFacts, dbFailureFacts, formatDbFailureFacts } from "./db-failure-facts.js";

/** One console line: `<label> (reminderId=r1): PrismaClientValidationError, model=…, message 812 chars`. */
export function logDbFailure(label: string, err: unknown, options: FailureLogOptions = {}): void {
  logFailureFacts(label, formatDbFailureFacts(dbFailureFacts(err)), options);
}

/**
 * Send Sentry a fresh Error (label plus class name, no cause) carrying the
 * original's stack frames, with the facts in `extra`. A data-wipe fence
 * rejection is skipped, as captureError skips it for the raw error.
 */
export function captureDbFailure(label: string, err: unknown, context: FailureSentryContext): void {
  captureFailureFacts(label, err, dbFailureFacts(err), context);
}
