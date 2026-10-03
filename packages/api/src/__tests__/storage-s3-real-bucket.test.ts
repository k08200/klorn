/**
 * The ObjectStore contract against a REAL S3-compatible bucket (step D1). It is
 * skipped unless every OBJECT_STORAGE_TEST_* variable is set, so the default
 * test run never touches a network or a bucket.
 *
 * To run it (Cloudflare R2, MinIO, Supabase Storage, …):
 *
 *   OBJECT_STORAGE_TEST_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
 *   OBJECT_STORAGE_TEST_REGION=auto \
 *   OBJECT_STORAGE_TEST_BUCKET=<a bucket kept for tests> \
 *   OBJECT_STORAGE_TEST_ACCESS_KEY_ID=… \
 *   OBJECT_STORAGE_TEST_SECRET_ACCESS_KEY=… \
 *   pnpm exec vitest run src/__tests__/storage-s3-real-bucket.test.ts
 *
 * The variables are separate from OBJECT_STORAGE_* on purpose: a developer's
 * production config must never be what a test run writes to. Use a dedicated
 * test bucket. The suite writes only under `u/ct-<uuid>/` and deletes what it
 * wrote. OBJECT_STORAGE_TEST_FORCE_PATH_STYLE is optional (default true).
 */

import { describe, it } from "vitest";
import { readS3StoreConfig } from "../storage/s3-config.js";
import { S3ObjectStore } from "../storage/s3-store.js";
import { describeObjectStoreContract } from "./helpers/object-store-contract.js";

const REQUIRED = [
  "OBJECT_STORAGE_TEST_ENDPOINT",
  "OBJECT_STORAGE_TEST_REGION",
  "OBJECT_STORAGE_TEST_BUCKET",
  "OBJECT_STORAGE_TEST_ACCESS_KEY_ID",
  "OBJECT_STORAGE_TEST_SECRET_ACCESS_KEY",
] as const;

const missing = REQUIRED.filter((name) => !process.env[name]?.trim());

if (missing.length === 0) {
  const config = readS3StoreConfig({
    OBJECT_STORAGE_ENDPOINT: process.env.OBJECT_STORAGE_TEST_ENDPOINT,
    OBJECT_STORAGE_REGION: process.env.OBJECT_STORAGE_TEST_REGION,
    OBJECT_STORAGE_BUCKET: process.env.OBJECT_STORAGE_TEST_BUCKET,
    OBJECT_STORAGE_ACCESS_KEY_ID: process.env.OBJECT_STORAGE_TEST_ACCESS_KEY_ID,
    OBJECT_STORAGE_SECRET_ACCESS_KEY: process.env.OBJECT_STORAGE_TEST_SECRET_ACCESS_KEY,
    OBJECT_STORAGE_FORCE_PATH_STYLE: process.env.OBJECT_STORAGE_TEST_FORCE_PATH_STYLE,
  } as NodeJS.ProcessEnv);
  describeObjectStoreContract(`real bucket ${config.bucket}`, {
    makeStore: (limits) => new S3ObjectStore(config, limits),
    fetchesSignedUrls: true,
  });
} else {
  describe.skip(`ObjectStore contract — real bucket: SKIPPED, no test bucket configured (set ${missing.join(", ")}; see the header of this file)`, () => {
    it("runs the ObjectStore contract against a real S3-compatible bucket", () => {
      // Skipped: see the suite name for what to set.
    });
  });
}
