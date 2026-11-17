/**
 * The process-fault integrations inside the real SDK, with the production
 * options (sentry.ts buildSentryInitOptions) and a capturing transport.
 *
 * sentry-process-faults-child.test.ts runs a real fault in a child process
 * for the exit behaviour. This file pins the wiring the child relies on:
 * Sentry.init keeps our two integrations in place of the SDK's (whose
 * listeners would send and print the raw error), the listeners send and print
 * facts for every kind of rejection reason, and no other module registers a
 * process-level fault listener (one would change what the process does: an
 * uncaughtException listener stops the exit, an unhandledRejection listener
 * stops Node's crash when Sentry is off).
 *
 * The listeners are called directly, not through process.emit: vitest listens
 * for both events too and would report the canary as a test failure.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as Sentry from "@sentry/node";
import ts from "typescript";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { buildSentryInitOptions } from "../sentry.js";
import {
  UNCAUGHT_EXCEPTION_INTEGRATION,
  UNHANDLED_REJECTION_INTEGRATION,
} from "../sentry-process-faults.js";
import { walk } from "./helpers/catch-sink-scan.js";
import {
  initCapturingSentry,
  SENTRY_FLUSH_MS,
  type SentryCapture,
  TEST_SENTRY_DSN,
} from "./helpers/sentry-capture.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..");

const MESSAGE_CANARY = "wiring-message-canary-0c4e";
const CAUSE_CANARY = "wiring-cause-canary-61d0";
const META_CANARY = "wiring-meta-canary-f3a9";
const CANARIES = [MESSAGE_CANARY, CAUSE_CANARY, META_CANARY];

type Listener = (fault: unknown) => void;

let capture: SentryCapture;
let printed: MockInstance<typeof console.error>;

class PrismaClientValidationError extends Error {
  readonly meta = { target: META_CANARY };

  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "PrismaClientValidationError";
  }
}

function faultQuotingTheCall(): Error {
  return new PrismaClientValidationError(
    `\nInvalid \`prisma.reminder.update()\` invocation:\n\n{ data: { title: "${MESSAGE_CANARY}" } }`,
    { cause: new Error(CAUSE_CANARY) },
  );
}

function ourListener(event: "uncaughtException" | "unhandledRejection", name: string): Listener {
  const listener = process.listeners(event).find((l) => l.name === name);
  if (listener === undefined) throw new Error(`no ${name} listener on ${event}`);
  return listener as Listener;
}

function printedText(): string {
  return printed.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
}

function expectNoCanary(text: string): void {
  for (const canary of CANARIES) expect(text).not.toContain(canary);
}

beforeAll(() => {
  capture = initCapturingSentry(buildSentryInitOptions(TEST_SENTRY_DSN, "test"));
});

beforeEach(() => {
  capture.reset();
  printed = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  printed.mockRestore();
});

afterAll(async () => {
  await Sentry.close(SENTRY_FLUSH_MS);
});

describe("Sentry.init with the production options", () => {
  it("keeps our two process integrations in place of the SDK's", () => {
    const client = Sentry.getClient();
    expect(client?.getIntegrationByName(UNCAUGHT_EXCEPTION_INTEGRATION)).toBeDefined();
    expect(client?.getIntegrationByName(UNHANDLED_REJECTION_INTEGRATION)).toBeDefined();
    const onException = process.listeners("uncaughtException");
    const onRejection = process.listeners("unhandledRejection");
    expect(onException.map((l) => l.name)).toContain("onUncaughtExceptionFacts");
    expect(onRejection.map((l) => l.name)).toContain("onUnhandledRejectionFacts");
    // The SDK marks its exception listener `_errorHandler` and names its rejection one.
    expect(onException.some((l) => (l as { _errorHandler?: unknown })._errorHandler === true)).toBe(
      false,
    );
    expect(onRejection.map((l) => l.name)).not.toContain("sendUnhandledPromise");
  });
});

describe("the unhandled-rejection listener", () => {
  it("sends facts and frames at level error, and prints no words", async () => {
    ourListener("unhandledRejection", "onUnhandledRejectionFacts")(faultQuotingTheCall());
    await Sentry.flush(SENTRY_FLUSH_MS);

    const payload = capture.sent();
    expect(payload).toContain("auto.node.onunhandledrejection");
    expect(payload).toContain('"level":"error"');
    expect(payload).toContain('"unhandledPromiseRejection":true');
    expect(payload).toContain("Unhandled promise rejection (PrismaClientValidationError)");
    expect(payload).toContain('"model":"Reminder"');
    expect(payload).toContain("faultQuotingTheCall");
    expectNoCanary(payload);
    expect(printedText()).toContain("model=Reminder, operation=update");
    expect(printedText()).toContain("at faultQuotingTheCall");
    expectNoCanary(printedText());
  });

  it.each([
    ["a string", `rejected with ${MESSAGE_CANARY}`],
    ["a plain object", { message: MESSAGE_CANARY, detail: { text: CAUSE_CANARY } }],
  ])("reports %s reason as its kind only", async (_label, reason) => {
    ourListener("unhandledRejection", "onUnhandledRejectionFacts")(reason);
    await Sentry.flush(SENTRY_FLUSH_MS);

    const payload = capture.sent();
    expect(payload).toContain(`Unhandled promise rejection (non-Error ${typeof reason})`);
    expectNoCanary(payload);
    expect(printedText()).toContain(
      `(non-Error ${typeof reason}); the process keeps running: UnknownError`,
    );
    expectNoCanary(printedText());
  });

  it("does not send again a fault Sentry already captured, as the SDK's client drops it", async () => {
    const fault = faultQuotingTheCall();
    Object.defineProperty(fault, "__sentry_captured__", { value: true, enumerable: false });
    ourListener("unhandledRejection", "onUnhandledRejectionFacts")(fault);
    await Sentry.flush(SENTRY_FLUSH_MS);

    expect(capture.sent()).not.toContain("auto.node.onunhandledrejection");
    expect(printedText()).toContain(
      "Unhandled promise rejection (PrismaClientValidationError); the process keeps running",
    );
    expectNoCanary(printedText());
  });

  it("reports a fault whose fields throw on read, instead of throwing from the listener", async () => {
    const hostile = new Proxy(new Error(MESSAGE_CANARY), {
      get(target, key) {
        if (key === "stack" || key === "message" || key === "code") throw new Error(CAUSE_CANARY);
        return Reflect.get(target, key);
      },
    });
    const listener = ourListener("unhandledRejection", "onUnhandledRejectionFacts");
    expect(() => listener(hostile)).not.toThrow();
    await Sentry.flush(SENTRY_FLUSH_MS);

    expect(capture.sent()).toContain("Unhandled promise rejection (UnreadableFault)");
    expectNoCanary(capture.sent());
    expectNoCanary(printedText());
  });

  it("ignores what the SDK ignores by default (an aborted stream)", async () => {
    const aborted = Object.assign(new Error(MESSAGE_CANARY), { name: "AbortError" });
    ourListener("unhandledRejection", "onUnhandledRejectionFacts")(aborted);
    await Sentry.flush(SENTRY_FLUSH_MS);

    expect(capture.sent()).not.toContain("onunhandledrejection");
    expectNoCanary(capture.sent());
    expect(printed).not.toHaveBeenCalled();
  });
});

describe("the uncaught-exception listener", () => {
  it("leaves the process to another uncaughtException listener, reports the first fault as fatal facts, and only prints later ones", async () => {
    // Another listener (vitest's, and this one) means the process is not this
    // listener's to end, as with the SDK's. The exit path runs in the child test.
    const other = (): void => undefined;
    process.on("uncaughtException", other);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const listener = ourListener("uncaughtException", "onUncaughtExceptionFacts");
      listener(faultQuotingTheCall());
      listener(new Error(`second ${MESSAGE_CANARY}`));
      await Sentry.flush(SENTRY_FLUSH_MS);

      const payload = capture.sent();
      expect(payload).toContain("auto.node.onuncaughtexception");
      expect(payload).toContain('"level":"fatal"');
      expect(payload).toContain("Uncaught exception (PrismaClientValidationError)");
      // One event: the second fault is printed, not sent (the source context
      // Sentry attaches quotes this file, so count the mechanism object).
      expect(payload.match(/"mechanism":\{"type":"auto\.node\.onuncaughtexception"/g)).toHaveLength(
        1,
      );
      expectNoCanary(payload);
      expect(printedText().match(/left to another uncaughtException listener/g)).toHaveLength(2);
      expectNoCanary(printedText());
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      process.off("uncaughtException", other);
    }
  });
});

/** Event names whose listener decides whether a fault ends the process. */
const FAULT_EVENTS = new Set(["uncaughtException", "unhandledRejection"]);
const LISTEN_METHODS = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
]);

