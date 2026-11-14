/**
 * The streaming ZIP writer behind the Klorn Vault download
 * (vault/zip-writer.ts): a well-formed archive (CRC, sizes, central
 * directory), UTF-8 names flagged as such, no ZIP64, and a zip-slip guard
 * that refuses any name an extractor could resolve outside its folder.
 */

import { describe, expect, it } from "vitest";
import { assertSafeEntryName, ZIP_MAX_ENTRIES, ZipWriter } from "../vault/zip-writer.js";
import { readZip } from "./helpers/read-zip.js";

const UTF8_FLAG = 0x0800;
const AT = new Date("2026-11-14T01:02:04Z");

function archiveOf(files: Record<string, string>): Buffer {
  const zip = new ZipWriter(AT);
  const parts = Object.entries(files).map(([name, text]) => zip.entry(name, text));
  return Buffer.concat([...parts, zip.finish()]);
}

describe("ZipWriter", () => {
  it("writes an archive whose entries read back byte for byte", () => {
    const archive = archiveOf({
      "Klorn/_klorn.md": "# Klorn vault\n",
      "Klorn/mail/2026/11/2026-11-12-내일-회의-1a2b3c4d.md": "내일 3시 회의\n".repeat(200),
    });
    const entries = readZip(archive);
    expect([...entries.keys()]).toEqual([
      "Klorn/_klorn.md",
      "Klorn/mail/2026/11/2026-11-12-내일-회의-1a2b3c4d.md",
    ]);
    expect(entries.get("Klorn/_klorn.md")?.content.toString("utf8")).toBe("# Klorn vault\n");
    expect(
      entries.get("Klorn/mail/2026/11/2026-11-12-내일-회의-1a2b3c4d.md")?.content.toString("utf8"),
    ).toBe("내일 3시 회의\n".repeat(200));
  });

  it("flags names as UTF-8 and deflates text that compresses", () => {
    const entries = readZip(archiveOf({ "Klorn/a.md": "x".repeat(10_000) }));
    const entry = entries.get("Klorn/a.md");
    expect((entry?.flags ?? 0) & UTF8_FLAG).toBe(UTF8_FLAG);
    expect(entry?.method).toBe(8);
  });

  it("stores an entry that deflate would only grow", () => {
    const entries = readZip(archiveOf({ "Klorn/a.md": "" }));
    expect(entries.get("Klorn/a.md")?.method).toBe(0);
  });

  it("tracks the bytes written so far", () => {
    const zip = new ZipWriter(AT);
    const first = zip.entry("Klorn/a.md", "hello");
    expect(zip.bytesWritten).toBe(first.length);
    const end = zip.finish();
    expect(zip.bytesWritten).toBe(first.length + end.length);
  });

  it("refuses a duplicate name, an entry after finish and a second finish", () => {
    const zip = new ZipWriter(AT);
    zip.entry("Klorn/a.md", "1");
    expect(() => zip.entry("Klorn/a.md", "2")).toThrow(/duplicate/);
    zip.finish();
    expect(() => zip.entry("Klorn/b.md", "3")).toThrow(/finished/);
    expect(() => zip.finish()).toThrow(/finished/);
  });

  it("stays below the ZIP64 entry limit", () => {
    expect(ZIP_MAX_ENTRIES).toBeLessThan(0xffff);
  });
});

describe("assertSafeEntryName (zip-slip guard)", () => {
  it.each([
    "../evil.md",
    "Klorn/../../evil.md",
    "/etc/passwd",
    "C:/Windows/evil.md",
    "C:evil.md",
    "Klorn\\..\\evil.md",
    "Klorn/./a.md",
    "Klorn//a.md",
    "Klorn/a\u0000.md",
    "Klorn/a\n.md",
    "",
    "Klorn/",
  ])("refuses %j", (name) => {
    expect(() => assertSafeEntryName(name)).toThrow();
    const zip = new ZipWriter(AT);
    expect(() => zip.entry(name, "x")).toThrow();
  });

  it("accepts a plain relative path", () => {
    expect(() => assertSafeEntryName("Klorn/mail/2026/11/a.md")).not.toThrow();
  });
});
