/**
 * Child process for sentry-process-faults-child.test.ts: start Sentry, then
 * leave one fault unhandled and see what the process does.
 *
 *   node --import tsx sentry-fault-child.ts <rejection|exception> <production|sdk-default> <envelope file>
 *
 * `production` runs buildSentryInitOptions exactly as initSentry does;
 * `sdk-default` drops our two process integrations so the SDK's own ones run,
 * which is how the process behaved before they were replaced. Envelopes go to
 * the file instead of the network. The fault quotes the canaries from the
 * environment in its message, its cause and an own property, the way a
 * PrismaClientValidationError quotes the call's arguments.
 */
import { appendFileSync } from "node:fs";
import * as Sentry from "@sentry/node";
import { buildSentryInitOptions } from "../../sentry.js";

const [mode, variant, envelopeFile] = process.argv.slice(2);
const MESSAGE_CANARY = process.env.FAULT_MESSAGE_CANARY ?? "";
const CAUSE_CANARY = process.env.FAULT_CAUSE_CANARY ?? "";
const META_CANARY = process.env.FAULT_META_CANARY ?? "";
/**
 * When a process the fault did not end says so. A rejection is handled within
 * a tick; an uncaught exception ends the process after the SDK's shutdown
 * flush (up to 2 s), so its check waits well past that.
 */
const ALIVE_AFTER_MS = mode === "rejection" ? 1_000 : 10_000;

if (!envelopeFile || !MESSAGE_CANARY || !CAUSE_CANARY || !META_CANARY) {
  throw new Error("usage: sentry-fault-child.ts <mode> <variant> <envelope file>, canaries in env");
}

class PrismaClientValidationError extends Error {
  readonly clientVersion = "6.19.3";
  readonly meta = { target: META_CANARY };

  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "PrismaClientValidationError";
  }
}

function faultQuotingTheCall(): Error {
  return new PrismaClientValidationError(
    `\nInvalid \`prisma.slackMessage.create()\` invocation:\n\n{ data: { text: "${MESSAGE_CANARY}" } }`,
    { cause: new Error(CAUSE_CANARY) },
  );
}

const options = buildSentryInitOptions("https://public@o0.ingest.sentry.io/0", "test");
const replaced = new Set(["OnUncaughtException", "OnUnhandledRejection"]);
const integrations =
  variant === "sdk-default" && Array.isArray(options.integrations)
    ? options.integrations.filter((integration) => !replaced.has(integration.name))
    : options.integrations;
const decoder = new TextDecoder();

Sentry.init({
  ...options,
  integrations,
  transport: (transportOptions) =>
    Sentry.createTransport(transportOptions, async (request) => {
      const body = typeof request.body === "string" ? request.body : decoder.decode(request.body);
      appendFileSync(envelopeFile, `${body}\n`);
      return { statusCode: 200 };
    }),
});

setTimeout(() => {
  console.log("ALIVE_AFTER_FAULT");
  void Sentry.flush(2_000).then(() => process.exit(0));
}, ALIVE_AFTER_MS);

if (mode === "rejection") {
  void Promise.reject(faultQuotingTheCall());
} else {
  setTimeout(() => {
    throw faultQuotingTheCall();
  }, 0);
}
