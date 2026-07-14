import { beforeEach } from "vitest";
import { resetOverrideCache } from "../ontology-overrides.js";
import { resetSchedulerHeartbeats } from "../scheduler-heartbeat.js";

// The classifier reads a module-global effective-threshold cache
// (ontology-overrides.ts). This vitest setup shares module state across test
// files, so a test that applies an override could otherwise leak a retuned
// threshold into another file's judge call. Reset to base before every test so
// each starts from the git-default thresholds; a test that wants overrides
// applies them itself after this hook runs.
// scheduler-heartbeat's registry is the same category of shared module state:
// any test that calls a real start*Scheduler() would otherwise leak
// registrations into every later test file.
beforeEach(() => {
  resetOverrideCache();
  resetSchedulerHeartbeats();
});
