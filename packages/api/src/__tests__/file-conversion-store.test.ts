import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getConversionResult,
  listConversionQualityReports,
  listConversionResults,
  saveConversionQualityReport,
  saveConversionResult,
} from "../mail/file-conversion-store.js";

describe("file conversion store", () => {
  const previousDir = process.env.EVE_CONVERSION_STORAGE_DIR;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "eve-conversion-store-test-"));
    process.env.EVE_CONVERSION_STORAGE_DIR = tempDir;
  });

  afterEach(async () => {
    if (previousDir === undefined) delete process.env.EVE_CONVERSION_STORAGE_DIR;
    else process.env.EVE_CONVERSION_STORAGE_DIR = previousDir;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists conversion binaries and metadata by user", async () => {
    const saved = await saveConversionResult({
      userId: "user-1",
      filename: "profile.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-test"),
      target: "pdf",
      fileCount: 1,
    });

    const list = await listConversionResults("user-1");
    const result = await getConversionResult("user-1", saved.id);
    const otherUserResult = await getConversionResult("user-2", saved.id);

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: saved.id, filename: "profile.pdf", target: "pdf" });
    expect(result?.buffer.toString("utf-8")).toBe("%PDF-test");
    expect(otherUserResult).toBeNull();
  });

  it("persists quality reports by user", async () => {
    const saved = await saveConversionQualityReport("user-1", {
      score: 88,
      generatedAt: new Date().toISOString(),
      passed: 4,
      warned: 0,
      blocked: 1,
      failed: 0,
      scenarios: [
        {
          id: "profile-json",
          label: "Profile JSON",
          category: "builtin",
          status: "pass",
          detail: "ok",
          durationMs: 1,
          outputBytes: 128,
        },
      ],
    });

    const ownReports = await listConversionQualityReports("user-1");
    const otherReports = await listConversionQualityReports("user-2");

    expect(ownReports).toHaveLength(1);
    expect(ownReports[0]).toMatchObject({ id: saved.id, score: 88 });
    expect(otherReports).toHaveLength(0);
  });
});
