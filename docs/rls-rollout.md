# Row-Level Security rollout

Tenant isolation is enforced in application code today (`where: { userId }`).
A single missing filter is a cross-tenant leak with no database backstop — a
class of bug that has shipped here before (the `20260625000000_scope_unique_
constraints_by_user` migration fixed three tables that had global unique
constraints). Postgres RLS makes isolation an invariant the database enforces,
not one every query author must remember.

This is a **staged** rollout. The dangerous step (`FORCE`) is deliberately
separated from everything that is safe, and is gated on a tested restore path.

## Why the groundwork is safe (inert) today

The app connects as the table **owner**. A table owner bypasses RLS unless
`FORCE ROW LEVEL SECURITY` is set. The `20260714140000_enable_rls_permissive`
migration only runs `ENABLE ROW LEVEL SECURITY` (never `FORCE`) and installs
policies, so it is a **no-op for the running app**: every query still sees
every row it did before. It cannot deny-all.

Two permissive policies are installed per table (they OR together):

- `*_tenant_isolation`: `"userId" = current_setting('app.current_user_id', true)`
- `*_system_bypass`: `current_setting('app.bypass_rls', true) = 'on'`

`current_setting(name, true)` returns NULL when the GUC is unset, so once a
table is `FORCE`d and neither GUC is set, it fails closed (zero rows) — the
safe default. `WITH CHECK` defaults to `USING`, so writes are tenant-scoped
too under FORCE.

## The request-context helpers (`src/db-tenant.ts`)

- `withTenant(userId, tx => …)` — runs in an interactive transaction that sets
  `app.current_user_id` (transaction-local, pooler-safe). Every query inside
  must use the `tx` handle.
- `withSystem(tx => …)` — sets `app.bypass_rls = 'on'` for paths with no single
  owning user (schedulers, webhook ingest, admin fleet queries).

These are wired but inert until FORCE — setting an unused GUC does nothing.

## Remaining steps (each its own PR)

1. **Prereq (founder)**: a tested Postgres backup + point-in-time restore
   rehearsal on the prod plan. Do not FORCE any table before this exists.
2. **Route query sites through the helpers**, one domain at a time: replace
   `prisma.*` calls in a domain's handlers with `withTenant`/`withSystem`.
   Still inert (nothing FORCEd), so each PR is behavior-preserving and testable
   against a real DB in CI.
3. **FORCE per table**, lowest-traffic first, once that table's query sites all
   go through a helper. Benchmark p95 (each FORCEd read adds one transaction
   round-trip) before widening. Roll back a table with
   `ALTER TABLE t NO FORCE ROW LEVEL SECURITY;` (instant, no data change).
4. **Bespoke policies** for the tables this slice skipped: `Message` (scoped by
   `conversationId` → needs a subquery/join policy), `LlmUsageLog` (nullable
   `userId` for system calls), `WebhookEvent` (global idempotency ledger — likely
   stays system-only).

## Rollback

Nothing here is destructive. To fully revert the groundwork:
`ALTER TABLE t DISABLE ROW LEVEL SECURITY;` drops enforcement; `DROP POLICY`
removes the rules. No data is touched at any stage.
