# Row-Level Security rollout

Tenant isolation is enforced in application code today (`where: { userId }`).
A single missing filter is a cross-tenant leak with no database backstop — a
class of bug that has shipped here before (the `20260625000000_scope_unique_
constraints_by_user` migration fixed three tables that had global unique
constraints). Postgres RLS makes isolation an invariant the database enforces,
not one every query author must remember.

This is a **staged** rollout, and the staging is gated on a tested restore
path (done, 2026-08-04) *and* on the app connecting as a role that RLS can
actually constrain (not yet true — see below).

## 2026-10-03: the last 19 tables, and the Data API

**Found.** Supabase's security advisor reported ERROR `rls_disabled_in_public`
for 19 tables (read-only check on production, 2026-10-03). Supabase serves the
`public` schema over its REST API as the roles `anon` and `authenticated`, and
both held SELECT, INSERT and DELETE on those tables. Anyone holding the
project's anon key could read or change them. The app never uses that API.

The rest of this document is about a missed `where: { userId }` in our own
code. This was a different door: a role we never use, reaching the tables from
outside. RLS that is inert for the app's role is still what keeps that role out.

**Fixed by** `20261010010000_enable_rls_remaining_tables`. ENABLE only, never
FORCE, so nothing changes for the running app.

| Tables | Policies | Why |
| --- | --- | --- |
| ApiKey, ContactDossier, ImapMovedMessage, LlmUsageLog, McpWriteAudit, PmfResponse, ScreenerDecision, SenderLabel, SentMessage, Team, ThreadBrief | `_tenant_isolation` on `"userId"`, `_system_bypass` | The standard pair. `LlmUsageLog."userId"` is nullable: a NULL row is a system call and is reachable through the bypass only. |
| Message, ConversationSummary, CommitmentPath | `_tenant_isolation` through the parent (`Conversation`, `Commitment`), `_system_bypass` | No `"userId"`, but the parent has one, and tenant-scoped handlers read them with the parent. Bypass-only would return zero rows to those handlers once RLS binds. |
| GlobalCostLedger, OntologyProposal, Waitlist, WebhookEvent | `_system_bypass` only | No owning user. Reach them with `withSystem`. |
| `_prisma_migrations` | none | RLS with no policy denies every role that neither owns the table nor bypasses RLS. `prisma migrate deploy` runs as the owner. |

The same migration revokes every table privilege from `anon` and
`authenticated` on every table in `public`, the ones that already had RLS
included, and removes both roles from the default privileges so that a table
created by a later migration is not granted to them. It goes table by table
over the tables the migrating role owns. `REVOKE ... ON
ALL TABLES IN SCHEMA public` is an error, not a warning, when the schema holds
one relation that role has no privilege on, and the error would roll back the
whole migration.

