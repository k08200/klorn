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
 * The label is operator text written in code. Never interpolate content into
 * it; put ids in `ids` / `extra` (db-failure-redaction-guard.test.ts holds
 * every call to a string literal).
 */
import {
  captureFailureFacts,
  type FailureLogOptions,
  type FailureSentryContext,
  logFailureFacts,
} from "./report-failure.js";

/** What a failure report may say about a database error. */
export interface DbFailureFacts {
  readonly errorName: string;
  /**
   * Prisma's code (P2002 unique violation, P2025 not found, P1001 unreachable),
   * or a system error's (ECONNRESET) from a call in the same block.
   */
  readonly code: string | null;
  /** The Prisma model the call ran on, e.g. "SlackMessage". */
  readonly model: string | null;
  /** The client method, e.g. "create", "updateMany", "$queryRaw". */
  readonly operation: string | null;
  /** An HTTP status, when the failure came from a provider call in the same block. */
  readonly status: number | null;
  readonly messageLength: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** An error code is an upper-case token (P2002, ECONNRESET), never a phrase. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const ESC = String.fromCharCode(0x1b);
/** errorFormat "pretty" colors the header. */
const ANSI_COLOR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
/**
 * The header every Prisma client error opens with:
 * "\nInvalid `prisma.slackMessage.create()` invocation:". Prisma builds it
 * from the client method, never from the call's arguments; anchored at the
 * start, so text quoted later in the message cannot be read as one.
 */
const INVOCATION_HEADER =
  /^\s*Invalid `prisma\.(?:([A-Za-z_][A-Za-z0-9_]{0,63})\.)?(\$?[A-Za-z_][A-Za-z0-9_]{0,63})\(\)` invocation/;
/** The header sits in the first line or two; the rest is never scanned. */
const HEADER_SCAN_CHARS = 300;
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;

function errorName(err: unknown): string {
  if (!(err instanceof Error)) return "UnknownError";
  // A self-assigned name (PrismaClientKnownRequestError) is precise; fall back
  // to the constructor only when `name` is the inherited default.
  const name = err.name && err.name !== "Error" ? err.name : err.constructor?.name || "Error";
  return IDENTIFIER.test(name) ? name : "Error";
}

/** Prisma puts its code in `code` (`errorCode` on an initialization error), Node in `code`. */
function errorCode(err: unknown): string | null {
  const fields = err as { code?: unknown; errorCode?: unknown } | null | undefined;
  for (const value of [fields?.code, fields?.errorCode]) {
    if (typeof value === "string" && ERROR_CODE.test(value)) return value;
  }
  return null;
}

function invocation(err: unknown): { model: string | null; operation: string } | null {
  if (!(err instanceof Error) || !err.name.startsWith("PrismaClient")) return null;
  const head = err.message.slice(0, HEADER_SCAN_CHARS).replace(ANSI_COLOR, "");
  const match = INVOCATION_HEADER.exec(head);
  if (!match?.[2]) return null;
  const accessor = match[1];
  // The client accessor is the model name with its first letter lowered.
  const model = accessor ? accessor.charAt(0).toUpperCase() + accessor.slice(1) : null;
  return { model, operation: match[2] };
}

function metaModel(err: unknown): string | null {
  const modelName = (err as { meta?: { modelName?: unknown } } | null | undefined)?.meta?.modelName;
  return typeof modelName === "string" && IDENTIFIER.test(modelName) ? modelName : null;
}

/** googleapis puts the HTTP status in `response.status` and, as a number, in `code`. */
function httpStatus(err: unknown): number | null {
  const fields = err as
    | { status?: unknown; statusCode?: unknown; code?: unknown; response?: { status?: unknown } }
    | null
    | undefined;
  for (const value of [
    fields?.status,
    fields?.statusCode,
    fields?.response?.status,
    fields?.code,
  ]) {
    if (
      Number.isInteger(value) &&
      Number(value) >= MIN_HTTP_STATUS &&
      Number(value) <= MAX_HTTP_STATUS
    ) {
      return Number(value);
    }
  }
  return null;
}

/**
 * The facts of a database failure that are safe for Sentry and the log. Never
 * the message, `meta.target`, `meta.message` or `cause`: each can quote a value.
 */
export function dbFailureFacts(err: unknown): DbFailureFacts {
  const call = invocation(err);
  return {
    errorName: errorName(err),
    code: errorCode(err),
    model: metaModel(err) ?? call?.model ?? null,
    operation: call?.operation ?? null,
    status: httpStatus(err),
    messageLength: err instanceof Error ? err.message.length : 0,
  };
}

/** One log fragment, e.g. "PrismaClientKnownRequestError P2002, model=Notification, operation=create, message 120 chars". */
export function formatDbFailureFacts(facts: DbFailureFacts): string {
  const head = [facts.errorName, facts.code, facts.status]
    .filter((part) => part !== null)
    .join(" ");
  return [
    head,
    facts.model === null ? null : `model=${facts.model}`,
    facts.operation === null ? null : `operation=${facts.operation}`,
    `message ${facts.messageLength} chars`,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}

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
