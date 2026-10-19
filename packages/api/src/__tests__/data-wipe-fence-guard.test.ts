/**
 * Guards for the data-wipe fence (privacy/data-wipe-fence.ts). Each list the
 * fence depends on is checked against the source of truth it can drift from:
 *   - every user-scoped model is fenced or deliberately left alone;
 *   - the migrations put the trigger on exactly the fenced tables;
 *   - every scheduler interval starts a new unit of work per tick, so a tick's
 *     writes carry that tick's start time and never the process start's.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FENCED_MODELS, UNFENCED_MODELS } from "../privacy/data-wipe-fence.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..");
const prismaDir = join(here, "..", "..", "prisma");

function userScopedModels(): string[] {
  const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");
  return [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
    .filter(([, , body]) => /^\s+userId\s+String/m.test(body ?? ""))
    .map(([, name]) => name ?? "");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("the fenced and unfenced lists cover the schema", () => {
  it("puts every model with a userId in exactly one of them", () => {
    const fenced = new Set<string>(FENCED_MODELS);
    const models = userScopedModels();
    const unclassified = models.filter((m) => !fenced.has(m) && !(m in UNFENCED_MODELS));
    const both = models.filter((m) => fenced.has(m) && m in UNFENCED_MODELS);
    expect(unclassified).toEqual([]);
    expect(both).toEqual([]);
    expect(models.length).toBeGreaterThan(50);
  });

  it("names only models that exist", () => {
    const models = new Set(userScopedModels());
    const unknown = [...FENCED_MODELS, ...Object.keys(UNFENCED_MODELS)].filter(
      (m) => !models.has(m),
    );
    expect(unknown).toEqual([]);
  });
});

describe("the migrations fence exactly the fenced tables", () => {
  it("leaves the fence trigger on every fenced table and on no other", () => {
    const migrations = readdirSync(join(prismaDir, "migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .map((name) => readFileSync(join(prismaDir, "migrations", name, "migration.sql"), "utf8"));
    const triggered = new Set<string>();
    for (const sql of migrations) {
      for (const [, table] of sql.matchAll(
        /CREATE TRIGGER "\w+_data_wipe_fence" BEFORE INSERT ON "(\w+)" FOR EACH ROW EXECUTE FUNCTION public\.klorn_data_wipe_fence\(\);/g,
      )) {
        triggered.add(table ?? "");
      }
      for (const [, table] of sql.matchAll(
        /DROP TRIGGER (?:IF EXISTS )?"\w+_data_wipe_fence" ON "(\w+)"/g,
      )) {
        triggered.delete(table ?? "");
      }
    }
    expect([...triggered].sort()).toEqual([...FENCED_MODELS].sort());
  });
});

describe("scheduler intervals start a new work per tick", () => {
  it("wraps the callback of every setInterval in newWork", () => {
    const unwrapped = sourceFiles(srcDir).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return [...text.matchAll(/setInterval\((?!\s*newWork\()/g)].map(
        (m) => `${relative(srcDir, file)}@${m.index}`,
      );
    });
    expect(unwrapped).toEqual([]);
  });

  it("starts works only where schedulers start, never inside a unit of work", () => {
    // A runAsNewWork inside work would give that work a later start and let
    // its writes past the fence. Ticks are wrapped where they are scheduled.
    const allowed = new Set(["work-context.ts"]);
    const offenders = sourceFiles(srcDir).flatMap((file) => {
      const name = relative(srcDir, file);
      if (allowed.has(name)) return [];
      const text = readFileSync(file, "utf8");
      const calls = [...text.matchAll(/\b(newWork|runAsNewWork)\(/g)];
      const scheduled = [...text.matchAll(/set(?:Interval|Timeout)\(\s*newWork\(/g)];
      return calls.length > scheduled.length ? [name] : [];
    });
    expect(offenders).toEqual([]);
  });
});
