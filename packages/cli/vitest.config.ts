import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The Postgres integration suite applies every migration with the real
    // prisma CLI; that alone takes tens of seconds on a loaded machine.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    // Never inherit an operator's shell into the unit suites: a stray
    // DATABASE_URL or KLORN_* value must not steer a test at a real database.
    env: {
      DATABASE_URL: "",
      KLORN_BACKUP_DIR: "",
      KLORN_API_URL: "",
      KLORN_WEB_URL: "",
    },
  },
});