/** `process.on("uncaughtException" | "unhandledRejection", …)` registrations in a file. */
function faultListenerRegistrations(file: string, code: string): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      LISTEN_METHODS.has(node.expression.name.text) &&
      node.expression.expression.getText(source).replace(/^globalThis\.|^global\./, "") ===
        "process" &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      FAULT_EVENTS.has(node.arguments[0].text)
    ) {
      found.push(`${file}: ${node.arguments[0].text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("process fault listeners across packages/api/src", () => {
  it("are registered by sentry-process-faults.ts and nowhere else", () => {
    const registrations = walk(srcDir).flatMap((full) =>
      faultListenerRegistrations(
        relative(srcDir, full).split("\\").join("/"),
        readFileSync(full, "utf8"),
      ),
    );
    expect(registrations.sort()).toEqual([
      "sentry-process-faults.ts: uncaughtException",
      "sentry-process-faults.ts: unhandledRejection",
    ]);
  });

  it("finds a registration in any of its forms", () => {
    const code = [
      "process.on('uncaughtException', a);",
      'process.once("unhandledRejection", b);',
      "globalThis.process.prependListener('uncaughtException', c);",
      "process.on('exit', d);",
      "emitter.on('uncaughtException', e);",
    ].join("\n");
    expect(faultListenerRegistrations("x.ts", code)).toEqual([
      "x.ts: uncaughtException",
      "x.ts: unhandledRejection",
      "x.ts: uncaughtException",
    ]);
  });

  it("index.ts starts Sentry at module top, before the app is built", () => {
    const code = readFileSync(join(srcDir, "index.ts"), "utf8");
    const source = ts.createSourceFile("index.ts", code, ts.ScriptTarget.Latest, true);
    const statements = source.statements.map((s) => s.getText(source));
    const init = statements.indexOf("initSentry();");
    const app = statements.findIndex((s) => s.startsWith("const app = Fastify("));
    expect(init).toBeGreaterThanOrEqual(0);
    expect(app).toBeGreaterThan(init);
  });
});
