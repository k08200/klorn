/**
 * In the Slack, KakaoTalk-import and PIM modules (and the Slack and KakaoTalk
 * routes), a caught failure reaches Sentry and the console as facts, never as
 * itself.
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
 * (helpers/catch-sink-scan.ts), including a reporter's `ids` / `extra`. Like
 * the LLM guard it does not follow a caught value into a function the handler
 * calls (pim/linked-calendar-failure.ts and the cancelled-event scan take the
 * error as a parameter; their canary tests cover them) or into the global
 * error handler, which receives what a route rethrows.
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
/**
 * Their routes: the Slack webhook catches what ingestSlackMessage rethrows (any
 * database error over the message being stored), the KakaoTalk import route
 * what the store and parser throw over the uploaded lines.
 */
const GUARDED_FILES = [
  "routes/slack-events.ts",
  "routes/slack-connection.ts",
  "routes/kakao-import.ts",
] as const;

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
  for (const file of GUARDED_FILES) {
    const result = scanCatches(file, readFileSync(join(srcDir, file), "utf8"), everyCatch);
    violations.push(...result.violations);
    catches.set(file, result.taintedCatches);
  }
  return { violations, catches };
}

describe("database failure redaction guard (slack, kakao-import, pim)", () => {
  const scan = scanGuardedDirs();

  it("finds no catch that hands a caught failure to Sentry, the console or the log", () => {
    const offenders = scan.violations.map((v) => `${v.file}:${v.line}  ${v.text.slice(0, 160)}`);
    expect(offenders).toEqual([]);
  });

  it("cannot pass vacuously: it sees catches in every guarded directory and route", () => {
    // routes/slack-connection.ts has no catch today; it is scanned for the next one.
    for (const place of [...GUARDED_DIRS, "routes/slack-events.ts", "routes/kakao-import.ts"]) {
      expect(scan.catches.get(place) ?? 0, place).toBeGreaterThan(0);
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

  it.each([
    [
      "the message in ids",
      "logDbFailure('[X] failed', err, { ids: { m: (err as Error).message } });",
    ],
    [
      "the error in Sentry extra",
      "captureDbFailure('[X] failed', err, { tags: { scope: 'x' }, extra: { detail: String(err) } });",
    ],
    [
      "an alias in the LLM reporter's extra",
      "const msg = (err as Error).message; captureLlmFailure('[X] failed', err, { tags: {}, extra: { msg } });",
    ],
  ])("flags %s", (_label, body) => {
    expect(scanned(body)).toHaveLength(1);
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
