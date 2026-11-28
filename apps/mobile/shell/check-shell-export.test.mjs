import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkShellExport, deadRedirects } from "./check-shell-export.mjs";

function bundle(files) {
  const root = mkdtempSync(join(tmpdir(), "klorn-shell-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const ROUTES = JSON.stringify({
  redirects: [{ from: "/dashboard", to: "/inbox" }],
  shells: [{ prefix: "/email/", target: "/email/_" }],
});

test("a complete export routes cleanly", () => {
  const root = bundle({
    "shell-routes.json": ROUTES,
    "index.html": "",
    "404.html": "",
    "inbox.html": "",
    "settings.html": "",
    "docs/index.html": "",
    "email/_.html": "",
    "email/_.txt": "",
  });
  try {
    assert.deepEqual(checkShellExport(root), []);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a missing shell, table or redirect target is reported", () => {
  const root = bundle({ "shell-routes.json": ROUTES, "index.html": "", "404.html": "" });
  try {
    const problems = checkShellExport(root);
    assert.ok(problems.some((p) => p.includes("/email/_.html is missing")));
    assert.deepEqual(deadRedirects(root), ["redirect /dashboard → /inbox lands on /404.html"]);
  } finally {
    rmSync(root, { recursive: true });
  }
  const bare = bundle({ "index.html": "" });
  try {
    assert.match(checkShellExport(bare)[0], /shell-routes\.json is missing/);
  } finally {
    rmSync(bare, { recursive: true });
  }
});
