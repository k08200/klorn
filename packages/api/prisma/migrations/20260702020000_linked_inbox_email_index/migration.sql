-- CreateIndex: the gmail-push webhook resolves a pubsub address to its owning
-- linked inbox by email ALONE (it only knows the address, not the userId). The
-- existing @@unique([userId, email]) is userId-leading and cannot serve an
-- email-only lookup, so without this the webhook seq-scanned every linked inbox
-- on each linked-inbox push — the hottest path once MULTI_INBOX_SYNC_ENABLED is
-- on. The lookup is now an exact match (the pubsub email and every stored email
-- are lowercased), so a plain btree serves it. IF NOT EXISTS allows an
-- out-of-band CONCURRENTLY pre-build before a large-table deploy.
CREATE INDEX IF NOT EXISTS "LinkedInboxAccount_email_idx" ON "LinkedInboxAccount"("email");
