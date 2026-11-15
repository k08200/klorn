/**
 * In the Slack, KakaoTalk-import and PIM modules, a caught failure reaches
 * Sentry and the console as facts, never as itself.
 *
 * Their catches wrap Prisma calls over other people's words: a Slack message,
 * an imported KakaoTalk line, a reminder whose title quotes a mail subject, a
 * calendar event. A PrismaClientValidationError renders the rejected call's
 * arguments into its message, and a raw-query failure carries Postgres's
 * message, which can quote a value; Sentry sends the message and Node's
 * console prints it. So every catch in these directories reports through
 * report-db-failure.ts (a fixed label plus dbFailureFacts) or the LLM
 * reporters, and never hands the caught value, an alias of it, or its message
 * to captureError / Sentry, console.* or a pino logger.
 *
 * Unlike the LLM guard, every catch here counts: these modules do little else
 * than read and write such rows. Scanning rules are shared
 * (helpers/catch-sink-scan.ts).
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanCatches, type Violation, walk } from "./helpers/catch-sink-scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..");

/** The modules whose catches all handle content-bearing rows. */
const GUARDED_DIRS = ["slack", "kakao-import", "pim"] as const;

const everyCatch = () => true;

function scanGuardedDirs(): { violations: Violation[]; catches: Map<string, number> } {
  const violations: Violation[] = [];
  const catches = new Map<string, number>();
  for (const dir of GUARDED_DIRS) {
    for (const full of walk(join(srcDir, dir))) {
      const file = relative(srcDir, full).split("\\").join("/");
      const result = scanCatches(file, readFileSync(full, "utf8"), everyCatch);
      violations.push(...result.violations);
      catches.set(dir, (catches.get(dir) ?? 0) + result.taintedCatches);
    }
  }
  return { violations, catches };
}

describe("database failure redaction guard (slack, kakao-import, pim)", () => {
  const scan = scanGuardedDirs();

  it("finds no catch that hands a caught failure to Sentry, the console or the log", () => {
    const offenders = scan.violations.map((v) => `${v.file}:${v.line}  ${v.text.slice(0, 160)}`);
    expect(offenders).toEqual([]);
  });

  it("cannot pass vacuously: it sees catches in every guarded directory", () => {
    for (const dir of GUARDED_DIRS) {
      expect(scan.catches.get(dir) ?? 0, dir).toBeGreaterThan(0);
    }
  });
});

describe("the database guard itself", () => {
  const scanned = (body: string) =>
    scanCatches(
      "bad.ts",
      `async function f() { try { await prisma.slackMessage.create({ data }); } catch (err) { ${body} } }`,
      everyCatch,
    ).violations;

  it.each([
    ["captureError(err)", "captureError(err, { tags: { scope: 'x' } });"],
    ["console.error with the error", "console.error('[X] failed:', err);"],
    ["the message in a template", "console.warn(`[X] failed: ${(err as Error).message}`);"],
  ])("flags %s", (_label, body) => {
    expect(scanned(body)).toHaveLength(1);
  });

  it("flags a .catch handler that logs the error", () => {
    const result = scanCatches(
      "bad.ts",
      "function f() { void prisma.reminder.updateMany({}).catch((e) => console.warn('x', e)); }",
      everyCatch,
    );
    expect(result.violations).toHaveLength(1);
  });

  it.each([
    [
      "the helpers",
      "logDbFailure('[X] failed', err); captureDbFailure('[X] failed', err, { tags: { scope: 'x' } });",
    ],
    [
      "the facts",
      "const facts = dbFailureFacts(err); console.warn(`[X] ${formatDbFailureFacts(facts)}`);",
    ],
    ["the class name", "console.warn(`[X] ${err instanceof Error ? err.name : 'unknown'}`);"],
  ])("accepts %s", (_label, body) => {
    expect(scanned(body)).toEqual([]);
  });

  it("flags an interpolated label", () => {
    const result = scanCatches(
      "bad.ts",
      "function f(s: string, e: unknown) { logDbFailure(`[X] ${s}`, e); }",
      everyCatch,
    );
    expect(result.violations).toHaveLength(1);
  });
});
