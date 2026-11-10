-- MIME Content-ID for inline (cid:) images, captured at sync. Nullable:
-- rows synced before this migration have no captured id and degrade to a
-- transparent placeholder in the reading pane.
ALTER TABLE "EmailAttachment" ADD COLUMN "contentId" TEXT;
