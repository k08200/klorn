/**
 * Founder decision 2026-10-24: a new account starts on FREE and gets Pro only
 * by paying (Paddle/Stripe/IAP webhooks) or from an admin setting the plan.
 * This guard keeps a later signup path from quietly comping Pro again: no
 * code that creates a User may set `plan`, and the retired beta auto-PRO
 * switch must stay unread.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(path);
    }
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/** The full argument text of every `<receiver>.user.create(` / `.user.upsert(` call. */
function userCreateCalls(text: string): string[] {
  const calls: string[] = [];
  for (const match of text.matchAll(/\buser\.(create|upsert)\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      if (text[i] === ")") depth -= 1;
      if (depth === 0) {
        calls.push(text.slice(open, i + 1));
        break;
      }
    }
  }
  return calls;
}

const files = sourceFiles(SRC).map((path) => ({
  path: path.slice(SRC.length),
  text: readFileSync(path, "utf8"),
}));

describe("signup never grants a plan", () => {
  it("finds the signup doors it is guarding", () => {
    // Email/password register, Google (web + desktop), Apple/Naver. If this
    // drops, the scan stopped seeing them — fix the scan, not the count.
    const creates = files.flatMap((f) =>
      userCreateCalls(f.text).filter((c) => c.startsWith("({") || c.includes("data:")),
    );
    expect(creates.length).toBeGreaterThanOrEqual(3);
  });

  it("no User create/upsert sets plan", () => {
    const offenders = files.flatMap((f) =>
      userCreateCalls(f.text)
        .filter((call) => /\bplan\s*:/.test(call))
        .map(() => f.path),
    );
    expect(offenders).toEqual([]);
  });

  it("nothing reads the retired BETA_AUTO_PRO_* flags or stamps betaProGrantedAt", () => {
    const offenders = files
      .filter((f) => /BETA_AUTO_PRO|betaProGrantedAt|evaluateBetaAutoPro/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
