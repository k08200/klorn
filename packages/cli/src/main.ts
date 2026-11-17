import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCli, USAGE } from "./args.js";
import { backupCreate, backupList, backupPrune } from "./commands/backup.js";
import { doctor } from "./commands/doctor.js";
import { migrateDeploy, migrateStatus } from "./commands/migrate.js";
import { backupRestore } from "./commands/restore.js";
import { up, upgrade } from "./commands/stack.js";
import { buildContext, type Context, type Deps, realDeps } from "./context.js";
import { CliError, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, errorMessage, UsageError } from "./errors.js";
import { runInterruptTasks } from "./lib/cleanup.js";

type Handler = (ctx: Context, arg: string | undefined) => Promise<number>;

interface Command {
  handler: Handler;
  /** How many trailing arguments it takes. */
  args: 0 | 1;
  /** Options that apply to it, besides the global ones. */
  flags: readonly string[];
}

/** Where the stack and its files are: valid for every command. */
const GLOBAL_FLAGS = ["compose-file", "env-file", "backup-dir", "api-url", "web-url"];

const COMMANDS: ReadonlyMap<string, Command> = new Map([
  ["doctor", { handler: doctor, args: 0, flags: ["json", "db"] }],
  ["migrate status", { handler: migrateStatus, args: 0, flags: ["json", "db"] }],
  [
    "migrate deploy",
    { handler: migrateDeploy, args: 0, flags: ["db", "yes", "no-backup", "i-know"] },
  ],
  ["backup create", { handler: backupCreate, args: 0, flags: ["db", "label", "json"] }],
  ["backup list", { handler: backupList, args: 0, flags: ["json"] }],
  ["backup prune", { handler: backupPrune, args: 0, flags: ["keep", "older-than", "yes", "json"] }],
  [
    "backup restore",
    { handler: backupRestore, args: 1, flags: ["target", "yes", "no-backup", "i-know", "timeout"] },
  ],
  ["up", { handler: up, args: 0, flags: ["timeout"] }],
  [
    "upgrade",
    { handler: upgrade, args: 1, flags: ["yes", "no-backup", "allow-downgrade", "timeout"] },
  ],
]);

function resolveCommand(
  words: string[],
  flags: readonly string[],
): { handler: Handler; arg: string | undefined } {
  for (const length of [2, 1]) {
    if (words.length < length) continue;
    const name = words.slice(0, length).join(" ");
    const command = COMMANDS.get(name);
    if (!command) continue;
    const rest = words.slice(length);
    if (rest.length > command.args) throw new UsageError(`unexpected argument: ${rest.at(-1)}`);
    // An option meant for another command is an error, never silently ignored:
    // `backup create --target X` must not quietly back up the default database.
    const stray = flags.find((f) => !GLOBAL_FLAGS.includes(f) && !command.flags.includes(f));
    if (stray) throw new UsageError(`--${stray} does not apply to \`klorn ${name}\``);
    return { handler: command.handler, arg: rest[0] };
  }
  throw new UsageError(`unknown command: ${words.join(" ")}`);
}

export async function run(argv: readonly string[], deps: Deps): Promise<number> {
  try {
    const { words, opts, help, flags } = parseCli(argv);
    if (help || words.length === 0 || words[0] === "help") {
      deps.io.out(USAGE);
      return EXIT_OK;
    }
    const { handler, arg } = resolveCommand(words, flags);
    return await handler(buildContext(deps, opts), arg);
  } catch (err) {
    if (err instanceof UsageError) {
      deps.io.err(`klorn: ${err.message}\nrun \`klorn help\` for usage`);
      return EXIT_USAGE;
    }
    if (err instanceof CliError) {
      deps.io.err(`klorn: ${err.message}`);
      return EXIT_FAILURE;
    }
    deps.io.err(`klorn: unexpected error: ${errorMessage(err)}`);
    return EXIT_FAILURE;
  }
}

/** packages/cli/src/main.ts → the repository root. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function main(argv: readonly string[]): Promise<number> {
  return run(argv, realDeps(REPO_ROOT));
}

/** SIGINT/SIGTERM: remove temporary credentials and half-written files (bin/klorn.mjs). */
export function onSignal(): void {
  runInterruptTasks();
}
