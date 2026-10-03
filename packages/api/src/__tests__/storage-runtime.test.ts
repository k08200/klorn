/**
 * The flag gate around object storage (step D1): while OBJECT_STORAGE_ENABLED is
 * off nothing is built, loaded or connected; while it is on, a bad config is
 * reported by name and a purge fails rather than skip.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const s3 = vi.hoisted(() => ({
  /** How many times the S3 implementation module was loaded. */
  moduleLoads: 0,
  constructed: [] as unknown[],
  ping: vi.fn(async () => {}),
}));

vi.mock("../storage/s3-store.js", () => {
  s3.moduleLoads += 1;
  return {
    S3ObjectStore: class {
      constructor(config: unknown) {
        s3.constructed.push(config);
      }
      ping = s3.ping;
    },
  };
});

const captureError = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureError }));

import { StorageError } from "../storage/errors.js";
import { newObjectKey } from "../storage/keys.js";
import { MemoryObjectStore } from "../storage/memory-store.js";
import {
  checkObjectStorageAtStartup,
  getObjectStore,
  getUserStorage,
  purgeUserObjects,
  setObjectStoreForTests,
} from "../storage/runtime.js";
import { bytesOf, codeOfAsync } from "./helpers/storage-bytes.js";

const SECRET = "runtime-secret-that-must-never-be-logged";
const ACCESS_KEY = "RUNTIMEACCESSKEY01";
const STORAGE_ENV = {
  OBJECT_STORAGE_ENDPOINT: "https://acct-id-0001.r2.cloudflarestorage.com",
  OBJECT_STORAGE_REGION: "auto",
  OBJECT_STORAGE_BUCKET: "klorn-objects",
  OBJECT_STORAGE_ACCESS_KEY_ID: ACCESS_KEY,
  OBJECT_STORAGE_SECRET_ACCESS_KEY: SECRET,
} as const;
const STORAGE_ENV_NAMES = [
  ...Object.keys(STORAGE_ENV),
  "OBJECT_STORAGE_FORCE_PATH_STYLE",
  "OBJECT_STORAGE_ENABLED",
];
/** Every value an operator sets. None of them may appear in a log line. */
const VALUES = [SECRET, ACCESS_KEY, "klorn-objects", "acct-id-0001"];

function stubStorageEnv(flag: string | undefined, values: Record<string, string> = {}): void {
  for (const name of STORAGE_ENV_NAMES) vi.stubEnv(name, undefined);
  if (flag !== undefined) vi.stubEnv("OBJECT_STORAGE_ENABLED", flag);
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

function logged(...spies: Array<{ mock: { calls: unknown[][] } }>): string {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .flat()
    .map((part) => (part instanceof Error ? `${part.message}\n${part.stack}` : String(part)))
    .join("\n");
}

function expectNoValue(output: string): void {
  for (const value of VALUES) expect(output).not.toContain(value);
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  s3.constructed.length = 0;
  s3.ping.mockReset().mockResolvedValue(undefined);
  captureError.mockReset();
  setObjectStoreForTests(null);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in this test"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setObjectStoreForTests(null);
});

