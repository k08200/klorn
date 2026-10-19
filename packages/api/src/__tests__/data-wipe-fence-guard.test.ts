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
import {
  FENCED_MODELS,
  PARENT_SCOPED_MODELS,
  UNFENCED_MODELS,
} from "../privacy/data-wipe-fence.js";

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

  it("routes every parent-scoped table's trigger through the parent it names", () => {
    const sql = readFileSync(
      join(prismaDir, "migrations", "20261019010000_data_wipe_fence", "migration.sql"),
      "utf8",
    );
    const routed = Object.fromEntries(
      [
        ...sql.matchAll(
          /CREATE TRIGGER "\w+_data_wipe_fence" BEFORE INSERT ON "(\w+)" FOR EACH ROW EXECUTE FUNCTION public\.klorn_data_wipe_fence_via_parent\('(\w+)', '(\w+)'\);/g,
        ),
      ].map(([, table, parent, key]) => [table, { parent, key }]),
    );
    expect(routed).toEqual(PARENT_SCOPED_MODELS);
  });

  it("covers every model without a userId whose parent is a fenced table", () => {
    const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");
    const fenced = new Set<string>(FENCED_MODELS);
    const children = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
      .filter(([, , body]) => !/^\s+userId\s+String/m.test(body ?? ""))
      .filter(([, , body]) =>
        [...(body ?? "").matchAll(/^\s+\w+\s+(\w+)\??\s+@relation\(fields:/gm)].some(([, target]) =>
          fenced.has(target ?? ""),
        ),
      )
      .map(([, name]) => name);
    expect(children.sort()).toEqual(Object.keys(PARENT_SCOPED_MODELS).sort());
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

  it("wraps every scheduler's first run, which would otherwise carry the process start", () => {
    const unwrapped = sourceFiles(srcDir).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return [...text.matchAll(/\b\w*[Ff]irst\w*Timer\s*=\s*setTimeout\((?!\s*newWork\()/g)].map(
        (m) => `${relative(srcDir, file)}@${m.index}`,
      );
    });
    expect(unwrapped).toEqual([]);
  });

  it("starts works only in files that schedule, never inside a unit of work", () => {
    // A runAsNewWork inside work would give that work a later start and let
    // its writes past the fence. Works start where ticks are scheduled.
    const offenders = sourceFiles(srcDir).flatMap((file) => {
      const name = relative(srcDir, file);
      if (name === "work-context.ts") return [];
      const text = readFileSync(file, "utf8");
      const starts = /\b(newWork|runAsNewWork)\(/.test(text);
      const schedules = /setInterval\(\s*newWork\(/.test(text);
      return starts && !schedules ? [name] : [];
    });
    expect(offenders).toEqual([]);
  });
});
