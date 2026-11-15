/**
 * Facts-only stand-ins for @sentry/node's OnUncaughtException and
 * OnUnhandledRejection integrations.
 *
 * The SDK's own ones hand Sentry the raw error, so the event carries its
 * message and, through linkedErrors, every `cause`; and they print it: the
 * rejection one prints `reason.stack`, whose first line is the message, and
 * the exception one prints the error whole (message, cause, own properties).
 * A Prisma call with a missing `.catch` makes that a
 * PrismaClientValidationError, whose message renders the call's arguments: a
 * mail's text, a Slack message. These two take the SDK's integration names, so
 * Sentry.init keeps them instead of its defaults, and send and print only
 * facts: class, code, Prisma model and operation, message length
 * (db-failure-facts.ts), plus the stack's frame lines (error-frames.ts).
 *
 * What the process does is the SDK's behaviour; only what is sent and printed
 * changes (sentry-process-faults-child.test.ts runs both side by side):
 *   - Unhandled rejection: reported at level "error", printed, and the process
 *     keeps running. A listener is registered, so Node's default
 *     (--unhandled-rejections=throw) does not raise it; the SDK's default
 *     "warn" mode did the same. The SDK's default ignore list (aborted AI SDK
 *     streams) is kept.
 *   - Uncaught exception: the first one is reported at level "fatal" and
 *     printed, then the client is closed (flushing for up to shutdownTimeout,
 *     2 s by default) and the process exits 1. If another uncaughtException
 *     listener is registered, the process is left to it, as the SDK does. A
 *     later exception is printed and changes nothing.
 * Both exist only while Sentry is initialised (SENTRY_DSN set). Without it,
 * Node's defaults apply, as before: either fault ends the process with 1, and
 * Node prints the error whole.
 */
import { isMainThread } from "node:worker_threads";
import * as Sentry from "@sentry/node";
import { type DbFailureFacts, dbFailureFacts, formatDbFailureFacts } from "./db-failure-facts.js";
import { originalFrames } from "./error-frames.js";

type Integration = Extract<NonNullable<Sentry.NodeOptions["integrations"]>, unknown[]>[number];
type Client = NonNullable<ReturnType<typeof Sentry.getClient>>;
type SeverityLevel = Sentry.SeverityLevel;

/** The SDK's names: an integration given later under the same name replaces its default. */
export const UNCAUGHT_EXCEPTION_INTEGRATION = "OnUncaughtException";
export const UNHANDLED_REJECTION_INTEGRATION = "OnUnhandledRejection";

/** The SDK's own `ignore` defaults: an aborted Vercel AI SDK stream is not a fault. */
const IGNORED_REJECTION_NAMES = new Set(["AI_NoOutputGeneratedError", "AbortError"]);
/** The SDK's flush budget before exit when `shutdownTimeout` is unset. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
/** Exit code after an uncaught exception: Node's, and the SDK's. */
const FATAL_EXIT_CODE = 1;

const REJECTION_LABEL = "Unhandled promise rejection";
const EXCEPTION_LABEL = "Uncaught exception";

/** The listeners these integrations register, so the exception handler can tell others apart. */
const ownListeners = new WeakSet<object>();

/** One console entry: a fixed head, the facts, and the frame lines when they could be kept. */
function faultLine(head: string, facts: DbFailureFacts, frames: string | null): string {
  const line = `${head}: ${formatDbFailureFacts(facts)}`;
  return frames === null ? line : `${line}\n${frames}`;
}

/** The fault's class, or for a rejection with a non-Error the JavaScript type of what it carried. */
function faultKind(fault: unknown, facts: DbFailureFacts): string {
  return fault instanceof Error ? facts.errorName : `non-Error ${typeof fault}`;
}

/**
 * A fresh Error naming the fault's kind, with its frames and no cause, so
 * Sentry still groups by where it was thrown. With no frames to keep, the
 * event has no stack rather than this module's.
 */
function factsError(label: string, kind: string, frames: string | null): Error {
  const reported = new Error(`${label} (${kind})`);
  reported.stack =
    frames === null ? `Error: ${reported.message}` : `Error: ${reported.message}\n${frames}`;
  return reported;
}

