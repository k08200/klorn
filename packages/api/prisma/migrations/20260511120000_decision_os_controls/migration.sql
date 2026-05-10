CREATE TABLE "WorkContextSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contextKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "href" TEXT,
    "risk" TEXT NOT NULL,
    "reasons" JSONB NOT NULL,
    "signals" JSONB NOT NULL,
    "people" JSONB NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkContextSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivatedPlaybook" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "playbookId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivatedPlaybook_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FeedbackPolicyPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "recipient" TEXT,
    "action" TEXT NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedbackPolicyPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkContextSnapshot_userId_contextKey_key" ON "WorkContextSnapshot"("userId", "contextKey");
CREATE INDEX "WorkContextSnapshot_userId_risk_lastActivityAt_idx" ON "WorkContextSnapshot"("userId", "risk", "lastActivityAt");

CREATE UNIQUE INDEX "ActivatedPlaybook_userId_playbookId_key" ON "ActivatedPlaybook"("userId", "playbookId");
CREATE INDEX "ActivatedPlaybook_userId_status_idx" ON "ActivatedPlaybook"("userId", "status");

CREATE UNIQUE INDEX "FeedbackPolicyPreference_userId_candidateId_key" ON "FeedbackPolicyPreference"("userId", "candidateId");
CREATE INDEX "FeedbackPolicyPreference_userId_action_idx" ON "FeedbackPolicyPreference"("userId", "action");
CREATE INDEX "FeedbackPolicyPreference_userId_toolName_idx" ON "FeedbackPolicyPreference"("userId", "toolName");

ALTER TABLE "WorkContextSnapshot" ADD CONSTRAINT "WorkContextSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActivatedPlaybook" ADD CONSTRAINT "ActivatedPlaybook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeedbackPolicyPreference" ADD CONSTRAINT "FeedbackPolicyPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
