/**
 * A route that looks a row up by id and finds it belongs to someone else must
 * answer exactly what it answers for an id that does not exist: the not-found
 * 404. A 403 there tells the caller the id exists and is another user's
 * (notifications #1773; commitments, calendar, chat pending actions and
 * memories after it).
 *
 * The scan looks for an owner comparison answered with a 403 in route source.
 * A 403 that means something else (a plan, a role, a signature) does not
 * compare a row's userId and is not matched.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");

/**
 * `x.userId !== userId) return reply.code(403)`, either operand order, `code` or
 * `status`, 403 or HTTP_FORBIDDEN, on one line or split across lines.
 */
const OWNER_MISMATCH_403 =
  /(?:\.userId\s*!==?\s*[\w.]+|[\w.]+\s*!==?\s*[\w.]*\.userId)\s*\)\s*\{?\s*return\s+reply\s*\.(?:code|status)\(\s*(?:403|HTTP_FORBIDDEN)\s*\)/;

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("an owner mismatch is answered as not found", () => {
  it("matches the pattern it guards against", () => {
    expect(
      OWNER_MISMATCH_403.test(
        'if (a.userId !== userId) return reply.code(403).send({ error: "Forbidden" });',
      ),
    ).toBe(true);
    expect(
      OWNER_MISMATCH_403.test("if (row.userId !== uid) {\n  return reply.code(403).send({});\n}"),
    ).toBe(true);
    expect(
      OWNER_MISMATCH_403.test(
        "if (userId !== row.userId) return reply.status(HTTP_FORBIDDEN).send();",
      ),
    ).toBe(true);
    expect(OWNER_MISMATCH_403.test('return reply.code(403).send({ error: "Demo user" });')).toBe(
      false,
    );
    expect(
      OWNER_MISMATCH_403.test("if (row.userId !== userId) return reply.code(404).send({});"),
    ).toBe(false);
  });

  it("no route answers another user's row with 403", () => {
    const offenders = routeFiles(routesDir)
      .filter((path) => OWNER_MISMATCH_403.test(readFileSync(path, "utf8")))
      .map((path) => relative(routesDir, path));
    expect(offenders).toEqual([]);
  });
});
