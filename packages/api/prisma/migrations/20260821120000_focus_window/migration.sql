-- Focus window toggle (default OFF). Additive.
ALTER TABLE "AutomationConfig" ADD COLUMN "focusWindowEnabled" BOOLEAN NOT NULL DEFAULT false;
