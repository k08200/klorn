-- Secondary (e.g. work) Google calendars linked for cross-account free/busy
-- conflict detection. Separate from UserToken (the single primary account) so
-- the email path is untouched; read only by checkConflicts. Scope: calendar.readonly.
CREATE TABLE "LinkedCalendarAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedCalendarAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkedCalendarAccount_userId_email_key" ON "LinkedCalendarAccount"("userId", "email");

-- AddForeignKey
ALTER TABLE "LinkedCalendarAccount" ADD CONSTRAINT "LinkedCalendarAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
