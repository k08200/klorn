/**
 * Configuration of the S3-compatible store (step D1 of
 * docs/providers/unified-platform-plan.md). Every value comes from the
 * operator's environment. Nothing a user sends reaches the endpoint, the
 * bucket or the credentials.
 *
 * Validation names the variables that are wrong and never prints a value.
 */

import { isDevOrTestEnv } from "../env.js";
import { StorageError } from "./errors.js";

export interface S3StoreConfig {
  /** `https://<account>.r2.cloudflarestorage.com`, a MinIO URL, a Supabase S3 URL. */
  endpoint: string;
  /** `auto` on R2. */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * True: `<endpoint>/<bucket>/<key>` (R2, MinIO, Supabase Storage).
   * False: `<bucket>.<endpoint host>/<key>` (AWS S3).
   */
  forcePathStyle: boolean;
}

/** The environment variable behind each config field. */
export const S3_ENV_NAMES = {
  endpoint: "OBJECT_STORAGE_ENDPOINT",
  region: "OBJECT_STORAGE_REGION",
  bucket: "OBJECT_STORAGE_BUCKET",
  accessKeyId: "OBJECT_STORAGE_ACCESS_KEY_ID",
  secretAccessKey: "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  forcePathStyle: "OBJECT_STORAGE_FORCE_PATH_STYLE",
} as const satisfies Record<keyof S3StoreConfig, string>;

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_PATTERN = /^[a-z0-9-]{1,32}$/;
const NO_WHITESPACE_PATTERN = /^\S+$/;
const TRUE_WORDS = new Set(["true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

function isUsableEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // Plain http is for a local MinIO in development and tests, nowhere else:
  // an upload is sent with an unsigned payload and relies on TLS.
  const schemeOk = url.protocol === "https:" || (url.protocol === "http:" && isDevOrTestEnv());
  return schemeOk && !url.username && !url.password && !url.search && !url.hash;
}

function isUsableBucket(value: string): boolean {
  return BUCKET_PATTERN.test(value) && !value.includes("..");
}

/** The fields of a config that cannot be used, by field name. Empty when it is fine. */
export function invalidS3ConfigFields(config: S3StoreConfig): Array<keyof S3StoreConfig> {
  const checks: Record<keyof S3StoreConfig, boolean> = {
    endpoint: typeof config.endpoint === "string" && isUsableEndpoint(config.endpoint),
    region: typeof config.region === "string" && REGION_PATTERN.test(config.region),
    bucket: typeof config.bucket === "string" && isUsableBucket(config.bucket),
    accessKeyId:
      typeof config.accessKeyId === "string" && NO_WHITESPACE_PATTERN.test(config.accessKeyId),
    secretAccessKey:
      typeof config.secretAccessKey === "string" &&
      NO_WHITESPACE_PATTERN.test(config.secretAccessKey),
    forcePathStyle: typeof config.forcePathStyle === "boolean",
  };
  return (Object.keys(checks) as Array<keyof S3StoreConfig>).filter((field) => !checks[field]);
}

/** Throws `misconfigured`, naming fields only, unless the config is usable. */
export function assertS3StoreConfig(config: S3StoreConfig): void {
  const invalid = invalidS3ConfigFields(config);
  if (invalid.length > 0) {
    throw new StorageError(
      "misconfigured",
      `object storage config is missing or invalid: ${invalid.join(", ")}`,
    );
  }
}

function parsePathStyle(raw: string): boolean | undefined {
  const value = raw.toLowerCase();
  if (value === "" || TRUE_WORDS.has(value)) return true;
  if (FALSE_WORDS.has(value)) return false;
  return undefined;
}

/**
 * Read and validate the store config from the environment. Throws
 * `misconfigured` with the NAMES of the variables that are missing or invalid.
 */
export function readS3StoreConfig(env: NodeJS.ProcessEnv = process.env): S3StoreConfig {
  const read = (field: keyof S3StoreConfig) => (env[S3_ENV_NAMES[field]] ?? "").trim();
  const forcePathStyle = parsePathStyle(read("forcePathStyle"));
  const config: S3StoreConfig = {
    endpoint: read("endpoint"),
    region: read("region"),
    bucket: read("bucket"),
    accessKeyId: read("accessKeyId"),
    secretAccessKey: read("secretAccessKey"),
    forcePathStyle: forcePathStyle ?? true,
  };
  const invalid = invalidS3ConfigFields(config).map((field) => S3_ENV_NAMES[field]);
  if (forcePathStyle === undefined) invalid.push(S3_ENV_NAMES.forcePathStyle);
  if (invalid.length > 0) {
    throw new StorageError(
      "misconfigured",
      `OBJECT_STORAGE_ENABLED is on but these variables are missing or invalid: ${invalid.join(", ")}`,
    );
  }
  return config;
}
