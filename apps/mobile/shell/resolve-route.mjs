/**
 * Which bundled file the Capacitor shell serves for a request path.
 *
 * Capacitor's own local server answers every path without a file extension
 * with index.html (Android WebViewLocalServer html5mode, iOS CapacitorRouter).
 * That suits a single-page app, but the packages/web static export is one HTML
 * file per route plus one prerendered shell per dynamic route (the `_` id), and
 * on Cloudflare Pages public/_redirects maps `/email/<id>` onto that shell. The
 * native routers (android ShellRouteResolver.java, ios ShellRouteResolver.swift)
 * port this function so the shell serves the same files Cloudflare does. This
 * file is the reference; route-cases.json holds the vectors all three must pass.
 *
 * `rules` is shell-routes.json (generated from scripts/cloudflare-pages-rules.mjs
 * by packages/web/scripts/mobile-shell-routes.mjs): plain-path redirects and the
 * dynamic-route shells, longest prefix first. `exists(path)` asks the bundle.
 */

const EMPTY_RULES = Object.freeze({ redirects: [], shells: [] });

function isPlainPath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//");
}

/** shell-routes.json text → rules; anything malformed is dropped (empty rules when absent). */
export function parseShellRoutes(text) {
  if (typeof text !== "string") return EMPTY_RULES;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return EMPTY_RULES;
  }
  const list = (value) => (Array.isArray(value) ? value : []);
  return {
    redirects: list(raw?.redirects)
      .filter((r) => isPlainPath(r?.from) && isPlainPath(r?.to))
      .map((r) => ({ from: r.from, to: r.to })),
    shells: list(raw?.shells)
      .filter((s) => isPlainPath(s?.prefix) && s.prefix.endsWith("/") && isPlainPath(s?.target))
      .map((s) => ({ prefix: s.prefix, target: s.target })),
  };
}

function redirectOf(path, rules) {
  return rules.redirects.find((r) => r.from === path)?.to ?? null;
}

/** The shell serving `path`, when its last segment is the dynamic id (one segment, never a "/"). */
function shellOf(path, rules) {
  for (const shell of rules.shells) {
    if (!path.startsWith(shell.prefix)) continue;
    const rest = path.slice(shell.prefix.length);
    if (rest !== "" && !rest.includes("/")) return shell.target;
  }
  return null;
}

export function resolveShellPath(rawPath, rules, exists) {
  let path = rawPath === "" ? "/" : rawPath;
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "/") return "/index.html";

  const last = path.slice(path.lastIndexOf("/") + 1);
  if (last.includes(".")) {
    if (exists(path) || !path.endsWith(".txt")) return path;
    // The RSC payload Next's client router fetches for an in-app navigation.
    const base = path.slice(0, -".txt".length);
    const mapped = redirectOf(base, rules) ?? shellOf(base, rules);
    return mapped !== null && exists(`${mapped}.txt`) ? `${mapped}.txt` : path;
  }

  const page = redirectOf(path, rules) ?? path;
  if (exists(`${page}.html`)) return `${page}.html`;
  if (exists(`${page}/index.html`)) return `${page}/index.html`;
  const shell = shellOf(page, rules);
  if (shell !== null && exists(`${shell}.html`)) return `${shell}.html`;
  // The Next export has a 404 page; the single-page bundle routes everything itself.
  return exists("/404.html") ? "/404.html" : "/index.html";
}
