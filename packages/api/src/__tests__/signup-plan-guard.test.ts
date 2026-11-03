/**
 * Founder decision 2026-10-24: a new account starts on FREE and gets Pro only
 * by paying (Paddle/Stripe/IAP webhooks) or from an admin setting the plan.
 * This is a static tripwire over packages/api/src: every User create/upsert
 * must be a literal object that never names `plan`, may spread only an inline
 * `cond ? { … } : {}` literal (so a helper like the deleted beta auto-PRO
 * grant can't be spread in), and the retired switch must stay unread. It is
 * not a proof — a post-create `user.update` would slip past it — so the
 * per-door behaviour tests (routes-auth, routes-auth-google-callback-pinned,
 * routes-social-auth) are what pin each signup path to FREE.
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

const USER_CREATE = /\buser\s*\.\s*(create|upsert|createMany|createManyAndReturn)\s*\(/g;

/** Comments may say anything ("signup-plan-guard"); only code counts. */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The full argument text (comments stripped) of every `<receiver>.user.create(…)`-style call. */
function userCreateCalls(text: string): string[] {
  const calls: string[] = [];
  for (const match of text.matchAll(USER_CREATE)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      if (text[i] === ")") depth -= 1;
      if (depth === 0) {
        calls.push(withoutComments(text.slice(open, i + 1)));
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

const calls = files.flatMap((f) => userCreateCalls(f.text).map((call) => ({ path: f.path, call })));

describe("signup never grants a plan", () => {
  it("sees exactly the known User create sites", () => {
    // Email/password register, Google (web + desktop), Apple/Naver, and the
    // dev-only demo upsert. A new site must be reviewed here deliberately:
    // extend this list only after checking it can't set a plan.
    expect(calls.map((c) => c.path).sort()).toEqual(
      ["auth.ts", "auth/social-login.ts", "routes/auth.ts", "routes/auth.ts"].sort(),
    );
  });

  it("no User create/upsert names `plan` in any form", () => {
    // Catches `plan: …`, shorthand `{ plan }`, `"plan":` and `["plan"]`.
    const offenders = calls.filter((c) => /\bplan\b/.test(c.call)).map((c) => c.path);
    expect(offenders).toEqual([]);
  });

  it("User creates take a literal data object and spread only inline literals", () => {
    const offenders = calls
      .filter(
        (c) =>
          // data/create built elsewhere: `{ data }`, `data: someVar`, `create: x`
          /\b(data|create)\s*(?=[,}])|\b(data|create)\s*:(?!\s*\{)/.test(c.call) ||
          // any spread other than `...(cond ? { … } : {})`
          [...c.call.matchAll(/\.\.\./g)].some(
            (m) => !/^\.\.\.\(\s*[\w.]+\s*\?\s*\{/.test(c.call.slice(m.index)),
          ),
      )
      .map((c) => c.path);
    expect(offenders).toEqual([]);
  });

  it("no nested or raw User inserts", () => {
    const offenders = files
      .filter(
        (f) =>
          /\buser\s*:\s*\{\s*(create|connectOrCreate)\b/.test(f.text) ||
          /INSERT\s+INTO\s+"?User"?\b/i.test(f.text),
      )
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("nothing reads the retired BETA_AUTO_PRO_* flags or stamps betaProGrantedAt", () => {
    const offenders = files
      .filter((f) => /BETA_AUTO_PRO|betaProGrantedAt|evaluateBetaAutoPro/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
