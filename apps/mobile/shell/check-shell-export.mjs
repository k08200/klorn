/**
 * After `npm run build:shell`: every page of the copied static export must be
 * reachable by its extension-less path through the shell router, and every
 * dynamic-route shell by a sample id — the native routers serve exactly what
 * resolve-route.mjs answers (route-cases.json keeps them in step).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseShellRoutes, resolveShellPath } from "./resolve-route.mjs";

function htmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(full));
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

/** Problems found in a shell bundle directory (empty when it routes correctly). */
export function checkShellExport(root) {
  const problems = [];
  const routesPath = join(root, "shell-routes.json");
  if (!existsSync(routesPath)) return [`${routesPath} is missing`];
  const rules = parseShellRoutes(readFileSync(routesPath, "utf8"));
  if (rules.shells.length === 0) problems.push("shell-routes.json lists no shells");
  const exists = (path) => existsSync(join(root, path));
  const expectResolves = (path, file) => {
    const got = resolveShellPath(path, rules, exists);
    if (got !== file) problems.push(`${path} resolves to ${got}, expected ${file}`);
  };

  for (const file of htmlFiles(root)) {
    const site = `/${relative(root, file).split(sep).join("/")}`;
    if (site === "/index.html" || site === "/404.html") continue;
    const page = site.replace(/(\/index)?\.html$/, "");
    if (page.split("/").at(-1) === "_") continue; // a shell, checked below
    expectResolves(page, site);
  }
  expectResolves("/", "/index.html");
  for (const shell of rules.shells) {
    if (!exists(`${shell.target}.html`)) problems.push(`${shell.target}.html is missing`);
    expectResolves(`${shell.prefix}sample-id`, `${shell.target}.html`);
    if (exists(`${shell.target}.txt`)) {
      expectResolves(`${shell.prefix}sample-id.txt`, `${shell.target}.txt`);
    }
  }
  return problems;
}

/**
 * Redirects whose target page the export does not have. A warning, not a
 * failure: it mirrors next.config.ts, so app.klorn.ai has the same dead end
 * (e.g. /skills → /settings/memory once that section was removed).
 */
export function deadRedirects(root) {
  const routesPath = join(root, "shell-routes.json");
  if (!existsSync(routesPath)) return [];
  const rules = parseShellRoutes(readFileSync(routesPath, "utf8"));
  const exists = (path) => existsSync(join(root, path));
  return rules.redirects
    .map((redirect) => ({ ...redirect, got: resolveShellPath(redirect.from, rules, exists) }))
    .filter(({ got }) => got === "/404.html" || got === "/index.html")
    .map(({ from, to, got }) => `redirect ${from} → ${to} lands on ${got}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: node shell/check-shell-export.mjs <bundle dir>");
    process.exit(2);
  }
  for (const warning of deadRedirects(root)) console.warn(`! shell export: ${warning}`);
  const problems = checkShellExport(root);
  if (problems.length > 0) {
    console.error(`✗ shell export:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`✓ shell export: ${root} routes every page and shell`);
}