The policies trust a setting the connection supplies. That holds for our own
connection. It does not hold for a connection that can run `SET`: on a scratch
database with the grants left in place, `anon` set `app.bypass_rls` itself and
read every row. Without a privilege there is nothing left to bypass, and
`TRUNCATE`, which RLS never covers, goes with it. `service_role`, `postgres`
and `klorn_app` are not touched. Sequences and functions are left alone: the
migrations create none of their own (the only functions in `public` on a
scratch deploy are `pg_trgm`'s).

Every count of "43 tables" below is as measured on 2026-08-05. After this
migration every table in `public` has RLS: each model's table with its
policies, and `_prisma_migrations` with none.

### New tables ship with RLS

`packages/api/src/__tests__/rls-coverage-guard.test.ts` reads `schema.prisma`
and fails when a model's table is not left with RLS enabled, a `_system_bypass`
policy and, if it has a `userId` field, a `_tenant_isolation` policy. It
compares the policy's condition too, so a policy with the right name and
`USING (true)` fails. The failure prints the lines to add to the migration that
creates the table:

```sql
ALTER TABLE "Thing" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Thing_tenant_isolation" ON "Thing" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "Thing_system_bypass" ON "Thing" USING (current_setting('app.bypass_rls', true) = 'on');
```

It also fails on a later `DISABLE` or `DROP POLICY`. A table with no `userId`
gets the bypass policy only, unless it is listed in `PARENT_SCOPED` in that
file, which asks for a tenant policy through its parent. A table that must have
no RLS goes in `RLS_EXEMPT_MODELS`, with the reason.

### Check the database after the deploy

The test reads migration text. It cannot tell whether production ran it, and
there is a path where production does not. `scripts/start.sh` falls back to
baselining when `prisma migrate deploy` fails: if `prisma migrate diff` finds no
difference between the live database and `schema.prisma`, it marks every
migration as applied. Prisma's diff does not see RLS, policies or grants, so a
migration made only of those always passes that check. Reproduced on a scratch
database on 2026-10-03, running the script's steps by hand: a reader held a lock
on `"Message"` past the 5 s `lock_timeout`, the migration failed and rolled
back, and the fallback recorded it as applied with 19 tables still open.

So after deploying any migration that only changes RLS or grants, run this as
`postgres`. The first two queries must return no rows, and the third must not
name `anon` or `authenticated` in a row whose creator is `postgres`:

```sql
SELECT c.relname FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND NOT c.relrowsecurity;

SELECT grantee, count(*) FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated') GROUP BY grantee;

SELECT pg_get_userbyid(defaclrole) AS creator, defaclnamespace::regnamespace AS schema, defaclacl
FROM pg_default_acl
WHERE defaclobjtype = 'r' AND defaclnamespace IN (0, 'public'::regnamespace);
```

If the first two return rows, run the migration file by hand inside
`BEGIN; … COMMIT;`. Every statement in it can run twice. A table in `public`
that `postgres` does not own keeps its grants and shows up in the second query:
the migration leaves it alone.

The third query has only been run on a scratch database built to copy
Supabase's default privileges. The migration removes the two roles from the
entry for schema `public`. If production still names either of them, in that
entry or in one with schema `-`, tables created by later migrations are still
granted to them and depend on the guard test alone.

## The blocker: the app's role bypasses RLS unconditionally

Measured against production on 2026-08-04:

```sql
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
-- rolsuper = false, rolbypassrls = TRUE
```

The app connects as `postgres` (the pooler username `postgres.<ref>` maps to
that role), and that role bypasses RLS for **two independent reasons**:

| Reason | Fixed by `FORCE`? |
| --- | --- |
| It **owns** the tables — Prisma migrations run as it | yes |
| It has the **`BYPASSRLS`** attribute | **no** |

`BYPASSRLS` outranks `FORCE`. So the original plan below — "FORCE each table
once its call sites are routed" — **would have done nothing**, silently: no
error, no denied row, just policies that never evaluate. Any canary written
against that state would have been measuring a no-op.

Do **not** try to fix this with `ALTER ROLE postgres NOBYPASSRLS`. On Supabase
`postgres` is not a superuser (so it likely cannot alter its own attribute),
and Supabase's own internals — dashboard, PostgREST, extensions — run as that
role.

### Verified end to end on production, 2026-08-05

`klorn_app` now exists (`NOBYPASSRLS`, owns nothing) and the whole mechanism
was proven against the real database before any application code depends on
it. Nothing was switched over — `DATABASE_URL` still points at `postgres`, so
this was observation only.

Connecting through the session pooler as `klorn_app.<ref>` works, which was the
open question that would have invalidated the approach: Supavisor accepts a
non-`postgres` username.

| Probe (as `klorn_app`, on `EmailMessage`) | Result |
| --- | --- |
| no GUC set | **0 rows** — fails closed |
| `app.current_user_id` = each of the 10 users | rows visible, and **every visible row belonged to that user** |
| `app.bypass_rls = 'on'` | **1020 rows** (the whole table) |
| sum of the 10 per-user counts | **1020** |

The last two lines are the proof, and they are worth more than the first two.
"Fails closed" and "opens for a tenant" are both satisfied by a broken policy —
one that denies everything scores the first, one that ignores the GUC scores
the second. Only an exact partition satisfies both at once: the per-user counts
summing to precisely the unrestricted total means no row is hidden from its
owner **and** no row is visible to anyone else. A leak or a loss would show up
as a mismatch here and nowhere else.

This also confirms `set_config(..., is_local => true)` survives the pooler,
which is the assumption `withTenant` is built on.

**Gap found here, closed since: `User` had no RLS.** 43 tables were enabled and
all 43 had policies (no orphan with RLS on and no policy — that combination
would deny everything once RLS binds). `User` was not among them: it has no
`userId` column, so the `"userId" = current_setting(...)` shape does not fit.
`20260805120000_enable_rls_user` added it with `id = current_setting(...)`.

### What actually unlocks isolation

Connect the app as a **dedicated least-privilege role** that owns nothing and
has no `BYPASSRLS`. RLS constrains non-owner roles under plain `ENABLE`, so
once the app runs as that role the existing migration is sufficient and
**`FORCE` is never needed**. That is also the right answer independent of RLS:
an application has no business connecting as the schema owner.

This changes the shape of the work. `FORCE` was per-table and reversible;
switching the connection role activates RLS on **all 43 policied tables at
once**, and an unrouted query does not error — it returns **zero rows**. Keep
the rollout incremental by disabling RLS on the tables that are not routed yet
(a no-op in practice: the app bypasses every one of them today) and re-enabling
per table as its call sites land.

## Why the groundwork is still safe (inert) today

The `20260714140000_enable_rls_permissive` migration only runs `ENABLE ROW
LEVEL SECURITY` (never `FORCE`) and installs policies, so it is a **no-op for
the running app**: every query still sees every row it did before. It cannot
deny-all. (Its header comment explains the inertness by ownership alone; that
was incomplete — `BYPASSRLS` is the binding reason. The migration has been
applied and is left as-is; this document is the current truth.)

Two permissive policies are installed per table (they OR together):

- `*_tenant_isolation`: `"userId" = current_setting('app.current_user_id', true)`
- `*_system_bypass`: `current_setting('app.bypass_rls', true) = 'on'`

Neither carries a `TO <role>` clause, so both apply to every role — including a
future dedicated app role. `current_setting(name, true)` returns NULL when the
GUC is unset, so once RLS binds and neither GUC is set, a table fails closed
(zero rows) — the safe default. `WITH CHECK` defaults to `USING`, so writes are
tenant-scoped too.

## The request-context helpers (`src/db-tenant.ts`)

- `withTenant(userId, tx => …)` — runs in an interactive transaction that sets
  `app.current_user_id` (transaction-local, pooler-safe). Every query inside
  must use the `tx` handle.
- `withSystem(tx => …)` — sets `app.bypass_rls = 'on'` for paths with no single
  owning user (schedulers, webhook ingest, admin fleet queries).
- Either accepts `{ atomic: true }` for a block that needs a transaction for its
  own sake (a read-then-write guard) rather than for isolation.

These are wired but inert until the app stops bypassing RLS — setting a GUC
that no policy is consulted for does nothing. They detect that state rather
than assume it, and skip the transaction entirely while it holds; see
"Resolution" below for why that is what unblocks the routing work.

## Remaining steps (each its own PR)

1. **Prereq (founder)**: ✅ **Done — drill run 2026-08-04.** A restore drill you
   have actually run, not just a backup that exists. Production runs on
   **Supabase** (`ap-northeast-2`), whose free tier has no automated backups,
   so the dump and the drill are both manual:
   `docs/launch/db-credential-runbook.md` has the exact commands.

   | 2026-08-04 drill | Result |
   | --- | --- |
   | `pg_dump -Fc` via session pooler | 82 MB, ~2 min |
   | `pg_restore` into a local postgres:17 | 3 ignorable `supabase_vault` errors, application tables intact (`User` = 10 rows) |
   | `prisma migrate status` against the restored DB | `Database schema is up to date!` (110 migrations) |

   The third row is what licenses the rest. A dump that restores but that the
   app then rejects is not a recovery path, and that gap only shows up under
   the pressure of a real incident. Re-run the drill whenever the Postgres
   major version or the connection topology changes.

2. **Route query sites through the helpers**, one domain at a time: replace
   `prisma.*` calls in a domain's handlers with `withTenant`/`withSystem`.
   Still inert, so each PR is behaviour-preserving and reviewable on its own.
   Started: `LearnedRule` (#1012). Remaining: 43 policied tables, several
   hundred call sites — this is the bulk of the work and it is unglamorous.

   ✅ **Unblocked 2026-08-05.** This step was held while per-query wrapping cost
   ~190 ms; the wrapper now skips its transaction while RLS is inert, so routing
   a call site costs nothing until the role switches. See "Resolution" below.

   One rule that comes with that: a block whose write depends on a preceding
   read must pass `{ atomic: true }`. The wrapper no longer opens a transaction
   on its own, and that guarantee was always the caller's rather than RLS's —
   it just used to arrive for free. Nothing in the signature enforces it, so it
   belongs on the review checklist for every routing PR.

3. **Create the dedicated app role.** ✅ **Done 2026-08-05** — `klorn_app`
   exists and was verified against production (see the probe table above). It
   is not wired into anything yet; `DATABASE_URL` still points at `postgres`,
   so creating it changed no behaviour.

   Recorded for reproduction (e.g. rebuilding from a restored dump):

   ```sql
   CREATE ROLE klorn_app LOGIN PASSWORD '<generated>'
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
   GRANT USAGE ON SCHEMA public TO klorn_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO klorn_app;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO klorn_app;
   -- future tables created by migrations must be reachable too
   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO klorn_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
     GRANT USAGE, SELECT ON SEQUENCES TO klorn_app;
   ```

   Re-verify after any rebuild — a role that still bypasses RLS buys nothing,
   and it fails silently rather than loudly:

   ```sql
   SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'klorn_app';
   -- both must be false
   ```

   Generate the password so it never passes through a clipboard or a chat
   window; two of them leaked that way while setting this up.

   ```bash
   PW=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32)
   printf '%s' "$PW" | pbcopy   # straight to the Render field, never to stdout
   ```

   Alphanumeric only, deliberately: `@` and `/` in a password have to be
   percent-encoded inside a connection URL, and a mis-encoded `DATABASE_URL` is
   an outage.

### Measured cost: wrapping is 3.7x, and the API is 4,700 km from the database

Measured 2026-08-05 against the production pooler as `klorn_app`, marginal cost
per query (101 iterations minus 1, so connection setup is excluded):

| | per query |
| --- | --- |
| plain `SELECT` | **11.5 ms** |
| same query inside `withTenant` | **42.1 ms** |

`BEGIN`, `set_config` and `COMMIT` are three extra round trips — the wrapper
costs 2.7 RTT, not a constant. Those numbers are from a laptop ~11 ms from
Seoul. **The API runs on Render in `singapore` while the database is Supabase
`ap-northeast-2` (Seoul)**, roughly 4,700 km apart; `/api/health`, which does
hit the database, answers in ~190 ms from Korea. At a Singapore→Seoul RTT of
~70 ms, the same wrapper costs **≈ +190 ms per query**.

That rules out the obvious implementation. `requireAuth` reads `User` on every
authenticated request (`auth.ts:116`), so wrapping call sites individually adds
~190 ms to *every* request, and a handler issuing five wrapped queries would
add nearly a second. Routing 148 call sites into that shape would produce a
correct system nobody can use.

A tempting shortcut does not work either: collapsing to one round trip with
`SELECT set_config(...), (SELECT … )` measures 11.7 ms — free — but SQL does
not define the evaluation order of a `SELECT` list relative to its subqueries.
It happens to work; it is not guaranteed to. A security boundary must not rest
on undefined evaluation order, and the failure mode when a planner reorders is
silent. Rejected.

### Resolution: don't pay for the wrapper until it buys something (2026-08-05)

The transaction exists only to carry a GUC. While the connected role bypasses
RLS, **no policy ever reads that GUC** — the same fact this document opens with.
So the three round trips are not the price of isolation, they are the price of
nothing, paid early. `withTenant`/`withSystem` now detect whether RLS can
constrain the connection and run the callback directly when it cannot.

Routing a call site therefore costs **0 ms today**, and the cost arrives with
the isolation it buys — which moves it behind the same deliberate switch as
everything else here. That is what unblocks step 2.

Detection asks the database rather than reading a flag:

```sql
SELECT (rolsuper OR rolbypassrls) AS bypasses FROM pg_roles WHERE rolname = current_user;
```

memoized per process, and only on success. A flag would have to be flipped in
the same change that repoints `DATABASE_URL`, and forgetting it is a total
outage (RLS armed, no GUC bound, zero rows on 43 tables at once). Deriving the
answer from the connection cannot drift from it. `RLS_ENFORCEMENT=on|off`
overrides the probe; anything else, including unset, probes. A failed probe
assumes **enforced** — that costs round trips, while the other guess would run
routed call sites with nothing bound.

Two consequences worth naming:

- While inert the callback receives the global client, so a query that ignores
  its `tx` handle behaves identically and stays invisible until the switch.
  Tests run with `RLS_ENFORCEMENT=on` (`vitest.config.ts`) so that discipline is
  enforced where it is observable.
- Skipping the transaction also skips its atomicity. Blocks that need it for
  their own reasons pass `{ atomic: true }` — the learned-rule transitions in
  `routes/admin.ts` do, and a test pins it.

### What is still true, and what was wrong

1. **Co-locate the API with the database.** Unchanged, and still the largest win
   available: every query already pays ~70 ms of geography, so the app is slow
   today for reasons nothing in this document caused. Render offers no Seoul
   region, so this means moving Postgres to Singapore or the API to a provider
   with a Seoul region. It is also the precondition for the switch — once RLS
   binds, the wrapper costs ~30 ms co-located versus ~190 ms as deployed.
2. **Group the wrapper per unit of database work, not per query.** The earlier
   framing — one transaction per request via a Fastify hook — is the wrong shape
   for the right idea: a request that calls an LLM would hold a transaction for
   seconds. The rule that survives is the ordinary one, *never do network I/O
   inside a transaction*: a handler groups its queries into one `withTenant`
   block and keeps LLM and Gmail calls outside it. Same bound (one wrapper per
   request), no held-open transaction.
3. ~~**Cache the hot path.**~~ **Wrong — worth 0 ms.** The claim was that
   `sessionRevokedForToken`'s read of `sessionsInvalidatedAt` costs ~70 ms on
   every authenticated request. It does not cost anything on its own:
   `requireAuth` issues it via `Promise.all` alongside `isDeviceSessionValid`,
   which reads `Device` (`auth.ts:163-166`, `auth.ts:267-269`). The two are
   concurrent, so removing one leaves the round trip exactly where it was.
   Caching the pair would remove it — at the price of a revocation delay on a
   security control, for a win that co-location delivers anyway. Not worth it.

### Hard gate before step 4: `User` is upstream of tenancy itself

`User` is not "one more table to route". Every other policied table is reached
*after* a tenant is resolved; `User` is how the tenant gets resolved. 148
`prisma.user.*` call sites across 39 files are currently unrouted, and the ones
that matter cannot be tenant-scoped even in principle:

| Path | Why no tenant context exists | Failure if unrouted when the role switches |
| --- | --- | --- |
| `routes/auth.ts:377` login, `:1036` Google OAuth | looks a user up *by email* — finding out who they are is the point | `null` for every attempt → **total lockout** |
| `routes/auth.ts:288`,`:300` registration | the new `id` is not knowable before the row exists | duplicate check silently passes, then `INSERT` is **rejected** by `WITH CHECK` |
| `routes/auth.ts:1487` reset, `:1543` verify | looked up by token hash, pre-authentication | every valid token reports "invalid or expired" |
| `auth.ts:189` `requireAdmin` | reads role before trusting the caller | every admin gets 403 |
| `automation-scheduler.ts:628`, `autonomous-agent-scheduler.ts:186`, `mail/github-scheduler.ts:20`, `mail/naver-imap-scheduler.ts:24` | sweeps the whole fleet | `[]` → mail sync and the agent go **silently dark**, no error logged |
| `routes/webhook.ts` (Stripe/Paddle/RevenueCat) | resolves by `stripeId`/`customerId` | billing sync no-ops, and looks identical to "customer not ours" |

These need `withSystem`, not `withTenant`. Which is worth being honest about:
most `User` access is legitimately system-level, so the tenant policy on this
table guards a narrower surface than the other 43 — essentially "read/update my
own profile". It still earns its place, because the bug class this exists to
stop is a query that *should* have been scoped and wasn't, and that query now
returns nothing instead of everyone.

**Route these before step 4, and treat "login still works" as the canary.** An
unrouted `User` does not degrade gracefully; it locks every account out at once,
including the account needed to diagnose it.

4. **Split migration and runtime connections.** `scripts/start.sh` runs
   `prisma migrate deploy` with `DATABASE_URL`, so pointing that at a role
   without DDL rights breaks deploys. Add `directUrl = env("DIRECT_DATABASE_URL")`
   to the datasource: migrations keep using the `postgres` URL, the runtime
   client uses the `klorn_app` one.

   Rotating `DATABASE_URL` on Render has a required order — Suspend first. See
   `docs/launch/db-credential-runbook.md`; skipping it is what caused the
   2026-08-04 outage.

5. **Disable RLS on the tables that are not routed yet**, in the same change
   that switches the role. This looks like undoing work and is not: the app
   bypasses all 43 today, so their RLS state is decorative. Making it explicit
   is what keeps the rollout incremental — otherwise flipping the role arms
   every table simultaneously and every unrouted query silently returns zero
   rows.

   **Corrected 2026-10-03: the RLS state is not decorative.** It is what kept
   the Data API roles out of the 43 tables while they held grants (see the
   2026-10-03 section). Those grants are revoked now, so disabling RLS no longer
   opens a table to them, but the coverage guard fails on a `DISABLE` until the
   table is listed in `RLS_EXEMPT_MODELS`. The set that arms at the switch is
   also larger than 43 now: it includes `Message` and the other 17 tables.

6. **Re-enable per table** as its call sites land, lowest-traffic first. Two
   hard gates before widening:
   - **Correctness canary (required)**: an integration test per newly-armed
     table asserting a `withTenant`-scoped query returns the expected rows AND
     the same query on the global `prisma` client returns 0/empty. This is the
     trip-wire for a missed call site — a stray `prisma.*` bulk read/write goes
     **silently dark** (`findMany`→empty, `updateMany`→`{count:0}`, no error;
     only single-record `update`/`delete` throw P2025), so a user could lose
     visibility into their own data with nothing crashing. Catch it in CI, not
     in production.
   - **p95 benchmark**: each tenant-scoped read adds one transaction round-trip.

   Roll a table back instantly with `ALTER TABLE t DISABLE ROW LEVEL SECURITY;`
   (no data change).

7. **Bespoke policies** for the tables the first migration skipped.
   ✅ **Done — no table is waiting for a policy.**

   - **`User`** — the only one the first migration omitted without saying so.
     `20260805120000_enable_rls_user`, keyed on
     `id = current_setting('app.current_user_id', true)`.
   - `Message` — tenant policy through `Conversation`
     (`20261010010000_enable_rls_remaining_tables`).
   - `LlmUsageLog` — the standard pair; a NULL `userId` row is system-only
     (same migration).
   - `WebhookEvent` — system-only (same migration).

## Rollback

Nothing here is destructive. `ALTER TABLE t DISABLE ROW LEVEL SECURITY;` drops
enforcement; `DROP POLICY` removes the rules; pointing `DATABASE_URL` back at
the `postgres` role restores the pre-rollout behaviour wholesale. No data is
touched at any stage.

The one step that is not instantly reversible in practice is the credential
switch itself — not because of RLS, but because rotating a live `DATABASE_URL`
has an ordering hazard that has already taken production down once. Treat step
4 as the risky one, and follow the runbook.
