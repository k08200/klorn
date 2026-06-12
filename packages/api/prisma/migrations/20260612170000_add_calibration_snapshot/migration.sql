-- Daily classification-quality snapshots (override rate = the product KPI;
-- judge-source mix makes silent keyword-fallback demotion visible).
-- One row per user per UTC day, upserted by the automation scheduler.

CREATE TABLE "CalibrationSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalibrationSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CalibrationSnapshot_userId_dayKey_key" ON "CalibrationSnapshot"("userId", "dayKey");

ALTER TABLE "CalibrationSnapshot" ADD CONSTRAINT "CalibrationSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
