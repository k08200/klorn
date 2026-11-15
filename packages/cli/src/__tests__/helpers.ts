import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext, type Context, type Deps, type Options } from "../context.js";
import type { CommandSpec, RunOptions, RunResult } from "../lib/exec.js";

export interface RecordedCall {
  argv: string[];
  spec: CommandSpec;
  opts: RunOptions | undefined;
}

export type Handler = (call: RecordedCall) => Partial<RunResult> | undefined;

export interface TestHarness {
  ctx: Context;
  calls: RecordedCall[];
  out: string[];
  err: string[];
  answers: string[];
  repoRoot: string;
  backupDir: string;
  /** argv strings ("docker compose ... exec -T postgres pg_dump ...") in call order. */
  commands(): string[];
}

export const KEY_32 = Buffer.alloc(32, 7).toString("base64");

export const GOOD_ENV = [
  "POSTGRES_PASSWORD=a-strong-postgres-password",
  `JWT_SECRET=${"j".repeat(64)}`,
  `TOKEN_ENCRYPTION_KEY=${KEY_32}`,
  "GOOGLE_CLIENT_ID=123-abc.apps.googleusercontent.com",
  "GOOGLE_CLIENT_SECRET=GOCSPX-abcdefghijklmnopqrstuvwx",
  "ANTHROPIC_API_KEY=sk-ant-api03-zzzzzzzzzzzzzzzzzzzz",
  "",
].join("\n");

export const HEALTH_OK = {
  status: "ok",
  db: "connected",
  timestamp: "2026-11-15T08:30:00.000Z",
  uptime: 5,
  version: "0.4.0",
  commit: null,
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

export interface HarnessInput {
  opts?: Partial<Options>;
  handler?: Handler;
  fetch?: (url: string) => Response | Promise<Response>;
  envFile?: string | null;
  shellEnv?: Record<string, string>;
  interactive?: boolean;
  answers?: string[];
  nowMs?: number;
}

/** A context wired to fakes: no process is started, no socket opened. */
export function harness(input: HarnessInput = {}): TestHarness {
  const repoRoot = mkdtempSync(join(tmpdir(), "klorn-cli-repo-"));
  const backupDir = join(mkdtempSync(join(tmpdir(), "klorn-cli-bk-")), "backups");
  writeFileSync(join(repoRoot, "docker-compose.selfhost.yml"), "services: {}\n");
  if (input.envFile !== null) {
    writeFileSync(join(repoRoot, ".env.selfhost"), input.envFile ?? GOOD_ENV, { mode: 0o600 });
  }
  mkdirSync(join(repoRoot, "packages/api/prisma/migrations"), { recursive: true });
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(input.answers ?? [])];
  let clock = input.nowMs ?? Date.parse("2026-11-15T08:30:00.000Z");
  const deps: Deps = {
    runner: async (spec, opts) => {
      const call = { argv: [spec.cmd, ...spec.args], spec, opts };
      calls.push(call);
      return { code: 0, stdout: "", stderr: "", ...(input.handler?.(call) ?? {}) };
    },
    fetch: (async (url: string | URL | Request) => {
      if (!input.fetch) throw new TypeError("fetch failed: ECONNREFUSED");
      return input.fetch(String(url));
    }) as typeof fetch,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      interactive: input.interactive ?? false,
      ask: async () => answers.shift() ?? "",
    },
    nowMs: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    env: input.shellEnv ?? {},
    homeDir: repoRoot,
    cwd: repoRoot,
    repoRoot,
  };
  const opts: Options = {
    json: false,
    yes: false,
    noBackup: false,
    iKnow: false,
    allowDowngrade: false,
    backupDir,
    ...input.opts,
  };
  return {
    ctx: buildContext(deps, opts),
    calls,
    out,
    err,
    answers,
    repoRoot,
    backupDir,
    commands: () => calls.map((c) => c.argv.join(" ")),
  };
}

/** True when the call runs `tool` (pg_dump, psql, ...) as the executed program. */
export const runs = (call: RecordedCall, tool: string) => call.argv.includes(tool);

/** Simulate pg_dump writing an archive to the requested stdout file. */
export function writeDump(call: RecordedCall, bytes = "PGDMP-fake-archive"): Partial<RunResult> {
  if (call.opts?.stdoutFile)
    writeFileSync(call.opts.stdoutFile, bytes, { flag: "wx", mode: 0o600 });
  return {};
}
