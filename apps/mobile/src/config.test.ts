import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEV_API_BASE, PROD_API_BASE, resolveApiBase, validateApiBase } from "./config";

describe("API base", () => {
  it("defaults to the shipped prod origin, and localhost in dev", () => {
    expect(resolveApiBase(undefined, false)).toBe(PROD_API_BASE);
    expect(resolveApiBase(undefined, true)).toBe(DEV_API_BASE);
    expect(resolveApiBase("https://api.klorn.ai/", false)).toBe("https://api.klorn.ai");
  });

  it("never sends the token off-TLS to a remote host", () => {
    expect(validateApiBase("http://evil.example")).toBeNull();
    expect(validateApiBase("ftp://x")).toBeNull();
    expect(validateApiBase("http://localhost:3001")).toBe("http://localhost:3001");
    expect(validateApiBase("http://10.0.2.2:3001")).toBe("http://10.0.2.2:3001");
  });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("package boundaries", () => {
  const sources = files(join(__dirname)).filter((f) => /\.(ts|tsx)$/.test(f));

  it("imports @klorn/contract as types only", () => {
    let seen = 0;
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\b(import|export)\s+([^;]*?)\s*from\s+"@klorn\/contract"/g)) {
        seen++;
        expect(m[2], file).toMatch(/^type\s/);
      }
    }
    expect(seen).toBeGreaterThan(5);
  });

  it("never imports runtime code from another package", () => {
    for (const file of sources) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from "(\.\.\/){3,}(packages|apps)\//);
    }
  });
});

describe("design tokens", () => {
  it("the two dark-theme blocks are identical", () => {
    const css = readFileSync(join(__dirname, "styles/tokens.css"), "utf8");
    const media = css.match(/:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/)?.[1];
    const forced = css.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)?.[1];
    expect(media).toBeTruthy();
    const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    expect(norm(media)).toBe(norm(forced));
  });
});
