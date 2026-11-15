import { beforeEach } from "vitest";
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
//
// ontology-overrides is imported here, not at the top: it pulls in db.ts, the
// data-wipe fence and the failure reporters, and a module this file loads is
// evaluated before the test file registers its vi.mock calls. A reporter
// loaded that early binds the real sentry.ts, so a test's
// `vi.mock("../sentry.js")` would never see what it captures. Imported here,
// it resolves through the test's mocks like every other module (a test that
// mocks ontology-overrides without resetOverrideCache gets nothing reset).
beforeEach(async () => {
  const overrides = await import("../learning/ontology-overrides.js");
  // `in`, not a property read: vitest throws on reading an export a mock
  // factory left out. The module's type still names it, so a rename fails tsc.
  if ("resetOverrideCache" in overrides) overrides.resetOverrideCache();
  resetSchedulerHeartbeats();
});
