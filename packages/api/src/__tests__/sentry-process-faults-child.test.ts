/**
 * An unhandled rejection and an uncaught exception, end to end, in a real
 * process with the real SDK (fixtures/sentry-fault-child.ts).
 *
 * Two things are pinned at once:
 *   - Crash semantics are unchanged. The same fault runs under the SDK's own
 *     OnUncaughtException / OnUnhandledRejection integrations (`sdk-default`,
 *     the behaviour before sentry-process-faults.ts) and under the production
 *     options; the exit code and whether the process outlives the fault must
 *     match. Before and after: a rejection is reported and the process keeps
 *     running; an uncaught exception is reported, flushed, and exits 1.
 *   - Only facts leave. Under the production options neither the envelope nor
 *     the console carries the fault's message, its cause or its own
 *     properties. The `sdk-default` run is the control that shows the canaries
 *     are visible to this test when they do leak.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, "..", "..");
const CHILD = join(here, "fixtures", "sentry-fault-child.ts");
const CANARIES = {
  FAULT_MESSAGE_CANARY: "message-canary-5e1f-mail-text",
  FAULT_CAUSE_CANARY: "cause-canary-9b2c-raw-provider-body",
  FAULT_META_CANARY: "meta-canary-77aa-unique-target",
} as const;
const CHILD_TIMEOUT_MS = 30_000;

type Mode = "rejection" | "exception";
type Variant = "production" | "sdk-default";

interface ChildRun {
  readonly code: number | null;
  readonly console: string;
  readonly envelope: string;
}

const workDir = mkdtempSync(join(tmpdir(), "sentry-fault-child-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function runChild(mode: Mode, variant: Variant): Promise<ChildRun> {
  const envelopeFile = join(workDir, `${mode}-${variant}.envelopes`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CHILD, mode, variant, envelopeFile], {
      cwd: apiDir,
      env: { ...process.env, ...CANARIES },
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child ${mode}/${variant} did not finish:\n${output}`));
    }, CHILD_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      let envelope = "";
      try {
        envelope = readFileSync(envelopeFile, "utf8");
      } catch {
        envelope = "";
      }
      resolve({ code, console: output, envelope });
    });
  });
}

type Runs = Record<Mode, Record<Variant, ChildRun>>;
let runs: Runs;

beforeAll(async () => {
  // All four at once: each exception run waits out the SDK's shutdown flush.
  const [rejectionProduction, rejectionDefault, exceptionProduction, exceptionDefault] =
    await Promise.all([
      runChild("rejection", "production"),
      runChild("rejection", "sdk-default"),
      runChild("exception", "production"),
      runChild("exception", "sdk-default"),
    ]);
  runs = {
    rejection: { production: rejectionProduction, "sdk-default": rejectionDefault },
    exception: { production: exceptionProduction, "sdk-default": exceptionDefault },
  };
});

function leaked(text: string): string[] {
  return Object.values(CANARIES).filter((canary) => text.includes(canary));
}

describe("an unhandled rejection", () => {
  it("keeps the process running, as the SDK's own integration did", () => {
    const before = runs.rejection["sdk-default"];
    const after = runs.rejection.production;
    expect(before.console).toContain("ALIVE_AFTER_FAULT");
    expect(before.code).toBe(0);
    expect(after.console).toContain("ALIVE_AFTER_FAULT");
    expect(after.code).toBe(before.code);
  });

  it("is reported to Sentry as facts and frames, never its message, cause or properties", () => {
    const before = runs.rejection["sdk-default"];
    const after = runs.rejection.production;
    // Control: the SDK's own integration sends and prints the canaries.
    expect(leaked(before.envelope)).toContain(CANARIES.FAULT_MESSAGE_CANARY);
    expect(leaked(before.envelope)).toContain(CANARIES.FAULT_CAUSE_CANARY);
    expect(leaked(before.console)).toContain(CANARIES.FAULT_MESSAGE_CANARY);

    expect(after.envelope).toContain("auto.node.onunhandledrejection");
    expect(after.envelope).toContain('"level":"error"');
    expect(after.envelope).toContain('"unhandledPromiseRejection":true');
    expect(after.envelope).toContain("PrismaClientValidationError");
    expect(after.envelope).toContain("faultQuotingTheCall");
    expect(leaked(after.envelope)).toEqual([]);
  });

  it("prints facts and frames to the console, never the fault's words", () => {
    const after = runs.rejection.production;
    expect(after.console).toContain("PrismaClientValidationError");
    expect(after.console).toContain("model=SlackMessage");
    expect(after.console).toContain("at faultQuotingTheCall");
    expect(leaked(after.console)).toEqual([]);
  });
});

describe("an uncaught exception", () => {
  it("still flushes and exits 1, as the SDK's own integration did", () => {
    const before = runs.exception["sdk-default"];
    const after = runs.exception.production;
    expect(before.code).toBe(1);
    expect(before.console).not.toContain("ALIVE_AFTER_FAULT");
    expect(after.code).toBe(before.code);
    expect(after.console).not.toContain("ALIVE_AFTER_FAULT");
  });

  it("is reported to Sentry as a fatal fact, never its message, cause or properties", () => {
    const before = runs.exception["sdk-default"];
    const after = runs.exception.production;
    // Control: the SDK's own integration sends and prints the canaries.
    expect(leaked(before.envelope)).toContain(CANARIES.FAULT_MESSAGE_CANARY);
    expect(leaked(before.console)).toContain(CANARIES.FAULT_MESSAGE_CANARY);

    expect(after.envelope).toContain("auto.node.onuncaughtexception");
    expect(after.envelope).toContain('"level":"fatal"');
    expect(after.envelope).toContain("PrismaClientValidationError");
    expect(after.envelope).toContain("faultQuotingTheCall");
    expect(leaked(after.envelope)).toEqual([]);
  });

  it("prints facts and frames to the console, never the fault's words", () => {
    const after = runs.exception.production;
    expect(after.console).toContain("PrismaClientValidationError");
    expect(after.console).toContain("at faultQuotingTheCall");
    expect(leaked(after.console)).toEqual([]);
  });
});
