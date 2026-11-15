import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEnvFile, upsertEnvVar } from "../lib/env-file.js";

function envFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "klorn-cli-env-")), ".env.selfhost");
  writeFileSync(path, content);
  chmodSync(path, 0o600);
  return path;
}

describe("readEnvFile", () => {
  it("parses the compose env-file format", () => {
    const path = envFile(
      '# comment\nPOSTGRES_PASSWORD=abc\nJWT_SECRET="quoted value"\nEMPTY=\nWEB_URL=http://x:3000 # trailing\n',
    );
    expect(readEnvFile(path)).toMatchObject({
      POSTGRES_PASSWORD: "abc",
      JWT_SECRET: "quoted value",
      EMPTY: "",
    });
  });
});

describe("upsertEnvVar", () => {
  it("replaces an existing assignment and leaves every other line untouched", () => {
    const original = "# keep me\nA=1\nKLORN_VERSION=0.4.0\nB=two # note\n";
    const path = envFile(original);
    upsertEnvVar(path, "KLORN_VERSION", "0.4.1");
    expect(readFileSync(path, "utf8")).toBe("# keep me\nA=1\nKLORN_VERSION=0.4.1\nB=two # note\n");
  });

  it("appends when the key is only present as a comment", () => {
    const path = envFile("A=1\n# KLORN_VERSION=latest");
    upsertEnvVar(path, "KLORN_VERSION", "0.4.1");
    expect(readFileSync(path, "utf8")).toBe("A=1\n# KLORN_VERSION=latest\nKLORN_VERSION=0.4.1\n");
  });

  it("keeps the file's permissions (it holds secrets)", () => {
    const path = envFile("A=1\n");
    upsertEnvVar(path, "KLORN_VERSION", "latest");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("rewrites the target of a symlinked env file and keeps the link", () => {
    const real = envFile("A=1\n");
    const link = join(mkdtempSync(join(tmpdir(), "klorn-cli-env-")), ".env.selfhost");
    symlinkSync(real, link);
    upsertEnvVar(link, "KLORN_VERSION", "0.4.1");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("A=1\nKLORN_VERSION=0.4.1\n");
  });

  it("handles export prefixes, duplicates and a missing trailing newline", () => {
    const path = envFile("export KLORN_VERSION=0.3.0\nB=2\nKLORN_VERSION=0.3.1");
    upsertEnvVar(path, "KLORN_VERSION", "0.4.1");
    expect(readFileSync(path, "utf8")).toBe("export KLORN_VERSION=0.4.1\nB=2\nKLORN_VERSION=0.4.1");
  });

  it("refuses values that could inject another line", () => {
    const path = envFile("A=1\n");
    expect(() => upsertEnvVar(path, "KLORN_VERSION", "1\nJWT_SECRET=x")).toThrow();
    expect(() => upsertEnvVar(path, "bad key", "1")).toThrow();
    expect(readFileSync(path, "utf8")).toBe("A=1\n");
  });
});
