-- Add origin column to PushSubscription so the backend can stop pushing to
-- subs that belong to a retired web origin (e.g. the old hire-eve-web.vercel.app
-- alias killed during the 2026-05-22 Klorn rebrand). Those SWs still live in
-- users' browsers, openWindow() to a now-404 deployment, and there is no way
-- to clean them server-side without knowing the origin each sub came from.
--
-- Existing rows get NULL. cleanup-stale-push-subs.ts deletes those rows so
-- those users re-subscribe from the current origin on next visit.

ALTER TABLE "PushSubscription" ADD COLUMN "origin" TEXT;
