-- Additive, nullable: who sent each recorded mail ("user" | "agent" |
-- "auto_reply" | "unsubscribe"). Existing rows and rows found only by the
-- Sent-folder scan read as null (sent outside Klorn, or before this column).
-- No backfill, no lock beyond a catalog update.
ALTER TABLE "SentMessage" ADD COLUMN "origin" TEXT;
