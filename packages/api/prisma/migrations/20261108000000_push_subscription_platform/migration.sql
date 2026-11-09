-- PushSubscription.browser / .os: the browser family and OS of the agent that
-- registered the subscription, so settings → "Where you get alerts" can label
-- each row and tell a phone from a desktop. Derived values only — the raw
-- User-Agent is never stored.
--
-- EXPAND ONLY, metadata-only: nullable columns with no default add without a
-- table rewrite. The previous instance keeps writing rows without them during
-- the swap; those read as unknown and fall back to the push-service host.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "PushSubscription" ADD COLUMN "browser" TEXT;
ALTER TABLE "PushSubscription" ADD COLUMN "os" TEXT;
