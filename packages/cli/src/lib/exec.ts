import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

/**
 * The only module that starts processes. Every command is an argv array run
 * WITHOUT a shell, so no value (a path, a label, a database name) is ever
 * interpreted as shell syntax. Credentials travel in `env`, never in `args`:
 * argv is readable by every local user through `ps`.
 */

export interface CommandSpec {
  cmd: string;
  args: readonly string[];
  /** Merged over process.env for the child only. */
  env?: Readonly<Record<string, string>>;
  /** Inherited variables removed from the child's environment. */
  unsetEnv?: readonly string[];
  cwd?: string;
}

export interface RunOptions {
  /** Stream this file into the child's stdin. */
  stdinFile?: string;
  /** Stream the child's stdout into this NEW file (created 0600, never overwritten). */
  stdoutFile?: string;
  /** Let the child write straight to the terminal (progress output). */
  inherit?: boolean;
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (spec: CommandSpec, opts?: RunOptions) => Promise<RunResult>;

const EXIT_NOT_FOUND = 127;
const EXIT_TIMEOUT = 124;
const EXIT_SPAWN_FAILED = 126;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const KILL_GRACE_MS = 5_000;
const PRIVATE_FILE_MODE = 0o600;

interface Fds {
  stdin?: number;
  stdout?: number;
  close(): void;
}

/** Opened before spawn so a refusal (EEXIST, ENOENT) fails without starting a child. */
function openFds(opts: RunOptions): Fds {
  const stdin = opts.stdinFile === undefined ? undefined : openSync(opts.stdinFile, "r");
  let stdout: number | undefined;
  try {
    stdout =
      opts.stdoutFile === undefined
        ? undefined
        : openSync(opts.stdoutFile, "wx", PRIVATE_FILE_MODE);
  } catch (err) {
    if (stdin !== undefined) closeSync(stdin);
    throw err;
  }
  return {
    stdin,
    stdout,
    close: () => {
      if (stdin !== undefined) closeSync(stdin);
      if (stdout !== undefined) closeSync(stdout);
    },
  };
}

function childEnv(spec: CommandSpec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env };
  for (const name of spec.unsetEnv ?? []) delete env[name];
  return env;
}

function collect(child: ChildProcess): { stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
  });
  return { stdout: () => stdout, stderr: () => stderr };
}

function armTimeout(child: ChildProcess, timeoutMs: number | undefined, onFire: () => void) {
  if (timeoutMs === undefined) return undefined;
  return setTimeout(() => {
    onFire();
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
  }, timeoutMs);
}

// biome-ignore lint/suspicious/useAwait: async turns a synchronous openSync throw (EEXIST, ENOENT) into a rejection
export const spawnRunner: Runner = async (spec, opts = {}) => {
  const fds = openFds(opts);
  return new Promise<RunResult>((resolve) => {
    const child = spawn(spec.cmd, [...spec.args], {
      cwd: spec.cwd,
      env: childEnv(spec),
      shell: false,
      stdio: [
        fds.stdin ?? "ignore",
        fds.stdout ?? (opts.inherit ? "inherit" : "pipe"),
        opts.inherit ? "inherit" : "pipe",
      ],
    });
    const output = collect(child);
    let settled = false;
    let timedOut = false;
    const timer = armTimeout(child, opts.timeoutMs, () => {
      timedOut = true;
    });
    const finish = (code: number, stderr: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fds.close();
      resolve({ code, stdout: output.stdout(), stderr });
    };
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") finish(EXIT_NOT_FOUND, `${spec.cmd}: command not found`);
      else finish(EXIT_SPAWN_FAILED, `${spec.cmd}: ${err.message}`);
    });
    child.on("close", (code, signal) => {
      if (timedOut) finish(EXIT_TIMEOUT, `${output.stderr()}\n${spec.cmd}: timed out`);
      else finish(code ?? (signal ? 128 : 1), output.stderr());
    });
  });
};

const MIN_SECRET_LENGTH = 4;

/** Mask known secret values (and their URL-encoded form) in text bound for output. */
export function redact(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_SECRET_LENGTH) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      out = out.split(form).join("***");
    }
  }
  return out;
}

/** The last `lines` lines of `text`, for error messages built from tool output. */
export function tail(text: string, lines: number): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}
