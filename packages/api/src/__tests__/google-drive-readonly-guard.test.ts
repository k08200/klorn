/**
 * D5, decision V4: Klorn never changes a Google Drive file. drive.file has no
 * read-only variant (a token that can read a picked file can also write it), so
 * the code holds the rule: no module of the Google Drive connector may name a
 * Drive write. This fails for `files.create|update|delete|copy|emptyTrash`, and
 * for anything under `permissions.` or `revisions.`, anywhere in the
 * connector's source (code or comment: naming one is the start of calling it).
 *
 * The connector is every module whose job is Google Drive: drive/providers/
 * google*.ts, drive/google-*.ts and routes/google-drive-*.ts, plus the web
 * Picker loader.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const webLibDir = join(srcDir, "../../web/src/lib");

const CONNECTOR_FILE = [
  /^drive\/providers\/google[\w-]*\.ts$/,
  /^drive\/google-[\w-]+\.ts$/,
  /^routes\/google-drive-[\w-]+\.ts$/,
];

const DRIVE_WRITE = [
  /\bfiles\s*\.\s*(create|update|delete|copy|emptyTrash)\b/,
  /\bfiles\s*\[\s*["'`](create|update|delete|copy|emptyTrash)["'`]\s*\]/,
  /\bpermissions\s*\./,
  /\brevisions\s*\./,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

const connector = [
  ...sourceFiles(srcDir)
    .map((full) => ({ path: relative(srcDir, full), full }))
    .filter((f) => CONNECTOR_FILE.some((pattern) => pattern.test(f.path))),
  { path: "web:lib/google-picker.ts", full: join(webLibDir, "google-picker.ts") },
].map((f) => ({ path: f.path, text: readFileSync(f.full, "utf8") }));

const namesAWrite = (text: string) => DRIVE_WRITE.some((pattern) => pattern.test(text));

describe("the Google Drive connector names no Drive write (V4)", () => {
  it("scans the connector's modules (so this guard cannot pass by scanning nothing)", () => {
    const paths = connector.map((f) => f.path);
    for (const expected of [
      "drive/providers/google.ts",
      "drive/providers/google-auth.ts",
      "drive/providers/google-files.ts",
      "drive/google-drive-picker.ts",
      "drive/google-drive-refresh.ts",
      "drive/google-drive-refresh-job.ts",
      "routes/google-drive-link.ts",
      "web:lib/google-picker.ts",
    ]) {
      expect(paths).toContain(expected);
    }
    // The reads it does make are there to be seen.
    expect(connector.find((f) => f.path === "drive/providers/google.ts")?.text).toMatch(
      /\bfiles\.get\(/,
    );
  });

  it.each(connector.map((f) => [f.path, f.text] as const))("%s names no write", (_path, text) => {
    expect(namesAWrite(text)).toBe(false);
  });

  it("beyond the named writes, the connector calls only files.get, files.list and files.export (an allowlist)", () => {
    // modifyLabels, watch and generateIds are not writes Google lists as such,
    // but none is a read the connector needs; a raw `.request(` would reach any
    // endpoint; comments, replies and drives are other resources. `export` is
    // D5d's text export of a Google format for its summary, only in google.ts.
    const READS = new Set(["get", "list", "export"]);
    for (const { path, text } of connector) {
      const methods = [...text.matchAll(/\bfiles\s*\.\s*(\w+)\s*\(/g)].map((m) => m[1]);
      expect(
        methods.filter((m) => !READS.has(m ?? "")),
        path,
      ).toEqual([]);
      if (path !== "drive/providers/google.ts") expect(methods, path).not.toContain("export");
      expect(text, path).not.toMatch(/\.request\s*\(|\b(comments|replies|drives)\s*\./);
    }
    const google = connector.find((f) => f.path === "drive/providers/google.ts")?.text ?? "";
    expect(google.match(/\bfiles\.export\(/g)).toHaveLength(1);
  });

  it("the detector sees each write, however it is spelt", () => {
    for (const text of [
      "api.files.create({ requestBody })",
      "drive.files.update({ fileId })",
      "drive.files . delete({ fileId })",
      "drive.files.copy({ fileId })",
      "drive.files.emptyTrash()",
      'drive.files["update"]({ fileId })',
      "drive.permissions.create({ fileId })",
      "drive.revisions.list({ fileId })",
    ]) {
      expect(namesAWrite(text), text).toBe(true);
    }
    for (const text of ["drive.files.get({ fileId })", "drive.files.list({ q })", "updatedAt"]) {
      expect(namesAWrite(text), text).toBe(false);
    }
  });
});
