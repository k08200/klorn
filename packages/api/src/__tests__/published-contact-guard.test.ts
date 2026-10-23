/**
 * Klorn's published contact address is k0820086@gmail.com (founder decision,
 * LOCKED). klorn.ai has no MX record, so any `@klorn.ai` address shown to people
 * bounces; once the Klorn mailbox's MX exists (workstream E), an unknown address
 * there is dropped (L17). So no page, policy or contributor document may publish
 * one: the web app, the marketing site, the apps and the Markdown files people
 * read. The plan and the OAuth-verification notes discuss such addresses, they
 * do not publish them, and are left out.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

const SCANNED_DIRS = ["packages/web/src", "website", "apps/desktop-mac/Sources", "apps/mobile/src"];
const SKIPPED_PATH = /(__tests__|\.test\.|\.spec\.|node_modules|\/build\/|\/dist\/|\.next)/;
const TEXT_FILE = /\.(tsx?|jsx?|html|md|swift|json)$/;
const KLORN_ADDRESS = /[a-z0-9._%+-]+@klorn\.ai\b/gi;

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    if (SKIPPED_PATH.test(path)) return [];
    return statSync(path).isDirectory() ? walk(path) : TEXT_FILE.test(path) ? [path] : [];
  });
}

function publishedFiles(): string[] {
  const rootMarkdown = readdirSync(repoRoot)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(repoRoot, name));
  const docs = ["docs/EDITIONS.md"].map((path) => join(repoRoot, path));
  return [...rootMarkdown, ...docs, ...SCANNED_DIRS.flatMap((dir) => walk(join(repoRoot, dir)))];
}

describe("published contact addresses", () => {
  it("never show an @klorn.ai address", () => {
    const offenders = publishedFiles().flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return [...text.matchAll(KLORN_ADDRESS)].map(
        (match) => `${relative(repoRoot, file)}: ${match[0]}`,
      );
    });
    expect(offenders).toEqual([]);
  });

  it("scans the files people read", () => {
    const scanned = publishedFiles().map((file) => relative(repoRoot, file));
    expect(scanned).toContain("CODE_OF_CONDUCT.md");
    expect(scanned).toContain("SECURITY.md");
    expect(scanned).toContain("docs/EDITIONS.md");
    expect(scanned).toContain("packages/web/src/app/billing/page.tsx");
  });
});
