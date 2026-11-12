-- Scheduler lease (2026-11-11). See src/scheduler-lease.ts.
--
-- The automation and autonomous-agent schedulers guarded each tick with a
-- session advisory lock: one statement took it, a later one released it. Behind
-- Supavisor those two statements can run on different backends, so the release
-- returned false and the lock stayed with an idle backend that outlives the
-- app; every tick that landed elsewhere was skipped. A row per scheduler, taken
-- and released by single atomic statements, does not depend on which backend
-- runs them, and a holder that stops renewing loses it when "expiresAt" passes.
--
-- A new table: nothing reads it yet, so no lock_timeout is needed. Rows are
-- created on first acquire (INSERT ... ON CONFLICT).

CREATE TABLE "SchedulerLease" (
    "name" TEXT NOT NULL,
    "holderId" TEXT,
    "acquiredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchedulerLease_pkey" PRIMARY KEY ("name")
);

-- RLS, as for every table (docs/rls-rollout.md). No owning user: system scope only.
ALTER TABLE "SchedulerLease" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SchedulerLease_system_bypass" ON "SchedulerLease" USING (current_setting('app.bypass_rls', true) = 'on');