interface FaultReport {
  readonly label: string;
  readonly kind: string;
  readonly facts: DbFailureFacts;
  readonly frames: string | null;
  readonly level: SeverityLevel;
  /** The SDK's mechanism type, so issue search and alert rules on it keep matching. */
  readonly mechanism: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

function reportFault(report: FaultReport): void {
  Sentry.captureException(factsError(report.label, report.kind, report.frames), {
    captureContext: { level: report.level, extra: { ...report.extra, ...report.facts } },
    mechanism: { handled: false, type: report.mechanism },
  });
}

/** The span the SDK stamped on the fault when it was raised, so the event joins its trace. */
function activeSpanOf(fault: unknown): Sentry.Span | null {
  if (typeof fault !== "object" || fault === null) return null;
  const span = (fault as { _sentry_active_span?: unknown })._sentry_active_span;
  return typeof span === "object" && span !== null ? (span as Sentry.Span) : null;
}

function isIgnoredRejection(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) return false;
  const name = (reason as { name?: unknown }).name;
  return typeof name === "string" && IGNORED_REJECTION_NAMES.has(name);
}

/** Whether a listener other than these integrations' (or the SDK's own) would take over. */
function otherUncaughtListeners(): number {
  return process
    .listeners("uncaughtException")
    .filter(
      (listener) =>
        !ownListeners.has(listener) &&
        listener.name !== "domainUncaughtExceptionClear" &&
        (listener as { _errorHandler?: unknown })._errorHandler !== true,
    ).length;
}

function shutdownTimeoutMs(client: Client): number {
  const configured = client.getOptions().shutdownTimeout;
  return typeof configured === "number" && configured > 0
    ? configured
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

function makeRejectionListener(client: Client): (reason: unknown) => void {
  const onUnhandledRejectionFacts = (reason: unknown): void => {
    if (Sentry.getClient() !== client || isIgnoredRejection(reason)) return;
    const facts = dbFailureFacts(reason);
    const frames = originalFrames(reason);
    const report = (): void =>
      reportFault({
        label: REJECTION_LABEL,
        kind: faultKind(reason, facts),
        facts,
        frames,
        level: "error",
        mechanism: "auto.node.onunhandledrejection",
        extra: { unhandledPromiseRejection: true },
      });
    // As the SDK: inside the span the fault was raised in, when it carries one.
    const span = activeSpanOf(reason);
    if (span === null) report();
    else Sentry.withActiveSpan(span, report);
    console.error(
      faultLine(`[PROCESS] ${REJECTION_LABEL}; the process keeps running`, facts, frames),
    );
  };
  return onUnhandledRejectionFacts;
}

function makeExceptionListener(client: Client): (error: unknown) => void {
  let seenFirst = false;
  const onUncaughtExceptionFacts = (error: unknown): void => {
    const facts = dbFailureFacts(error);
    const frames = originalFrames(error);
    if (seenFirst) {
      console.error(faultLine(`[PROCESS] ${EXCEPTION_LABEL} after the first one`, facts, frames));
      return;
    }
    seenFirst = true;
    if (Sentry.getClient() === client) {
      reportFault({
        label: EXCEPTION_LABEL,
        kind: faultKind(error, facts),
        facts,
        frames,
        level: "fatal",
        mechanism: "auto.node.onuncaughtexception",
      });
    }
    const exits = otherUncaughtListeners() === 0;
    const outcome = exits ? "exiting" : "left to another uncaughtException listener";
    console.error(faultLine(`[PROCESS] ${EXCEPTION_LABEL}; ${outcome}`, facts, frames));
    if (!exits) return;
    void client.close(shutdownTimeoutMs(client)).then(
      () => process.exit(FATAL_EXIT_CODE),
      () => process.exit(FATAL_EXIT_CODE),
    );
  };
  return onUncaughtExceptionFacts;
}

/** Replaces the SDK's OnUncaughtException: report and print facts, flush, exit 1. */
export function uncaughtExceptionFactsIntegration(): Integration {
  return {
    name: UNCAUGHT_EXCEPTION_INTEGRATION,
    setup(client: Client): void {
      // As the SDK: a worker's uncaught exception is the parent's to handle.
      if (!isMainThread) return;
      const listener = makeExceptionListener(client);
      ownListeners.add(listener);
      process.on("uncaughtException", listener);
    },
  };
}

/** Replaces the SDK's OnUnhandledRejection: report and print facts, keep running. */
export function unhandledRejectionFactsIntegration(): Integration {
  return {
    name: UNHANDLED_REJECTION_INTEGRATION,
    setup(client: Client): void {
      const listener = makeRejectionListener(client);
      ownListeners.add(listener);
      process.on("unhandledRejection", listener);
    },
  };
}
