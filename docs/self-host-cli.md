# `klorn` — the self-host operations CLI

`klorn` checks, backs up, migrates and upgrades a self-hosted Klorn. It is an
operator tool on top of what already exists: the official
[`docker-compose.selfhost.yml`](../docker-compose.selfhost.yml), the published
`ghcr.io/k08200/klorn-api` / `klorn-web` images, `pg_dump`/`pg_restore`, and
`prisma migrate`. Postgres stays the source of truth; the CLI keeps no state of
its own besides the backup files it writes.

It is for **self-hosters**. It is not how the hosted klorn.ai is operated.

- [Install and run](#install-and-run)
- [Commands](#commands)
- [Which database: `--db` and `--target`](#which-database---db-and---target)
- [`klorn doctor`](#klorn-doctor)
- [`klorn migrate`](#klorn-migrate)
- [`klorn backup`](#klorn-backup) — and the [restore safety rules](#restore-safety-rules)
- [`klorn up` and `klorn upgrade`](#klorn-up-and-klorn-upgrade)
- [Exit codes](#exit-codes)

## Install and run

Requirements: Node 22+, pnpm (`corepack enable`), and for the compose path
Docker with Compose v2. The CLI lives in this repository (`packages/cli`); it
is not published to npm.

```bash
git clone https://github.com/k08200/klorn.git
cd klorn
pnpm install --filter @klorn/cli      # small: the CLI only needs tsx
pnpm klorn help
```

Run it from the repository root as `pnpm klorn <command>` (or
`node packages/cli/bin/klorn.mjs <command>`). By default it uses
`docker-compose.selfhost.yml` and `.env.selfhost` next to it.

On the managed-Postgres path (Render, Neon, your own Postgres) two more things
are needed: the PostgreSQL client tools on the machine that runs the CLI
(`pg_dump`, `pg_restore`, `psql`, at least the server's major version), and
`pnpm install --filter @klorn/api` if you use `klorn migrate deploy` (it runs
that checkout's prisma).

## Commands

| Command | What it does |
| --- | --- |
| `klorn doctor [--json]` | Read-only checks: env, Docker, Postgres, `pg_dump`, migrations, disk, API, clock, web. Exit 1 on any fail. |
| `klorn migrate status [--json]` | Applied / pending / failed migrations. Exit 1 unless up to date. |
| `klorn migrate deploy [--yes] [--no-backup]` | Back up, then `prisma migrate deploy`. |
| `klorn backup create [--label <name>]` | `pg_dump` (custom format) into the backup directory, with a sha256. |
| `klorn backup list [--json]` | The backups in the backup directory, newest first. |
| `klorn backup prune [--keep <N>] [--older-than <days>] [--yes] [--json]` | Retention: delete old backups. A dry run unless `--yes`; the newest backup is never deleted. |
| `klorn backup restore <file> --target <db> [--yes] [--no-backup] [--i-know]` | Replace the target's Klorn tables with a dump. |
| `klorn up` | `docker compose up -d`, then wait until `/api/health` is ok. |
| `klorn upgrade <version> [--yes] [--no-backup] [--allow-downgrade]` | Pull, back up, migrate, restart, and verify a release. |

Common options: `--compose-file`, `--env-file`, `--backup-dir` (default
`$KLORN_BACKUP_DIR`, else `~/klorn-backups`), `--api-url` (default
`$KLORN_API_URL`, else `NEXT_PUBLIC_API_URL` from the env file, else
`http://localhost:3001`), `--web-url` (default `$KLORN_WEB_URL`, else
`WEB_URL`, else `http://localhost:3000`), `--timeout <seconds>` (health wait:
`up` and `restore` 180, `upgrade` 300), `-y/--yes` (skip a confirmation
prompt; for `backup prune` it is what makes the deletion real).

## Which database: `--db` and `--target`

| Value | Meaning |
| --- | --- |
| `compose` (default) | The `postgres` service of the compose stack. Tools run inside that container (`docker compose exec -T postgres …`) over its local socket, so no credential passes through the CLI at all. |
| `env:VAR` | A postgres URL read from environment variable `VAR` (your shell first, then the env file). Example: `--db env:DATABASE_URL`. |
| `postgresql://user@host:5432/db` | A URL **without a password**. libpq finds the password in `PGPASSWORD` or `~/.pgpass`. |

A URL with a password on the command line is refused: every local user can
read a process's arguments with `ps`. For the same reason the CLI never puts a
credential into the arguments of anything it runs. With a URL target it hands
host, port and user to `pg_dump`/`pg_restore`/`psql` in `PG*` environment
variables and the password in a temporary `0600` pgpass file that is deleted
after each call; prisma gets `DATABASE_URL` in its environment.

## `klorn doctor`

It changes nothing: no write, no migration, no restart. (On the compose path
the migrations check lists the api image's migrations with a one-off
`docker compose run --rm api`, which pulls the image if it is missing.) One
line per check:

```
PASS  env.file              /srv/klorn/.env.selfhost
PASS  env.JWT_SECRET        set (64 chars)
FAIL  env.TOKEN_ENCRYPTION_KEY  set, but decodes to 24 bytes — must be exactly 32 (base64)
PASS  postgres              reachable at compose postgres (klorn) (PostgreSQL 16.4)
WARN  migrations            1 pending (next 20261115010000_org_audit_event_created_at_index)
...
doctor: 12 pass, 1 warn, 1 fail, 0 skip
```

- **env.file** — present; a warn when other users can read it (`chmod 600`).
- **env** — the variables the API and the compose file require
  (`POSTGRES_PASSWORD`, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY` or a keyring,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, one LLM provider) and
  `CORS_ORIGINS` covering `WEB_URL`. Values are never printed — only
  set/missing, a length, a decoded byte count or a well-known prefix
  (`GOCSPX-`). The untouched placeholders from `.env.selfhost.example` fail.
- **docker / compose.file** — compose path only.
- **postgres** — reachable, and its version. On a URL target,
  **postgres.tls** warns when a remote host has no `sslmode=require` (libpq
  would otherwise accept a cleartext connection).
- **pg_dump** — present, and not older than the server (an older `pg_dump`
  refuses to dump a newer server).
- **migrations** — failed is a fail; pending, or applied-but-unknown (the
  database is ahead of this code), is a warn.
- **disk** — free space where backups go, against the database size.
- **api** — `/api/health` answers `status: ok` (a `degraded` body is a fail);
  shows the version and commit.
- **clock** — the API's clock against this machine's (warn beyond 30 s).
- **web** — the web app answers.

`--json` prints `{ "ok", "summary", "checks": [{ "id", "status", "detail" }] }`
on stdout. Exit 1 when any check fails.

## `klorn migrate`

`status` reads Prisma's own bookkeeping table (`_prisma_migrations`) and
compares it with the migrations the code ships — on the compose path, the ones
inside the configured api image; on a URL target, this checkout's
`packages/api/prisma/migrations`.

`deploy` applies them with `prisma migrate deploy` — inside a one-off api
container on the compose path, with this checkout's prisma on a URL target. It
refuses while a migration is marked failed (inspect it and use
`prisma migrate resolve` first), asks for confirmation unless `--yes`, and
takes a `pre-migrate` backup first unless `--no-backup`.

On the compose path the api also runs `prisma migrate deploy` itself on every
boot (`packages/api/scripts/start.sh`), so a plain restart migrates too;
`klorn upgrade` runs it explicitly so a failing migration stops the upgrade
before the running api is replaced.

## `klorn backup`

```bash
pnpm klorn backup create --label before-dns-change
pnpm klorn backup list
```

- Format: `pg_dump --format=custom` of the `public` schema plus `pg_trgm` —
  the same selection as the hosted backup workflow, so a dump also restores
  into a managed Postgres that carries extra schemas.
- Name: `klorn-<UTC timestamp>[-<label>].dump`, plus
  `klorn-….dump.sha256` (`sha256sum -c` compatible).
- Where: `--backup-dir`, `$KLORN_BACKUP_DIR`, or `~/klorn-backups` — outside
  the repository on purpose (`git clean -fdx` must not be able to delete it).
- Permissions: the directory is created `0700`, every dump `0600`. A dump is
  real user data — mail metadata and the encrypted OAuth tokens. An existing
  directory owned by another user, or writable by group/others, is refused.
- A dump is written to `….partial` and renamed only after `pg_dump` succeeded
  and the checksum is written, so a failed backup never looks like a good one.

**A dump alone is not a full backup.** Stored OAuth tokens are encrypted with
`TOKEN_ENCRYPTION_KEY` from `.env.selfhost`. Restore a dump under a different
key and every Google connection has to be reconnected. Keep a copy of
`.env.selfhost` too — somewhere other than next to the dumps.

A nightly cron entry, for example, with retention after it:

```cron
15 3 * * * cd /srv/klorn && pnpm -s klorn backup create --label nightly >> /var/log/klorn-backup.log 2>&1
45 3 * * * cd /srv/klorn && pnpm -s klorn backup prune --keep 14 --older-than 30 --yes >> /var/log/klorn-backup.log 2>&1
```

### Retention: `klorn backup prune`

```bash
pnpm klorn backup prune --keep 14                     # dry run: lists what would go
pnpm klorn backup prune --keep 14 --older-than 30 --yes
```

At least one rule is required.

- `--keep <N>` — keep the N newest backups.
- `--older-than <days>` — delete only backups older than that, by the
  timestamp in the file name (not the file's mtime, which a copy resets).
- With both, a backup is deleted only when **both** select it: it is beyond
  the N newest **and** older than the cutoff. Either rule alone protects it.
  `--keep 14 --older-than 30` means "at least 14 backups, and nothing younger
  than 30 days".
- **Dry run by default.** Without `--yes` it prints what it would delete and
  the space it would free, and deletes nothing.
- **The newest backup is never deleted**, whatever the rules say.
- Labels get no special treatment: an old `pre-upgrade` or `pre-restore` dump
  goes like any other, so leave a margin.
- It touches only `klorn-<timestamp>[-<label>].dump` regular files and their
  `.sha256` sidecars in the backup directory. Other files, a `.partial` dump
  (a backup in progress), a sidecar with no dump, directories and symlinks
  are left alone; a symlink is never followed. A backup whose sidecar is not a
  regular file is skipped and reported, not half-deleted.
- It refuses a backup directory that is `/` or a home directory, and one that
  other users can write to.
- The dump is deleted first, then its sidecar. Any file it fails to delete is
  reported on stderr (and in `--json` under `errors`), the rest continue, and
  the exit code is 1.

`--json` prints `{ dir, dryRun, rules, total, kept, candidates, candidateBytes,
deleted, freedBytes, errors }`; `bytes` counts the dump and its sidecar.

### Restore safety rules

`klorn backup restore` replaces **everything in the target's `public`
schema** with the dump (the Klorn tables live there). It is guarded in this
order:

1. **`--target` is always explicit** — there is no default target for a
   restore. `--target compose` for the compose stack, or `env:VAR` / a
   password-less URL. (`--db` is not accepted here, so a restore can never
   fall back to a default.)
2. **Klorn's hosted production database is refused.** A target whose URL,
   user, host or database contains the hosted project ref
   (`wqqjldncizvmandepobc`, %-escaped or not) stops here unless you add
   `--i-know`. `klorn migrate deploy` has the same guard.
3. **The checksum must match.** A dump whose `.sha256` disagrees is refused,
   and so is a dump with no `.sha256` (one taken by hand, say). If you trust
   such a file, create the sidecar yourself:
   `sha256sum klorn-….dump > klorn-….dump.sha256`.
4. **The archive must read.** `pg_restore --list` has to succeed first.
5. **Confirmation.** You type the target database's name. In scripts, `--yes`
   (together with the explicit `--target`) replaces the prompt; with no
   terminal and no `--yes` it refuses instead of hanging.
6. **Writers stop.** On the compose path the CLI stops the `api` service
   (running or crash-looping) before anything else touches the database.
   On a URL target, stop every Klorn API that writes to it yourself.
7. **A pre-restore snapshot** of the target is taken (`…-pre-restore.dump`)
   unless `--no-backup`, and the dump's checksum is verified again right
   before it is used.
8. **All or nothing.** The dump is rendered to a SQL script (a transient
   `0600` file in the backup directory, about the size of the uncompressed
   data) and applied by `psql --single-transaction`, starting with
   `DROP SCHEMA public CASCADE`. Dropping the whole schema matters for
   rollbacks: tables a newer migration added would otherwise survive and
   block the restore. Any error rolls everything back and leaves the target
   as it was.
9. **The api comes back.** On the compose path the CLI brings `api` up again
   with `docker compose up -d --no-deps api` — also when the restore failed —
   so it runs the image `KLORN_VERSION` pins, then waits until `/api/health`
   answers `ok` (the api applies newer migrations on boot).

If you interrupt a restore (Ctrl-C), the transaction rolls back, temporary
files are removed, and the CLI tells you if the api was left stopped — start
it with `pnpm klorn up`.

Restore as the same database role the API connects with (on the compose path
that is automatic): the re-created schema and its tables belong to the role
that ran the restore. Only restore dumps you made yourself — a dump is SQL that
runs with the restoring role's rights.

## `klorn up` and `klorn upgrade`

`klorn up` refuses to start a stack that docker compose or the API would
refuse (the env checks of `doctor`; a missing LLM provider is only a warning,
since the API starts without one), then runs `docker compose up -d` and waits
until `/api/health` answers `ok`.

`klorn upgrade 0.4.1` (a leading `v` is fine; `0.4` and `latest` also work):

1. Checks the env and reads the running version from `/api/health`. Going
   backwards (`0.5.0` → `0.4.1`, or `0.3` while `0.4.x` runs) is refused
   unless `--allow-downgrade` — migrations only go forward; restore a backup
   from the older version instead.
2. Asks for confirmation (or `--yes`).
3. `docker compose pull api web` with `KLORN_VERSION=0.4.1`.
4. Makes sure `postgres` is up, then takes a `pre-upgrade-0.4.1` backup
   (unless `--no-backup`).
5. Runs `prisma migrate deploy` in a one-off container of the **new** api
   image. The old api keeps serving (Klorn migrations are additive). If this
   fails the upgrade stops here, nothing is restarted, and the rollback steps
   are printed.
6. Pins `KLORN_VERSION=0.4.1` in `.env.selfhost` — the compose file reads it
   for both image tags, so a later `docker compose up` stays on this version.
7. `docker compose up -d --force-recreate api web`.
8. Polls `/api/health` until it answers `ok` from the new process — and, for an
   exact `X.Y.Z`, reports that version (`--timeout`, default 300 s).

Rolling back means the previous pin first, then the pre-upgrade backup — the
restore brings the api back up on whatever the pin says. The CLI prints both
steps when an upgrade fails (the previous pin is the old `KLORN_VERSION`, or
the version that was running when nothing was pinned):

```bash
# 1. set KLORN_VERSION=0.4.0 (the previous value) in .env.selfhost
# 2.
pnpm klorn backup restore '/home/you/klorn-backups/klorn-…-pre-upgrade-0.4.1.dump' --target compose
```

Writes that reach the old api between the pre-upgrade backup and the restart
are not in that backup.

If the new api comes up healthy but reports a different version than the tag
you asked for, `upgrade` says so instead of suggesting a rollback: the image's
package version and its tag disagree, and nothing is broken.

`upgrade` pulls published images. If you switched a service to its `build:`
block (a source build, for example to bake a different `NEXT_PUBLIC_API_URL`
into the web bundle), upgrade by rebuilding instead — see
[Updating](self-hosting.md#updating).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success (doctor: no fail; migrate status: up to date). |
| 1 | A check failed, a step failed, or the CLI refused (missing confirmation, guard). |
| 2 | Usage error: unknown command or flag, malformed value. |
