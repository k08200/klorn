/**
 * Store screenshots at the exact pixel sizes App Store Connect and Play Console
 * accept, from the same mock build the e2e suite uses (fixtures, no network).
 * The regular e2e shots (`npm run e2e`, CI artifact `mobile-screenshots`) are
 * CSS-pixel sized (device scale 1) and Korean only, so they are review
 * material, not upload material. This config renders at device scale 2–3 in
 * Korean and English. Run from apps/mobile:
 *
 *   npx playwright test --config store-pack/capture/playwright.store.config.ts
 *
 * Output: test-results/store-shots/<target>/<ko|en>/<NN-screen>.png, plus
 * play/feature-graphic-{en,ko}.jpg and play/icon-512.png (play-graphics.spec.ts)
 * (or $KLORN_STORE_SHOTS_DIR). CI: the "Store assets" job in mobile.yml
 * (run by hand) uploads the same set as the `klorn-store-assets` artifact.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.KLORN_E2E_PORT ?? 4319);
const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: ["store-shots.spec.ts", "play-graphics.spec.ts"],
  timeout: 60_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    timezoneId: "Asia/Seoul",
    browserName: "chromium",
  },
  webServer: {
    command: `npm run build:mock && npx vite preview --outDir dist-mock --port ${PORT} --strictPort`,
    cwd: APP_DIR,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
