import { defineConfig } from "@playwright/test";

/** KLORN_E2E_PORT: run two worktrees' suites side by side without sharing a preview server. */
const PORT = Number(process.env.KLORN_E2E_PORT ?? 4317);

/**
 * Screenshot + behaviour specs against the MOCK build (no network, fixtures
 * in src/api/mock). Chromium only — it is the engine with the Viewport
 * Segments API, so the fold specs can emulate a real hinge. Never run
 * `playwright install` in CI images that preinstall browsers
 * (PLAYWRIGHT_BROWSERS_PATH); @playwright/test is pinned to the revision
 * those images carry.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    browserName: "chromium",
  },
  webServer: {
    command: `npm run build:mock && npx vite preview --outDir dist-mock --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
