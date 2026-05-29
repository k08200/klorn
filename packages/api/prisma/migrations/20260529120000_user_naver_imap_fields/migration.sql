-- Naver IMAP connection fields on User.
-- naverImapPasswordCipher holds the AES-GCM-encrypted IMAP password —
-- never the plaintext that Naver users paste from their security settings.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "naverImapEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "naverImapPasswordCipher" TEXT,
  ADD COLUMN IF NOT EXISTS "naverImapHost" TEXT,
  ADD COLUMN IF NOT EXISTS "naverImapConnectedAt" TIMESTAMP(3);
