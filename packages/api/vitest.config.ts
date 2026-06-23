import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
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
