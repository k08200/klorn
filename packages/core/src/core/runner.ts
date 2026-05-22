import { type ChildProcess, spawn } from "node:child_process";
import type { Scenario, Step } from "../scenario/types.js";

/** Raw output captured from an agent run */
export interface RunOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  stepResults: StepResult[];
  /** True if the process was killed due to timeout */
  timedOut?: boolean;
}

/** Result of a single step execution */
export interface StepResult {
  step: Step;
  stdout: string;
  stderr: string;
  success: boolean;
}

/** Maximum buffer size per stream (10MB) */
const MAX_BUFFER = 10 * 1024 * 1024;

/** Run a scenario against the target agent and capture output */
export async function runScenario(scenario: Scenario): Promise<RunOutput> {
  const start = Date.now();

  if (scenario.agent.type === "command") {
    return runCommandAgent(scenario, start);
  }

  throw new Error(
    `Agent type "${scenario.agent.type}" is not supported. Currently only "command" is available.`,
  );
}

async function runCommandAgent(scenario: Scenario, start: number): Promise<RunOutput> {
  const command = scenario.agent.command;
  if (!command) throw new Error("Command agent requires a 'command' field");

  const timeoutSec = scenario.timeout ?? 120;
  if (timeoutSec <= 0) {
    throw new Error(`Invalid timeout: ${timeoutSec}s (must be positive)`);
  }
  const timeout = timeoutSec * 1000;

  let fullStdout = "";
  let fullStderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const stepResults: StepResult[] = [];

  let proc: ChildProcess;
  try {
    proc = spawn("bash", ["-c", command], {
      env: { ...process.env, ...scenario.agent.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to spawn process: ${msg}`);
  }

  // Handle spawn errors (e.g., ENOENT, EACCES)
  let spawnError: Error | null = null;
  proc.on("error", (err) => {
    spawnError = err;
  });

  // Track process exit
  let exited = false;
  let exitCode = 0;
  const exitPromise = new Promise<number>((resolve) => {
    proc.on("close", (code) => {
      exited = true;
      exitCode = code ?? 0;
      resolve(exitCode);
    });
  });

  // Collect output with buffer limits
  proc.stdout?.on("data", (data: Buffer) => {
    if (!stdoutTruncated) {
      fullStdout += data.toString();
      if (fullStdout.length > MAX_BUFFER) {
        fullStdout = fullStdout.slice(0, MAX_BUFFER);
        stdoutTruncated = true;
      }
    }
  });
  proc.stderr?.on("data", (data: Buffer) => {
    if (!stderrTruncated) {
      fullStderr += data.toString();
      if (fullStderr.length > MAX_BUFFER) {
        fullStderr = fullStderr.slice(0, MAX_BUFFER);
        stderrTruncated = true;
      }
    }
  });

  // Wait for process to be ready or exit quickly
  await Promise.race([sleep(500), exitPromise]);

  // Check for spawn errors after initial wait
  if (spawnError) {
    const err = spawnError as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(`Command not found: bash (or command within: ${command})`);
    }
    throw new Error(`Process error: ${err.message}`);
  }

  // Execute steps (skip if process already done)
  for (const step of scenario.steps) {
    const result = await executeStep(proc, step, exited);
    stepResults.push(result);
    fullStdout += result.stdout;
    fullStderr += result.stderr;
  }

  // Wait for process to finish (or terminate it)
  let timedOut = false;
  if (!exited) {
    const result = await terminateProcess(proc, exitPromise, timeout);
    exitCode = result.code;
    timedOut = result.timedOut;
  }

  if (stdoutTruncated || stderrTruncated) {
    fullStderr += "\n[klorn] Warning: output was truncated (exceeded 10MB buffer limit)";
  }

  return {
    stdout: fullStdout,
    stderr: fullStderr,
    exitCode,
    durationMs: Date.now() - start,
    stepResults,
    timedOut,
  };
}

async function executeStep(
  proc: ChildProcess,
  step: Step,
  processExited: boolean,
): Promise<StepResult> {
  switch (step.action) {
    case "send": {
      if (processExited || !proc.stdin?.writable) {
        return {
          step,
          stdout: "",
          stderr: "process already exited, cannot send input",
          success: false,
        };
      }
      try {
        proc.stdin.write(`${step.input ?? ""}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { step, stdout: "", stderr: `Failed to write to stdin: ${msg}`, success: false };
      }
      await sleep(1000);
      return { step, stdout: "", stderr: "", success: true };
    }
    case "wait": {
      const duration = step.duration ?? 1000;
      if (duration < 0) {
        return { step, stdout: "", stderr: `Invalid wait duration: ${duration}ms`, success: false };
      }
      await sleep(duration);
      return { step, stdout: "", stderr: "", success: true };
    }
    case "check_output": {
      return { step, stdout: "", stderr: "", success: true };
    }
    case "check_file": {
      return { step, stdout: "", stderr: "", success: true };
    }
    default:
      return { step, stdout: "", stderr: `Unknown step action: "${step.action}"`, success: false };
  }
}

function terminateProcess(
  proc: ChildProcess,
  exitPromise: Promise<number>,
  timeout: number,
): Promise<{ code: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ code: 137, timedOut: true });
    }, timeout);

    exitPromise.then((code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });

    // Try graceful shutdown
    if (proc.stdin?.writable) {
      proc.stdin.end();
    }
    proc.kill("SIGTERM");
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
