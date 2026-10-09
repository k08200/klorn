/**
 * Reading the S3 store config from the environment (step D1). A wrong variable
 * is named; a value is never printed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageError } from "../storage/errors.js";
import { readS3StoreConfig } from "../storage/s3-config.js";

const SECRET = "s3cr3t-value-that-must-not-be-printed";
const VALID = {
  OBJECT_STORAGE_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  OBJECT_STORAGE_REGION: "auto",
  OBJECT_STORAGE_BUCKET: "klorn-objects",
  OBJECT_STORAGE_ACCESS_KEY_ID: "ACCESSKEYID123",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: SECRET,
} as const;

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...VALID, ...overrides } as NodeJS.ProcessEnv;
}

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof StorageError && err.code === "misconfigured") return err.message;
    throw err;
  }
  return "";
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readS3StoreConfig", () => {
  it("reads a complete environment, path style by default", () => {
    expect(readS3StoreConfig(env())).toEqual({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "klorn-objects",
      accessKeyId: "ACCESSKEYID123",
      secretAccessKey: SECRET,
      forcePathStyle: true,
    });
  });

  it("trims the whitespace a pasted value brings along", () => {
    const config = readS3StoreConfig(
      env({ OBJECT_STORAGE_BUCKET: " klorn-objects\n", OBJECT_STORAGE_REGION: "auto " }),
    );
    expect(config.bucket).toBe("klorn-objects");
    expect(config.region).toBe("auto");
  });

  it("names every missing variable and prints no value", () => {
    const message = messageOf(() =>
      readS3StoreConfig({ OBJECT_STORAGE_SECRET_ACCESS_KEY: SECRET } as NodeJS.ProcessEnv),
    );
    expect(message).toContain("OBJECT_STORAGE_ENDPOINT");
    expect(message).toContain("OBJECT_STORAGE_REGION");
    expect(message).toContain("OBJECT_STORAGE_BUCKET");
    expect(message).toContain("OBJECT_STORAGE_ACCESS_KEY_ID");
    expect(message).not.toContain("OBJECT_STORAGE_SECRET_ACCESS_KEY");
    expect(message).not.toContain(SECRET);
  });

  it("names the secret when it is the one missing", () => {
    const message = messageOf(() =>
      readS3StoreConfig(env({ OBJECT_STORAGE_SECRET_ACCESS_KEY: "" })),
    );
    expect(message).toContain("OBJECT_STORAGE_SECRET_ACCESS_KEY");
  });

  it.each([
    ["not a URL", "r2.cloudflarestorage.com"],
    ["credentials in the URL", "https://key:secret@acct.r2.cloudflarestorage.com"],
    ["a query string", "https://acct.r2.cloudflarestorage.com/?x=1"],
    ["a fragment", "https://acct.r2.cloudflarestorage.com/#x"],
    ["another scheme", "ftp://acct.r2.cloudflarestorage.com"],
  ])("refuses an endpoint with %s", (_label, endpoint) => {
    const message = messageOf(() => readS3StoreConfig(env({ OBJECT_STORAGE_ENDPOINT: endpoint })));
    expect(message).toContain("OBJECT_STORAGE_ENDPOINT");
    expect(message).not.toContain("secret@");
  });

  it("allows plain http for a local MinIO in development and tests only", () => {
    const local = env({ OBJECT_STORAGE_ENDPOINT: "http://localhost:9000" });
    expect(readS3StoreConfig(local).endpoint).toBe("http://localhost:9000");

    vi.stubEnv("NODE_ENV", "production");
    expect(messageOf(() => readS3StoreConfig(local))).toContain("OBJECT_STORAGE_ENDPOINT");
    vi.stubEnv("NODE_ENV", "staging");
    expect(messageOf(() => readS3StoreConfig(local))).toContain("OBJECT_STORAGE_ENDPOINT");
  });

  it.each([
    "Klorn-Objects",
    "a/b",
    "../x",
    "a..b",
    "ab",
    "-abc",
    "a b",
  ])("refuses the bucket name %j", (bucket) => {
    expect(messageOf(() => readS3StoreConfig(env({ OBJECT_STORAGE_BUCKET: bucket })))).toContain(
      "OBJECT_STORAGE_BUCKET",
    );
  });

  it("refuses a region or a credential with whitespace inside", () => {
    expect(messageOf(() => readS3StoreConfig(env({ OBJECT_STORAGE_REGION: "eu west" })))).toContain(
      "OBJECT_STORAGE_REGION",
    );
    expect(
      messageOf(() => readS3StoreConfig(env({ OBJECT_STORAGE_ACCESS_KEY_ID: "abc def" }))),
    ).toContain("OBJECT_STORAGE_ACCESS_KEY_ID");
    const message = messageOf(() =>
      readS3StoreConfig(env({ OBJECT_STORAGE_SECRET_ACCESS_KEY: "abc\tdef" })),
    );
    expect(message).toContain("OBJECT_STORAGE_SECRET_ACCESS_KEY");
    expect(message).not.toContain("abc\tdef");
  });

  it("reads the addressing style leniently and refuses a word it does not know", () => {
    const style = (value: string) =>
      readS3StoreConfig(env({ OBJECT_STORAGE_FORCE_PATH_STYLE: value })).forcePathStyle;
    expect(style("true")).toBe(true);
    expect(style("ON")).toBe(true);
    expect(style("")).toBe(true);
    expect(style("false")).toBe(false);
    expect(style("0")).toBe(false);
    expect(style("No")).toBe(false);
    expect(
      messageOf(() => readS3StoreConfig(env({ OBJECT_STORAGE_FORCE_PATH_STYLE: "maybe" }))),
    ).toContain("OBJECT_STORAGE_FORCE_PATH_STYLE");
  });
});
