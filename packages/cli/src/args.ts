import { parseArgs } from "node:util";
import type { Options } from "./context.js";
import { UsageError } from "./errors.js";

export interface ParsedCli {
  words: string[];
  opts: Options;
  help: boolean;
  /** The long names of the options actually given (for per-command validation). */
  flags: string[];
}

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  "no-backup": { type: "boolean" },
  "i-know": { type: "boolean" },
  "allow-downgrade": { type: "boolean" },
  db: { type: "string" },
  target: { type: "string" },
  label: { type: "string" },
  "compose-file": { type: "string" },
  "env-file": { type: "string" },
  "backup-dir": { type: "string" },
  "api-url": { type: "string" },
  "web-url": { type: "string" },
  timeout: { type: "string" },
} as const;

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError("--timeout must be a positive number of seconds");
  }
  return value;
}

export function parseCli(argv: readonly string[]): ParsedCli {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const v = parsed.values;
  return {
    words: parsed.positionals,
    help: v.help === true,
    flags: Object.keys(v).filter((name) => name !== "help"),
    opts: {
      json: v.json === true,
      yes: v.yes === true,
      noBackup: v["no-backup"] === true,
      iKnow: v["i-know"] === true,
      allowDowngrade: v["allow-downgrade"] === true,
      db: v.db,
      target: v.target,
      label: v.label,
      composeFile: v["compose-file"],
      envFile: v["env-file"],
      backupDir: v["backup-dir"],
      apiUrl: v["api-url"],
      webUrl: v["web-url"],
      timeoutSec: parseTimeout(v.timeout),
    },
  };
}

export const USAGE = `klorn — operations CLI for self-hosted Klorn

Usage:
  klorn doctor [--json]                      read-only health check; exit 1 on any fail
  klorn migrate status [--json]              applied / pending / failed migrations
  klorn migrate deploy [--yes] [--no-backup] back up, then prisma migrate deploy
  klorn backup create [--label <name>]       pg_dump (custom format) + sha256
  klorn backup list [--json]
  klorn backup restore <file> --target <db> [--yes] [--no-backup] [--i-know]
  klorn up                                   docker compose up -d, wait for health
  klorn upgrade <version> [--yes] [--no-backup] [--allow-downgrade]
                                             pull, back up, migrate, restart, verify

Database (--db, --target):
  compose                   the postgres service of docker-compose.selfhost.yml (default)
  env:VAR                   a postgres URL from environment variable VAR
  postgresql://user@host/db a URL WITHOUT a password (use PGPASSWORD or ~/.pgpass)

Options:
  --compose-file <path>     default: <repo>/docker-compose.selfhost.yml
  --env-file <path>         default: <repo>/.env.selfhost
  --backup-dir <path>       default: $KLORN_BACKUP_DIR or ~/klorn-backups
  --api-url <url>           default: $KLORN_API_URL, NEXT_PUBLIC_API_URL, http://localhost:3001
  --web-url <url>           default: $KLORN_WEB_URL, WEB_URL, http://localhost:3000
  --timeout <seconds>       health wait: up and restore (180), upgrade (300)
  -y, --yes                 skip confirmation prompts
  -h, --help

Guide: docs/self-host-cli.md`;
