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
 * What the process does follows the SDK (sentry-process-faults-child.test.ts
 * runs both side by side and compares exit code and liveness):
 *   - Unhandled rejection: reported at level "error", printed, and the process
 *     keeps running. A listener is registered, so Node's default
 *     (--unhandled-rejections=throw) does not raise it; the SDK's default
 *     "warn" mode did the same. The SDK's default ignore list (aborted AI SDK
 *     streams) is kept.
 *   - Uncaught exception: the first one is reported at level "fatal" and
 *     printed, then the client is closed (flushing for up to shutdownTimeout,
 *     2 s by default) and the process exits 1. While another uncaughtException
 *     listener is registered, the process is left to it, as the SDK does.
 *     Only the first exception is reported; later ones are printed.
 *   - A fault Sentry already captured (marked `__sentry_captured__`) is not
 *     reported again, as the SDK's client drops it.
 * Where this differs from the SDK, on purpose or because the SDK's hooks are
 * not public:
 *   - The event is a fresh Error ("<label> (<class>)") with the fault's frames,
 *     so an issue search on the exception type sees `Error`; the mechanism
 *     type and level are the SDK's.
 *   - The SDK's `onFatalError` option is not consulted (Klorn sets none).
 *   - When a later exception finds the other listeners gone, the process exits
 *     at once; the SDK waits 2 s first.
 *   - The printed line is not sandboxed from Sentry's console breadcrumbs
 *     (`consoleSandbox` is not exported by @sentry/node), so it can ride on a
 *     later event; it holds the same facts and frames as the event.
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

/** What these integrations say about a fault when its own fields cannot be read. */
const UNREADABLE_FACTS: DbFailureFacts = {
  errorName: "UnreadableFault",
  code: null,
  model: null,
  operation: null,
  status: null,
  messageLength: 0,
};

/** The listeners these integrations register, so the exception handler can tell others apart. */
const ownListeners = new WeakSet<object>();

/** What may be said about a fault: facts, frames, and its kind for the event title. */
interface FaultFacts {
  readonly facts: DbFailureFacts;
  readonly frames: string | null;
  /** The class, or for a non-Error the JavaScript type of what was thrown. */
  readonly kind: string;
}

/**
 * Read once, guarded: a thrown value can be anything, a getter on it can
 * throw, and a throw here would escape the listener (Node then exits 7 from
 * the exception path, unflushed, printing the new error).
 */
function readFaultFacts(fault: unknown): FaultFacts {
  try {
    const facts = dbFailureFacts(fault);
    return {
      facts,
      frames: originalFrames(fault),
      kind: fault instanceof Error ? facts.errorName : `non-Error ${typeof fault}`,
    };
  } catch {
    return { facts: UNREADABLE_FACTS, frames: null, kind: UNREADABLE_FACTS.errorName };
  }
}

/** A field of the fault, or undefined when it is not an object or the read throws. */
function fieldOf(fault: unknown, key: string): unknown {
  if (typeof fault !== "object" || fault === null) return undefined;
  try {
    return (fault as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** One console entry: what happened and to what kind, the facts, and the frame lines when kept. */
function faultLine(label: string, outcome: string, fault: FaultFacts): string {
  const line = `[PROCESS] ${label} (${fault.kind}); ${outcome}: ${formatDbFailureFacts(fault.facts)}`;
  return fault.frames === null ? line : `${line}\n${fault.frames}`;
}

/**
 * A fresh Error naming the fault's kind, with its frames and no cause, so
 * Sentry still groups by where it was thrown. With no frames to keep, the
 * event has no stack rather than this module's.
 */
function factsError(label: string, fault: FaultFacts): Error {
  const reported = new Error(`${label} (${fault.kind})`);
  reported.stack =
    fault.frames === null
      ? `Error: ${reported.message}`
      : `Error: ${reported.message}\n${fault.frames}`;
  return reported;
}

interface FaultReport {
  readonly label: string;
  readonly fault: FaultFacts;
  readonly level: SeverityLevel;
  /** The SDK's mechanism type, so issue search and alert rules on it keep matching. */
  readonly mechanism: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

function reportFault(report: FaultReport): void {
  Sentry.captureException(factsError(report.label, report.fault), {
    captureContext: { level: report.level, extra: { ...report.extra, ...report.fault.facts } },
    mechanism: { handled: false, type: report.mechanism },
  });
}

/** Whether Sentry already sent this fault itself (its client marks what it captures). */
function alreadyCaptured(fault: unknown): boolean {
  return fieldOf(fault, "__sentry_captured__") === true;
}

/** The span the SDK stamped on the fault when it was raised, so the event joins its trace. */
function activeSpanOf(fault: unknown): Sentry.Span | null {
  const span = fieldOf(fault, "_sentry_active_span");
  return typeof span === "object" &&
    span !== null &&
    typeof (span as { spanContext?: unknown }).spanContext === "function"
    ? (span as Sentry.Span)
    : null;
}

function isIgnoredRejection(reason: unknown): boolean {
  const name = fieldOf(reason, "name");
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
  // NodeClientOptions; the core client type does not name the field.
  const configured = (client.getOptions() as { shutdownTimeout?: unknown }).shutdownTimeout;
  return typeof configured === "number" && configured > 0
    ? configured
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

function makeRejectionListener(client: Client): (reason: unknown) => void {
  const onUnhandledRejectionFacts = (reason: unknown): void => {
    if (Sentry.getClient() !== client || isIgnoredRejection(reason)) return;
    const fault = readFaultFacts(reason);
    if (!alreadyCaptured(reason)) {
      const report = (): void =>
        reportFault({
          label: REJECTION_LABEL,
          fault,
          level: "error",
          mechanism: "auto.node.onunhandledrejection",
          extra: { unhandledPromiseRejection: true },
        });
      // As the SDK: inside the span the fault was raised in, when it carries one.
      const span = activeSpanOf(reason);
      if (span === null) report();
      else Sentry.withActiveSpan(span, report);
    }
    console.error(faultLine(REJECTION_LABEL, "the process keeps running", fault));
  };
  return onUnhandledRejectionFacts;
}

function makeExceptionListener(client: Client): (error: unknown) => void {
  let reported = false;
  let exiting = false;
  const onUncaughtExceptionFacts = (error: unknown): void => {
    const fault = readFaultFacts(error);
    if (exiting) {
      console.error(faultLine(EXCEPTION_LABEL, "while exiting", fault));
      return;
    }
    if (!reported && Sentry.getClient() === client && !alreadyCaptured(error)) {
      reportFault({
        label: EXCEPTION_LABEL,
        fault,
        level: "fatal",
        mechanism: "auto.node.onuncaughtexception",
      });
    }
    reported = true;
    exiting = otherUncaughtListeners() === 0;
    const outcome = exiting ? "exiting" : "left to another uncaughtException listener";
    console.error(faultLine(EXCEPTION_LABEL, outcome, fault));
    if (!exiting) return;
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
