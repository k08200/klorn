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
  uncaughtExceptionFactsIntegration,
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

/** Mechanism objects in the payload: Sentry's source context quotes this file's string literals. */
function fatalEvents(payload: string): number {
  return payload.match(/"mechanism":\{"type":"auto\.node\.onuncaughtexception"/g)?.length ?? 0;
}

/**
 * A fresh exception listener (fresh first/exiting state) on the running
 * client, with the process seen as having no other uncaughtException listener
 * (vitest's is hidden) unless `others` says so, `client.close` resolved without
 * closing, and `process.exit` recorded instead of run.
 */
function productionExceptionListener() {
  const client = Sentry.getClient();
  if (client === undefined) throw new Error("Sentry is not initialised");
  const before = new Set(process.listeners("uncaughtException"));
  uncaughtExceptionFactsIntegration().setup?.(client);
  const listener = process.listeners("uncaughtException").find((l) => !before.has(l)) as Listener;
  const others: Array<() => void> = [];
  const realListeners = process.listeners.bind(process);
  const listeners = vi
    .spyOn(process, "listeners")
    .mockImplementation(((event: string) =>
      event === "uncaughtException"
        ? [listener, ...others]
        : realListeners(event as "exit")) as typeof process.listeners);
  const close = vi.spyOn(client, "close").mockResolvedValue(true);
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const restore = (): void => {
    listeners.mockRestore();
    close.mockRestore();
    exit.mockRestore();
    process.off("uncaughtException", listener);
  };
  return { listener, others, close, exit, restore };
}

describe("the uncaught-exception listener with no other listener (production)", () => {
  it("reports the first exception, flushes and exits 1 once; a later one is only printed", async () => {
    const run = productionExceptionListener();
    try {
      run.listener(faultQuotingTheCall());
      await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(1));
      run.listener(new Error(`while exiting ${MESSAGE_CANARY}`));
      await Sentry.flush(SENTRY_FLUSH_MS);

      expect(run.close).toHaveBeenCalledTimes(1);
      expect(run.close).toHaveBeenCalledWith(2_000);
      expect(run.exit).toHaveBeenCalledTimes(1);
      expect(fatalEvents(capture.sent())).toBe(1);
      expect(printedText()).toContain("Uncaught exception (PrismaClientValidationError); exiting");
      expect(printedText()).toContain("Uncaught exception (Error); while exiting");
      expectNoCanary(capture.sent());
      expectNoCanary(printedText());
    } finally {
      run.restore();
    }
  });

  it("still exits for a fault Sentry already captured, without sending it again", async () => {
    const run = productionExceptionListener();
    try {
      const fault = faultQuotingTheCall();
      Object.defineProperty(fault, "__sentry_captured__", { value: true, enumerable: false });
      run.listener(fault);
      await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(1));
      await Sentry.flush(SENTRY_FLUSH_MS);

      expect(fatalEvents(capture.sent())).toBe(0);
      expect(printedText()).toContain("; exiting");
    } finally {
      run.restore();
    }
  });

  it("reports a fault whose fields throw on read, and still exits", async () => {
    const run = productionExceptionListener();
    try {
      const hostile = new Proxy(new Error(MESSAGE_CANARY), {
        get(target, key) {
          if (key === "code" || key === "message") throw new Error(CAUSE_CANARY);
          return Reflect.get(target, key);
        },
      });
      expect(() => run.listener(hostile)).not.toThrow();
      await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(1));
      await Sentry.flush(SENTRY_FLUSH_MS);

      expect(capture.sent()).toContain("Uncaught exception (UnreadableFault)");
      expectNoCanary(capture.sent());
      expectNoCanary(printedText());
    } finally {
      run.restore();
    }
  });

  it("exits on a later exception once the other listener is gone, without a second report", async () => {
    const run = productionExceptionListener();
    try {
      run.others.push(() => undefined);
      run.listener(faultQuotingTheCall());
      expect(run.exit).not.toHaveBeenCalled();
      run.others.length = 0;
      run.listener(new Error(`later ${MESSAGE_CANARY}`));
      await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(1));
      await Sentry.flush(SENTRY_FLUSH_MS);

      expect(run.close).toHaveBeenCalledTimes(1);
      expect(fatalEvents(capture.sent())).toBe(1);
      expectNoCanary(capture.sent());
      expectNoCanary(printedText());
    } finally {
      run.restore();
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
