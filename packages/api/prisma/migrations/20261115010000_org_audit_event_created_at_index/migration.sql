-- Organization audit log retention (src/org/audit-retention.ts): a
-- single-column createdAt index so the daily sweep's orgId-less
-- `WHERE "createdAt" < cutoff ORDER BY "createdAt"` page is an index range
-- scan. The existing ("orgId", "createdAt") index leads with orgId and cannot
-- serve it. EXPAND ONLY; the table is days old and near empty, so a plain
-- CREATE INDEX (Prisma runs each migration in a transaction) takes a
-- negligible lock. lock_timeout makes a deploy blocked by a long transaction
-- fail fast; recover with `prisma migrate resolve --rolled-back
-- 20261115010000_org_audit_event_created_at_index` and redeploy.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "OrgAuditEvent_createdAt_idx" ON "OrgAuditEvent" ("createdAt");
