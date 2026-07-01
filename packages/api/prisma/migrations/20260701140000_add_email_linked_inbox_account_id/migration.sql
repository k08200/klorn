-- AddColumn: attribute an EmailMessage to a linked secondary inbox (NULL = primary).
-- Nullable + no FK so existing rows stay valid and unlinking an inbox keeps its mail.
ALTER TABLE "EmailMessage" ADD COLUMN "linkedInboxAccountId" TEXT;
