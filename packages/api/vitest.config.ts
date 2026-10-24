import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    // One process per test file (vitest's default, pinned): the linear-scan
    // guards time runs with process.cpuUsage, which a threads pool would share
    // across files. See src/__tests__/helpers/linear-timing.ts.
    pool: "forks",
    env: {
      // Force the tenant wrapper into its enforcing shape. In production it is
      // inert today (the app's role bypasses RLS, see db-tenant.ts) and an
      // inert wrapper hands the callback the global client — under which a call
      // site that ignores its `tx` handle passes every test and then reads zero
      // rows on the day the role switches. Tests are where that is catchable.
      RLS_ENFORCEMENT: "on",
    },
    // Scope vitest to api unit/integration suites only. Without `include`,
    // vitest walks up the monorepo and picks up Playwright e2e specs from
    // packages/web/e2e which fail because they require a Playwright runner.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Reset the classifier's effective-threshold cache before every test so an
    // override applied in one test can't leak into another (ontology-overrides
    // module state is shared across files in this setup). See setup.ts.
    setupFiles: ["src/__tests__/setup.ts"],
    root: __dirname,
  },
});
