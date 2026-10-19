# Rotating the database password (and backing it up)

Written after the 2026-08-04 outage, which was caused entirely by doing this
in the wrong order. Production was down for roughly 40 minutes. Following the
order below makes the same rotation a ~5 minute, no-downtime operation.

Production database: **Supabase**, region `ap-northeast-2`, project ref
`wqqjldncizvmandepobc`. The app connects through the **session pooler**
(port 5432), which is the mode Prisma migrations need.

## Why order matters

Render does not kill the running container until a replacement is healthy.
So if you change the password in Supabase *first*:

1. The old container keeps its old `DATABASE_URL` and keeps calling the
   database — the schedulers alone do this every 30–60s.
2. Every one of those calls is now an authentication failure.
3. Supabase's pooler arms a circuit breaker and refuses **all** new
   connections, including correctly-credentialed ones.
4. The replacement container therefore cannot start.
5. Render keeps the old container alive — go to 1.

A restart does not break this loop, because the old container is the thing
poisoning the gate. Only stopping it does.

(The app now rides out a short breaker window on its own — `withDbRetry`
treats `ECIRCUITBREAKER` as retryable since #1005 — but do not lean on that.
Following this order means the breaker never arms.)

## Rotating the password

1. **Render → `klorn-api` → Settings → Suspend Web Service.**
   This stops the old container, so nothing is holding the stale credential.
2. **Supabase → Settings → Database → Reset database password.**
   Copy the new password immediately — it is not viewable again.
3. **Render → `klorn-api` → Environment → `DATABASE_URL`.**
   Replace **only** the password (between `:` and `@`). Leave the username
   `postgres.<project-ref>` alone — the project ref suffix is required by the
   pooler. Save.
4. **Render → Settings → Resume Web Service.**
5. Verify: open `https://api.klorn.ai/api/health`. You want
   `"db":"connected"` **and a small `uptime`** — a large uptime means you are
   still talking to the old container and nothing was replaced.

## Backup

Supabase's free tier has no automated backups. The **DB backup** workflow
(`.github/workflows/db-backup.yml`) takes one every night at 03:17 KST:

1. `pg_dump` of the public schema through the session pooler.
2. A restore into a throwaway Postgres 17 that stops on any error.
3. age encryption, then an artifact kept 14 days.

The repository is public, so only ciphertext is uploaded and the log prints
verdicts, never data or counts. A failed night fails the job, and GitHub
emails the failure.

**Setup (once):**

- **Secret `BACKUP_DATABASE_URL`.** The session pooler URL: port 5432, the
  same host Render uses, `?sslmode=require`. Not the direct host, which is
  IPv6 only, and not the transaction pooler on 6543.
- **Variable `BACKUP_AGE_RECIPIENT`.** The age public key (`age1...`).
- **Private key.** It lives only with the operator, never in GitHub or in the
  repo. If it is lost, the backups cannot be read: keep a copy in a password
  manager. With the secret or the variable missing, the job fails rather than
  skipping.

**Restore from a nightly backup:**

```bash
gh run list --repo k08200/klorn --workflow "DB backup" --status success --limit 1
```

```bash
gh run download <run-id> --repo k08200/klorn --dir ./klorn-backup
```

```bash
age --decrypt --identity /path/to/klorn-db-backup.agekey --output klorn.dump ./klorn-backup/*/*.dump.age
```

The dump holds the public schema only, and it re-creates `public`, which
every database already has. Leave that one entry out of the restore list:

```bash
pg_restore --list klorn.dump | grep -v -E '^[0-9]+; [0-9]+ [0-9]+ SCHEMA - public ' > restore.toc
```

```bash
pg_restore --no-owner --no-privileges --exit-on-error --use-list=restore.toc --dbname="<target url>" klorn.dump
```

The decrypted dump is real user data: mail bodies, encrypted tokens and
addresses. Keep it out of the repo directory and delete it once you are done.

### Manual dump (fallback)

Use this when the workflow cannot run. Every detail below cost a failed
attempt during the first drill (2026-08-04); the obvious-looking version of
each one does not work:

- **Use the pooler, not the direct host.** `db.<ref>.supabase.co` resolves
  over IPv6 only, so it fails inside Docker with "could not translate host
  name". The session pooler (port 5432, the same URL Render uses) is IPv4 and
  is fine for `pg_dump`. Only *transaction* mode (6543) is unsuitable.
- **Match the server's major version.** Production runs Postgres **17**;
  `pg_dump` 16 aborts with "server version mismatch" rather than dumping.
- **Pipe to stdout instead of mounting a volume.** `-v $PWD:/out` collides
  with the postgres image's entrypoint; `--entrypoint pg_dump` plus a shell
  redirect avoids both problems.
- **Paste these one block at a time, without the comments.** zsh does not
  enable `interactivecomments`, so a pasted `# 1) …` line is a parse error.
  A multi-line paste that fails halfway silently continues to the next
  command, which is how the first drill skipped a step and then reported a
  missing database.

```bash
cd ~/Downloads/klorn
docker run --rm --entrypoint pg_dump postgres:17 \
  "postgresql://postgres.<ref>:<password>@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require" \
  --no-owner --no-privileges -Fc > klorn-backup.dump
ls -lh klorn-backup.dump
```

A zero-byte file means it failed; read the error rather than continuing. The
2026-08-04 dump of a 383 MB database was 82 MB.

The dump is real user data: mail bodies, encrypted tokens and addresses.
`*.dump` is gitignored, but keep it out of the repo directory anyway and
delete it once the drill is done.

## Restore drill

A dump you have never restored is not a backup. Restore into a throwaway
local database — production is untouched. Run each block separately:

```bash
docker rm -f restore-test 2>/dev/null
docker run -d --name restore-test -e POSTGRES_PASSWORD=x -p 5433:5432 postgres:17
```

```bash
until docker exec restore-test pg_isready -U postgres >/dev/null 2>&1; do sleep 2; done; echo READY
```

```bash
docker exec restore-test createdb -U postgres testdb
docker run --rm -i --network host --entrypoint pg_restore -e PGPASSWORD=x postgres:17 -h localhost -p 5433 -U postgres -d testdb --no-owner < klorn-backup.dump
docker exec -e PGPASSWORD=x restore-test psql -U postgres -d testdb -c 'SELECT count(*) AS users FROM "User";'
```

`pg_restore` will report a few errors about `supabase_vault` — that extension
does not exist outside Supabase. They are counted as "errors ignored" and do
not affect application tables. The row count is the check that matters.

```bash
cd ~/Downloads/klorn/packages/api
DATABASE_URL="postgresql://postgres:x@localhost:5433/testdb" ./node_modules/.bin/prisma migrate status
```

**This last command is the point of the exercise.** "The dump exists" and
"the app boots on it" are different claims, and it is the second one that
fails during a real incident. `Database schema is up to date!` is a pass.

(This machine has no `npx`; call the local binary directly.)

```bash
docker rm -f restore-test
```

Record the result in `docs/rls-rollout.md`'s prerequisite section — a drill
nobody wrote down gets re-argued the next time someone asks whether restores
work.

## If the app will not start

Since #1005 the startup path prints its cause before exiting; look for
`[STARTUP] fatal: server did not start —` in the Render logs. Before that
change the process discarded the error and exited silently, which is why the
2026-08-04 outage took half an hour to diagnose. If you ever see a bare
`Exited with status 1` with no preceding line, that logging has regressed.
