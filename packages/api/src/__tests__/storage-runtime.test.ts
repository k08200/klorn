/**
 * The flag gate around object storage (step D1): while OBJECT_STORAGE_ENABLED is
 * off nothing is built, read or connected; while it is on, a bad config is
 * reported by name and a purge fails rather than skip.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const s3 = vi.hoisted(() => ({
  constructed: [] as unknown[],
  ping: vi.fn(async () => {}),
}));

vi.mock("../storage/s3-store.js", () => ({
  S3ObjectStore: class {
    constructor(config: unknown) {
      s3.constructed.push(config);
    }
    ping = s3.ping;
  },
}));

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
import { bytesOf, codeOf, codeOfAsync } from "./helpers/storage-bytes.js";

const SECRET = "runtime-secret-that-must-never-be-logged";
const ACCESS_KEY = "RUNTIMEACCESSKEY01";
const STORAGE_ENV = {
  OBJECT_STORAGE_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
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

let fetchSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  s3.constructed.length = 0;
  s3.ping.mockReset().mockResolvedValue(undefined);
  captureError.mockReset();
  setObjectStoreForTests(null);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in this test"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setObjectStoreForTests(null);
});

describe("flag OFF", () => {
  it.each([
    ["unset", undefined],
    ["false", "false"],
    ["empty", ""],
    ["a word that is not a yes", "enabled"],
  ])("is inert when the flag is %s: no client, no env needed, no connection", async (_l, flag) => {
    stubStorageEnv(flag);

    expect(getObjectStore()).toBeNull();
    expect(getUserStorage()).toBeNull();
    expect(await checkObjectStorageAtStartup()).toEqual({ state: "disabled" });
    expect(await purgeUserObjects("user-1")).toEqual({ skipped: true, deleted: 0 });

    expect(s3.constructed).toHaveLength(0);
    expect(s3.ping).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(captureError).not.toHaveBeenCalled();
  });

  it("stays inert even when the variables are present and valid", async () => {
    stubStorageEnv("off", STORAGE_ENV);
    expect(getObjectStore()).toBeNull();
    expect(await checkObjectStorageAtStartup()).toEqual({ state: "disabled" });
    expect(s3.constructed).toHaveLength(0);
  });

  it("does not hand out a store that was built while the flag was on", () => {
    stubStorageEnv("true", STORAGE_ENV);
    expect(getObjectStore()).not.toBeNull();
    vi.stubEnv("OBJECT_STORAGE_ENABLED", "false");
    expect(getObjectStore()).toBeNull();
  });
});

describe("flag ON", () => {
  it.each(["true", "1", "yes", "on", " TRUE "])("reads %j as on", (flag) => {
    stubStorageEnv(flag, STORAGE_ENV);
    expect(getObjectStore()).not.toBeNull();
  });

  it("builds one client from the environment and reuses it", () => {
    stubStorageEnv("true", STORAGE_ENV);
    const first = getObjectStore();
    expect(getObjectStore()).toBe(first);
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

  it("refuses to hand out a store when a variable is missing", () => {
    stubStorageEnv("true", { ...STORAGE_ENV, OBJECT_STORAGE_BUCKET: "" });
    expect(codeOf(() => getObjectStore())).toBe("misconfigured");
    expect(codeOf(() => getUserStorage())).toBe("misconfigured");
    expect(s3.constructed).toHaveLength(0);
  });
});

describe("checkObjectStorageAtStartup", () => {
  it("reports a healthy bucket and logs no credential", async () => {
    stubStorageEnv("true", STORAGE_ENV);
    expect(await checkObjectStorageAtStartup()).toEqual({
      state: "ok",
      bucket: "klorn-objects",
      host: "acct.r2.cloudflarestorage.com",
    });
    expect(s3.ping).toHaveBeenCalledTimes(1);
    const output = logged(logSpy, errorSpy);
    expect(output).toContain("klorn-objects");
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(ACCESS_KEY);
  });

  it("names the wrong variables, reports them, and does not throw", async () => {
    stubStorageEnv("true", { OBJECT_STORAGE_SECRET_ACCESS_KEY: SECRET });
    const health = await checkObjectStorageAtStartup();
    expect(health).toMatchObject({ state: "misconfigured", code: "misconfigured" });
    const output = logged(errorSpy);
    expect(output).toContain("OBJECT_STORAGE_BUCKET");
    expect(output).toContain("OBJECT_STORAGE_ENDPOINT");
    expect(output).not.toContain(SECRET);
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
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(ACCESS_KEY);
    expect(captureError).toHaveBeenCalledTimes(1);
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
});
