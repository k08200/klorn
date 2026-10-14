/**
 * A process with OBJECT_STORAGE_ENABLED off never loads the S3 implementation
 * or its signing library (step D1). The first use with the flag on loads them.
 *
 * Unlike storage-runtime.test.ts, nothing in storage/ is mocked here: the real
 * module graph is what is under test. `aws4fetch` is wrapped only to count how
 * often it is loaded.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const loads = vi.hoisted(() => ({ aws4fetch: 0 }));
vi.mock("aws4fetch", async (importOriginal) => {
  loads.aws4fetch += 1;
  return await importOriginal<typeof import("aws4fetch")>();
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../db.js", () => ({
  prisma: {
    $transaction: vi.fn(async () => []),
    llmUsageLog: { deleteMany: vi.fn() },
    user: { delete: vi.fn() },
  },
  db: {},
  INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 },
}));

const STORAGE_ENV = {
  OBJECT_STORAGE_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  OBJECT_STORAGE_REGION: "auto",
  OBJECT_STORAGE_BUCKET: "klorn-objects",
  OBJECT_STORAGE_ACCESS_KEY_ID: "LAZYACCESSKEY01",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "lazy-secret",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("lazy loading of the S3 implementation", () => {
  it("flag off: startup, both deletion paths and every accessor leave it unloaded", async () => {
    vi.stubEnv("OBJECT_STORAGE_ENABLED", "false");
    for (const name of Object.keys(STORAGE_ENV)) vi.stubEnv(name, undefined);

    const runtime = await import("../storage/runtime.js");
    const deletion = await import("../user-deletion.js");
    await import("../storage/user-storage.js");
    await import("../storage/memory-store.js");

    expect(await runtime.checkObjectStorageAtStartup()).toEqual({ state: "disabled" });
    expect(await runtime.getObjectStore()).toBeNull();
    expect(await runtime.getUserStorage()).toBeNull();
    await deletion.deleteUserAndAllData("user-1");
    await deletion.purgeAllUserData("user-1");

    expect(loads.aws4fetch).toBe(0);
  });

  it("flag on: the first use loads it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("OBJECT_STORAGE_ENABLED", "true");
    for (const [name, value] of Object.entries(STORAGE_ENV)) vi.stubEnv(name, value);

    const runtime = await import("../storage/runtime.js");
    expect(loads.aws4fetch).toBe(0);
    expect(await runtime.getObjectStore()).not.toBeNull();
    expect(loads.aws4fetch).toBe(1);
    runtime.setObjectStoreForTests(null);
  });
});

describe("who may import the S3 implementation", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));
  const sources = (readdirSync(SRC, { recursive: true }) as string[])
    .filter((path) => path.endsWith(".ts") && !path.includes("__tests__"))
    .map((path) => ({ path, text: readFileSync(join(SRC, path), "utf8") }));

  /** `import … from "x"` and `export … from "x"` that load a module at import time. */
  const loadsStatically = (text: string, specifier: RegExp) =>
    [...text.matchAll(/^(?:import|export)\s[^;]*?from\s+"([^"]+)";/gms)].some(
      ([statement, from]) =>
        specifier.test(from ?? "") && !/^(?:import|export)\s+type\s/.test(statement),
    );

  it("only s3-store.ts imports aws4fetch", () => {
    const importers = sources
      .filter(({ text }) => /["']aws4fetch["']/.test(text))
      .map(({ path }) => path);
    expect(importers).toEqual(["storage/s3-store.ts"]);
  });

  it("nothing loads s3-store.ts at import time", () => {
    const importers = sources
      .filter(({ text }) => loadsStatically(text, /s3-store\.js$/))
      .map(({ path }) => path);
    expect(importers).toEqual([]);
  });

  it("runtime.ts is the one place that loads it, with a dynamic import", () => {
    const dynamic = sources
      .filter(({ text }) => /import\(\s*"[^"]*s3-store\.js"\s*\)/.test(text))
      .map(({ path }) => path);
    expect(dynamic).toEqual(["storage/runtime.ts"]);
  });
});
