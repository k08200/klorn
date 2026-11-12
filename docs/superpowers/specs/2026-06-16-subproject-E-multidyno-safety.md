# Sub-project E — Horizontal-scale / multi-dyno safety

**Date:** 2026-06-16
**Status:** Design — pre-implementation, **gated on scaling**
**Parent:** Refactoring/hardening campaign (sub-project E of 6). Independent of
C (error observability) and F (dead-code).

## Context

Several pieces of the engine assume **exactly one process**. They are correct and
inert on the current single Render dyno, but each becomes a real bug the moment a
second web dyno (or pgbouncer transaction-mode pooling) is introduced. The grounded
re-review confirmed all of these against current code. This sub-project makes the
engine multi-dyno-safe **so a Show-HN traffic spike can be absorbed by scaling out
without silent duplication or a wedged scheduler.**

> **Execution gate:** design now, but only *ship* E when horizontal scaling (a 2nd
> dyno, or pgbouncer txn-mode per `.env.example`) is actually on the table. Shipping
> it earlier adds infra (Redis/DB-backed locks) for zero present benefit. The point
> of designing now is so the switch is a known, ready change, not a fire drill.

## Scope (all confirmed on `main`)

### E1 — Scheduler advisory lock leaks over the Prisma pool
`packages/api/src/automation-scheduler.ts` — `pg_try_advisory_lock(SCHEDULER_LOCK_KEY)`
and `pg_advisory_unlock` are issued as two independent `$queryRawUnsafe` calls over
Prisma's connection pool. The lock is **session-scoped**; acquire and release can
land on different pooled backends, and under the `.env.example`-recommended
`pgbouncer=true` (txn pooling) the lock is dropped at statement boundary — the
cross-dyno mutex degrades to a no-op (duplicate briefings/sync/outbox) or, in
session mode, leaks (a release on the wrong backend wedges every future tick).
**Fix:** `pg_advisory_xact_lock` inside a single `$transaction` (auto-releases at
txn end, pgbouncer-safe), or a `SchedulerLock` mutex row with a heartbeat.

> **Shipped 2026-11-11, ahead of the scaling gate:** the leak happened on the
> single production instance, because Supavisor is itself a pooler. Session
> locks stayed held by idle backends for hours and the automation scheduler
> skipped ticks without a log. Fixed with a row lease ("SchedulerLease",
> `packages/api/src/scheduler-lease.ts`) for the automation and the
> autonomous-agent loops. A transaction-scoped lock was rejected because a tick
> runs for up to minutes of network I/O, and holding a transaction open that
> long pins a pooled connection.

### E2 — In-process dedup/debounce state
Three module-level structures hold state that is per-process only:
- `email-action-trigger.ts:25` — `const lastTriggerAt = new Map()` (agent-run
  debounce). Multi-dyno: a PUSH email triggers a full agent run on *every* dyno;
  lost on restart.
- `background.ts:21` — `const notifiedIds = new Set()` (notification dedup).
  Multi-dyno + restart: duplicate notifications.
- `autonomous-agent-scheduler.ts:30` — `const lastRunTime = new Map()` and **no
  cross-process lock at all** (unlike automation-scheduler). Multi-dyno: every
  dyno independently runs the same due users → duplicate LLM cost + duplicate
  PendingActions.
**Fix:** back each with a DB (or Redis) row keyed by `(userId, purpose)` with a
TTL/timestamp, so dedup/debounce survives restarts and is shared across dynos.
Reuse one small helper rather than three bespoke stores.

### E3 — Unbounded reconcile + N+1 Gmail under `connection_limit=1`
`email-sync.ts reconcileEmails` does an unbounded `findMany` then **N serial**
`gmail.users.messages.get` while holding the single pooled connection. Latent at
one-user dogfood volume; at scale it starves the pool and trips Gmail's per-user
rate limit. **Fix:** bound by `receivedAt` / cap per run; use `messages.batchGet`;
`updateMany` by group. (D extracted the sync engine, so this now lives in a small
file — easier to bound.)

## Testing
- E1: unit-test the lock helper against a real Postgres (or a transaction mock)
  asserting acquire+work+release run on one pinned connection; integration test
  that two concurrent `runAutomations()` calls don't both proceed.
- E2: unit-test the DB-backed debounce/dedup helper (first call passes, second
  within window is skipped, expiry re-allows) — pure-ish, mock the store.
- E3: unit-test the reconcile bounding (cap respected; batchGet called once per
  ≤N group) with a mocked Gmail client.

## PR structure
Likely 2–3 PRs (one per Ex), each independently shippable behind the scaling gate.

## Acceptance criteria
- Scheduler mutual exclusion holds across 2+ processes and under pgbouncer
  txn-mode (no duplicate briefings/sync/outbox).
- Debounce/dedup survive a process restart and are shared across dynos.
- Reconcile is bounded per run and uses batched Gmail reads.
- **No behavior change on a single dyno** (the gate: ship only when scaling).

## Coordination note
E changes deploy-topology assumptions, not module boundaries (D) or error handling
(C). `automation-scheduler.ts` / `email-sync.ts` are touched; rebase onto `main`
first. None of the target files are in the security-sensitive set, so the pre-merge
hook should not fire — but confirm at commit time.
