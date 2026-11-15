/**
 * Web side of the Klorn Vault export (settings/_sections/vault-export.ts):
 * shown only when the server opened it to this user, mail text only on the
 * explicit toggle, a dated file name, and each refusal mapped to its copy.
 */

import { describe, expect, it } from "vitest";
import {
  vaultExportFailure,
  vaultExportUrl,
  vaultExportVisible,
  vaultFileName,
} from "../../../web/src/app/settings/_sections/vault-export";

describe("vaultExportVisible", () => {
  it("is true only when /me says the export is open to this user", () => {
    expect(vaultExportVisible({ vaultExport: true })).toBe(true);
    expect(vaultExportVisible({ vaultExport: false })).toBe(false);
    expect(vaultExportVisible({})).toBe(false);
    expect(vaultExportVisible(null)).toBe(false);
  });
});

describe("vaultExportUrl", () => {
  it("asks for mail text only when the toggle is on", () => {
    expect(vaultExportUrl("https://api.example", false)).toBe(
      "https://api.example/api/user/me/vault/export",
    );
    expect(vaultExportUrl("https://api.example", true)).toBe(
      "https://api.example/api/user/me/vault/export?bodies=1",
    );
  });
});

describe("vaultFileName", () => {
  it("names the download by the local date", () => {
    expect(vaultFileName(new Date(2026, 10, 4, 23, 30))).toBe("klorn-vault-2026-11-04.zip");
  });
});

describe("vaultExportFailure", () => {
  it("says when the user can export again after a recent export", () => {
    expect(vaultExportFailure(429, { code: "rate-limited", retryAfterSeconds: 61 })).toEqual({
      key: "vaultExport.error.cooldown",
      vars: { minutes: "2" },
    });
    expect(vaultExportFailure(429, { code: "rate-limited" })).toEqual({
      key: "vaultExport.error.cooldown",
      vars: { minutes: "10" },
    });
  });

  it("maps a running export, a busy server, a closed flag and anything else", () => {
    expect(vaultExportFailure(429, { code: "export-in-progress" })).toEqual({
      key: "vaultExport.error.inProgress",
    });
    expect(vaultExportFailure(503, { code: "exports-busy" })).toEqual({
      key: "vaultExport.error.busy",
    });
    expect(vaultExportFailure(404, null)).toEqual({ key: "vaultExport.error.unavailable" });
    expect(vaultExportFailure(500, "oops")).toEqual({ key: "vaultExport.error.failed" });
  });

  it("caps an absurd retry time", () => {
    expect(vaultExportFailure(429, { code: "rate-limited", retryAfterSeconds: 1e12 })).toEqual({
      key: "vaultExport.error.cooldown",
      vars: { minutes: "10" },
    });
  });
});
