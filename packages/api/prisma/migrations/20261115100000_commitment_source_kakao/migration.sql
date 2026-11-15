-- KakaoTalk chat-export import v1 (2026-11-15). See docs/providers/kakaotalk-import.md.
--
-- KAKAO: the source of a commitment suggested from an uploaded KakaoTalk chat
-- export. Its own migration: Postgres cannot use an enum value in the
-- transaction that added it. Postgres cannot drop an enum value either, so a
-- rollback leaves it unused.

-- Fail fast instead of queueing behind a long lock (same guard as 20261009010000).
SET LOCAL lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "CommitmentSource" ADD VALUE IF NOT EXISTS 'KAKAO';
