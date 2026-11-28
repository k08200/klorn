// Run: node --test apps/mobile/shell/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseShellRoutes, resolveShellPath } from "./resolve-route.mjs";

const vectors = JSON.parse(readFileSync(new URL("./route-cases.json", import.meta.url), "utf8"));

function existsIn(files) {
  const set = new Set(files);
  return (path) => set.has(path);
}

test("the Next export: each request path maps to the file the bundle serves", () => {
  const exists = existsIn(vectors.files);
  for (const { path, expect } of vectors.cases) {
    assert.equal(
      resolveShellPath(path, vectors.rules, exists),
      expect,
      `path ${JSON.stringify(path)}`,
    );
  }
});

test("the current Vite SPA (no rules, no 404.html): unknown page paths still get index.html", () => {
  const exists = existsIn(vectors.spaCases.files);
  const rules = parseShellRoutes(null);
  for (const { path, expect } of vectors.spaCases.cases) {
    assert.equal(resolveShellPath(path, rules, exists), expect, `path ${JSON.stringify(path)}`);
  }
});

test("parseShellRoutes drops malformed entries instead of trusting them", () => {
  const rules = parseShellRoutes(
    JSON.stringify({
      redirects: [{ from: "/a", to: "/b" }, { from: "a", to: "/b" }, { from: "/c" }],
      shells: [{ prefix: "/x/", target: "/x/_" }, { prefix: "/y", target: "/y/_" }, null],
    }),
  );
  assert.deepEqual(rules, {
    redirects: [{ from: "/a", to: "/b" }],
    shells: [{ prefix: "/x/", target: "/x/_" }],
  });
  assert.deepEqual(parseShellRoutes("not json"), { redirects: [], shells: [] });
});
