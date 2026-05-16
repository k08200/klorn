-- Renamed from 20260511170000 (which conflicted with add_candidate_intake).
-- Made idempotent with exception handler so re-applying after rename does not fail.
DO $$ BEGIN
  ALTER TYPE "FeedbackSignal" ADD VALUE 'FAILED';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
