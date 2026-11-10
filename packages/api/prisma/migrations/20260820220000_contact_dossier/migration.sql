-- Per-sender relationship context (team-of-one memory). Additive; lazily
-- populated on read, so no backfill.
CREATE TABLE "ContactDossier" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "senderEmail" VARCHAR(320) NOT NULL,
    "summary" VARCHAR(600) NOT NULL,
    "openThreads" JSONB,
    "lastPromise" VARCHAR(300),
    "analyzedEmailCount" INTEGER NOT NULL,
    "lastEmailAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactDossier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContactDossier_userId_senderEmail_key" ON "ContactDossier"("userId", "senderEmail");

ALTER TABLE "ContactDossier" ADD CONSTRAINT "ContactDossier_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