// This block runs first on purpose: it must see the module graph before any
// test with the flag on has loaded the S3 implementation.
describe("flag OFF", () => {
  it.each([
    ["unset", undefined],
    ["false", "false"],
    ["empty", ""],
    ["a word that is not a yes", "enabled"],
  ])("is inert when the flag is %s: nothing loaded, built, required or connected", async (_l, flag) => {
    stubStorageEnv(flag);

    expect(await getObjectStore()).toBeNull();
    expect(await getUserStorage()).toBeNull();
    expect(await checkObjectStorageAtStartup()).toEqual({ state: "disabled" });
    expect(await purgeUserObjects("user-1")).toEqual({ skipped: true, deleted: 0 });

    expect(s3.moduleLoads).toBe(0);
    expect(s3.constructed).toHaveLength(0);
    expect(s3.ping).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(captureError).not.toHaveBeenCalled();
  });

  it("stays inert when the variables are set, and warns that a purge would skip them", async () => {
    stubStorageEnv("off", STORAGE_ENV);
    expect(await getObjectStore()).toBeNull();
    expect(await checkObjectStorageAtStartup()).toEqual({ state: "disabled" });
    expect(s3.moduleLoads).toBe(0);
    expect(s3.constructed).toHaveLength(0);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warning = logged(warnSpy);
    expect(warning).toContain("OBJECT_STORAGE_ENABLED is off");
    expect(warning).toContain("OBJECT_STORAGE_BUCKET");
    expect(warning).toContain("OBJECT_STORAGE_ACCESS_KEY_ID");
    expect(warning).toContain("OBJECT_STORAGE_SECRET_ACCESS_KEY");
    expectNoValue(warning);
  });

  it("names only the variables that are set", async () => {
    stubStorageEnv(undefined, { OBJECT_STORAGE_BUCKET: "klorn-objects" });
    await checkObjectStorageAtStartup();
    const warning = logged(warnSpy);
    expect(warning).toContain("OBJECT_STORAGE_BUCKET");
    expect(warning).not.toContain("OBJECT_STORAGE_SECRET_ACCESS_KEY");
    expectNoValue(warning);
  });

  it("does not warn for the region or the addressing style alone", async () => {
    stubStorageEnv("false", {
      OBJECT_STORAGE_REGION: "auto",
      OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
    });
    await checkObjectStorageAtStartup();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("flag ON", () => {
  it("loads the S3 implementation only now, and only once", async () => {
    stubStorageEnv("true", STORAGE_ENV);
    const before = s3.moduleLoads;
    expect(before).toBe(0);
    await getObjectStore();
    setObjectStoreForTests(null);
    await getObjectStore();
    expect(s3.moduleLoads).toBe(1);
  });

  it.each(["true", "1", "yes", "on", " TRUE "])("reads %j as on", async (flag) => {
    stubStorageEnv(flag, STORAGE_ENV);
    expect(await getObjectStore()).not.toBeNull();
  });

  it("builds one client from the environment and reuses it", async () => {
    stubStorageEnv("true", STORAGE_ENV);
    const first = await getObjectStore();
    expect(await getObjectStore()).toBe(first);
    expect(s3.constructed).toEqual([
      {
        endpoint: STORAGE_ENV.OBJECT_STORAGE_ENDPOINT,
        region: "auto",
        bucket: "klorn-objects",
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET,
        forcePathStyle: true,
      },
    ]);
  });

  it("builds one client when two callers ask at the same moment", async () => {
    stubStorageEnv("true", STORAGE_ENV);
    const [first, second] = await Promise.all([getObjectStore(), getObjectStore()]);
    expect(first).toBe(second);
    expect(s3.constructed).toHaveLength(1);
  });

  it("refuses to hand out a store when a variable is missing", async () => {
    stubStorageEnv("true", { ...STORAGE_ENV, OBJECT_STORAGE_BUCKET: "" });
    expect(await codeOfAsync(() => getObjectStore())).toBe("misconfigured");
    expect(await codeOfAsync(() => getUserStorage())).toBe("misconfigured");
    expect(s3.constructed).toHaveLength(0);
  });

  it("does not hand out a store that was built while the flag was on", async () => {
    stubStorageEnv("true", STORAGE_ENV);
    expect(await getObjectStore()).not.toBeNull();
    vi.stubEnv("OBJECT_STORAGE_ENABLED", "false");
    expect(await getObjectStore()).toBeNull();
  });
});

describe("checkObjectStorageAtStartup", () => {
  it("says the check passed and logs nothing that identifies the account", async () => {
    stubStorageEnv("true", STORAGE_ENV);
    expect(await checkObjectStorageAtStartup()).toEqual({ state: "ok" });
    expect(s3.ping).toHaveBeenCalledTimes(1);
    const output = logged(logSpy, warnSpy, errorSpy);
    expect(output).toContain("[STORAGE] ok");
    expectNoValue(output);
  });

  it("names the wrong variables, reports them, and does not throw", async () => {
    stubStorageEnv("true", { OBJECT_STORAGE_SECRET_ACCESS_KEY: SECRET });
    const health = await checkObjectStorageAtStartup();
    expect(health).toMatchObject({ state: "misconfigured", code: "misconfigured" });
    const output = logged(errorSpy);
    expect(output).toContain("OBJECT_STORAGE_BUCKET");
    expect(output).toContain("OBJECT_STORAGE_ENDPOINT");
    expectNoValue(output);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(s3.ping).not.toHaveBeenCalled();
  });

  it("reports a bucket that refuses the credentials, without printing them", async () => {
    stubStorageEnv("true", STORAGE_ENV);
    s3.ping.mockRejectedValue(
      new StorageError("access-denied", "object storage list failed: HTTP 403 AccessDenied", {
        status: 403,
        upstreamCode: "AccessDenied",
      }),
    );
    const health = await checkObjectStorageAtStartup();
    expect(health).toMatchObject({ state: "failing", code: "access-denied" });
    const output = logged(logSpy, errorSpy);
    expect(output).toContain("access-denied");
    expect(output).toContain("HTTP 403");
    expectNoValue(output);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0]?.[1]).toMatchObject({
      tags: { scope: "storage.startup", storageCode: "access-denied" },
    });
  });

  it("never throws, whatever the probe throws", async () => {
    stubStorageEnv("true", STORAGE_ENV);
    s3.ping.mockRejectedValue(new TypeError("boom"));
    expect(await checkObjectStorageAtStartup()).toMatchObject({
      state: "failing",
      code: "upstream",
    });
  });
});

describe("purgeUserObjects", () => {
  async function seededStore() {
    const store = new MemoryObjectStore({ deletePageSize: 2 });
    for (const userId of ["user-1", "user-1", "user-1", "user-2"]) {
      const key = newObjectKey(userId, "drive");
      await store.putObject(key, bytesOf("x"), { contentType: "text/plain", size: 1 });
    }
    return store;
  }

  it("deletes the user's objects, and only those, when the flag is on", async () => {
    stubStorageEnv("true", STORAGE_ENV);
    const store = await seededStore();
    setObjectStoreForTests(store);
    expect(await purgeUserObjects("user-1")).toEqual({ skipped: false, deleted: 3 });
    expect(store.keys()).toHaveLength(1);
    expect(store.keys()[0]?.startsWith("u/user-2/")).toBe(true);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("leaves storage alone when the flag is off, even with a store at hand", async () => {
    stubStorageEnv("false", STORAGE_ENV);
    const store = await seededStore();
    setObjectStoreForTests(store);
    const spy = vi.spyOn(store, "deleteByPrefix");
    expect(await purgeUserObjects("user-1")).toEqual({ skipped: true, deleted: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect(store.keys()).toHaveLength(4);
  });

  it("fails when the flag is on and the config is not usable", async () => {
    stubStorageEnv("true", {});
    expect(await codeOfAsync(() => purgeUserObjects("user-1"))).toBe("misconfigured");
  });

  it("fails when the bucket fails, instead of reporting a clean purge", async () => {
    stubStorageEnv("true", STORAGE_ENV);
    const store = await seededStore();
    setObjectStoreForTests(store);
    vi.spyOn(store, "deleteByPrefix").mockRejectedValue(
      new StorageError("unreachable", "object storage did not answer (TimeoutError)"),
    );
    expect(await codeOfAsync(() => purgeUserObjects("user-1"))).toBe("unreachable");
  });

  it("tags a blocked deletion so an alert can be built on it", async () => {
    stubStorageEnv("true", STORAGE_ENV);
    const store = await seededStore();
    setObjectStoreForTests(store);
    const failure = new StorageError("unreachable", "object storage did not answer (TimeoutError)");
    vi.spyOn(store, "deleteByPrefix").mockRejectedValue(failure);

    await expect(purgeUserObjects("user-1")).rejects.toBe(failure);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledWith(failure, {
      tags: { scope: "storage.purge", storageCode: "unreachable", retryable: "true" },
    });
    const output = logged(errorSpy);
    expect(output).toContain("[STORAGE] purge blocked (unreachable)");
    expectNoValue(output);
  });

  it("tags a misconfiguration the same way", async () => {
    stubStorageEnv("true", {});
    await codeOfAsync(() => purgeUserObjects("user-1"));
    expect(captureError.mock.calls[0]?.[1]).toMatchObject({
      tags: { scope: "storage.purge", storageCode: "misconfigured", retryable: "false" },
    });
  });
});
