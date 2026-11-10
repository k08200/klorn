-- Additive, nullable: null = Automatic (follow the device zone), "MANUAL" = the
-- user pinned AutomationConfig.timezone in Settings. Existing rows read as
-- Automatic. No backfill, no lock beyond a catalog update.
ALTER TABLE "AutomationConfig" ADD COLUMN "timezoneMode" TEXT;
