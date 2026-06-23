// scripts/pr-impact.mjs
import { execFileSync } from "node:child_process";
import { basename as basename2 } from "node:path";

// backend/dist/diff-lines.js
function changedLines(diff) {
  const added = [];
  const removed = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++"))
      added.push(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---"))
      removed.push(line.slice(1));
  }
  return { added, removed };
}

// backend/dist/sigdiff.js
function parseSig(decl) {
  const pm = decl.match(/\(([^)]*)\)/);
  const params = pm ? pm[1].split(",").map((p) => p.trim().split(":")[0].trim().replace(/\?$/, "")).filter(Boolean) : [];
  const rm = decl.match(/\)\s*:\s*([^{=]+?)\s*(\{|=>|$)/);
  const ret = rm ? rm[1].trim() : "";
  return { params, ret };
}
function describeSignatureChange(before, after) {
  const b = parseSig(before);
  const a = parseSig(after);
  const added = a.params.filter((p) => !b.params.includes(p));
  const removed = b.params.filter((p) => !a.params.includes(p));
  const parts = [];
  if (added.length)
    parts.push(`${added.join(", ")} \uC778\uC790 \uCD94\uAC00`);
  if (removed.length)
    parts.push(`${removed.join(", ")} \uC778\uC790 \uC81C\uAC70`);
  if (b.ret && a.ret && b.ret !== a.ret)
    parts.push(`\uBC18\uD658 ${b.ret} \u2192 ${a.ret}`);
  return parts.length > 0 ? parts.join(" \xB7 ") : void 0;
}

// backend/dist/providers/graph.js
var MAX_DETAIL_LEN = 160;
var escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function findDecl(lines, sym) {
  const re = new RegExp(`\\bexport\\b.*\\b${escRe(sym)}\\b`);
  const hit = lines.find((l) => re.test(l));
  return hit ? hit.trim().slice(0, MAX_DETAIL_LEN) : void 0;
}
function findFieldDecl(lines, field) {
  const f = escRe(field);
  const re = new RegExp(`^\\s*${f}\\??\\s*:|^\\s*${f}\\s+[A-Z]`);
  const hit = lines.find((l) => re.test(l) && !/[(){}]/.test(l));
  return hit ? hit.trim().slice(0, MAX_DETAIL_LEN) : void 0;
}
function buildChangeDetails(added, removed, symbols) {
  const out = [];
  for (const symbol of symbols) {
    const before = findDecl(removed, symbol);
    const after = findDecl(added, symbol);
    if (before || after) {
      const note = before && after ? describeSignatureChange(before, after) : void 0;
      out.push({ symbol, before, after, note });
    }
    if (out.length >= 6)
      break;
  }
  return out;
}
var MAX_AFFECTED = 50;
var EXPORT_RE = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
var EXPORT_LIST_RE = /\bexport\s*\{([^}]*)\}/g;
var ROUTE_RE = /['"`](\/[\w/:.-]*)['"`]/g;
var TS_FIELD_RE = /^\s*([A-Za-z_$][\w$]*)\??\s*:\s*\S/;
var SCHEMA_FIELD_RE = /^\s*([A-Za-z_$][\w$]*)\s+[A-Z]\w*/;
function basename(spec) {
  const last = spec.split("/").pop() ?? spec;
  return last.replace(/\.[^.]+$/, "");
}
function collectExports(lines) {
  const out = /* @__PURE__ */ new Set();
  const text = lines.join("\n");
  for (const m of text.matchAll(EXPORT_RE))
    out.add(m[1]);
  for (const m of text.matchAll(EXPORT_LIST_RE)) {
    for (const name of m[1].split(",")) {
      const id = name.trim().split(/\s+as\s+/)[0].trim();
      if (id)
        out.add(id);
    }
  }
  return out;
}
function collectRoutes(lines) {
  const out = /* @__PURE__ */ new Set();
  for (const line of lines)
    for (const m of line.matchAll(ROUTE_RE))
      out.add(m[1]);
  return out;
}
function collectFields(lines) {
  const out = /* @__PURE__ */ new Set();
  for (const line of lines) {
    const ts = TS_FIELD_RE.exec(line);
    if (ts && !/[(){}]/.test(line))
      out.add(ts[1]);
    const sc = SCHEMA_FIELD_RE.exec(line);
    if (sc)
      out.add(sc[1]);
  }
  return out;
}
function diffSet(a, b) {
  return new Set([...a].filter((x) => !b.has(x)));
}
var GraphProvider = class {
  name = "graph";
  async analyze(input) {
    const { added, removed } = changedLines(input.diff);
    const expAdded = collectExports(added);
    const expRemoved = collectExports(removed);
    const modified = new Set([...expAdded].filter((x) => expRemoved.has(x)));
    const routesAdded = collectRoutes(added);
    const routesRemoved = collectRoutes(removed);
    const fieldsRemoved = collectFields(removed);
    const fieldsAdded = diffSet(collectFields(added), fieldsRemoved);
    const routesChanged = [...routesRemoved, ...routesAdded].length > 0 && ([...diffSet(routesRemoved, routesAdded)].length > 0 || [...diffSet(routesAdded, routesRemoved)].length > 0);
    const contractBroken = /* @__PURE__ */ new Set([
      ...modified,
      ...diffSet(expRemoved, modified),
      ...fieldsRemoved
    ]);
    const additive = /* @__PURE__ */ new Set([...diffSet(expAdded, modified), ...fieldsAdded]);
    let severity = "info";
    if (contractBroken.size > 0 || routesChanged)
      severity = "high";
    else if (additive.size > 0)
      severity = "low";
    const myBase = basename(input.file);
    const myFull = `${input.repo}/${input.file}`;
    const changedKeys = /* @__PURE__ */ new Set([
      ...contractBroken,
      ...additive,
      ...routesAdded,
      ...routesRemoved
    ]);
    const index = input.knownIndex ?? [];
    const refHits = [];
    const importHits = [];
    if (severity !== "info") {
      for (const kf of index) {
        if (kf.path === myFull)
          continue;
        const refHit = kf.refs.find((r) => changedKeys.has(r));
        if (refHit) {
          refHits.push({ pathHint: kf.path, reason: `${refHit} \uB97C \uC9C1\uC811 \uCC38\uC870 \u2192 \uBCC0\uACBD \uC601\uD5A5` });
        } else if (kf.imports.some((spec) => basename(spec) === myBase)) {
          importHits.push({ pathHint: kf.path, reason: `${input.file} \uB97C import \u2192 \uBCC0\uACBD \uC601\uD5A5` });
        }
      }
    }
    const affected = [...refHits, ...importHits].slice(0, MAX_AFFECTED);
    const verb = removed.length > added.length ? "\uC0AD\uC81C/\uCD95\uC18C" : "\uC218\uC815";
    const what = contractBroken.size > 0 ? `\uACC4\uC57D \uBCC0\uACBD: ${[...contractBroken].slice(0, 4).join(", ")}` : routesChanged ? `\uB77C\uC6B0\uD2B8 \uBCC0\uACBD: ${[...routesRemoved].slice(0, 2).join(", ")}` : additive.size > 0 ? `\uCD94\uAC00: ${[...additive].slice(0, 4).join(", ")}` : "\uB0B4\uBD80 \uBCC0\uACBD";
    const summary = `${input.file} ${verb} \xB7 ${what} (\uC601\uD5A5 ${affected.length}\uAC74)`;
    const exportSyms = /* @__PURE__ */ new Set([...modified, ...expRemoved, ...expAdded]);
    const changeDetails = buildChangeDetails(added, removed, exportSyms);
    const fieldSyms = /* @__PURE__ */ new Set([...collectFields(removed), ...collectFields(added)]);
    const seen = new Set(changeDetails.map((d) => d.symbol));
    for (const f of fieldSyms) {
      if (changeDetails.length >= 6 || seen.has(f))
        continue;
      const before = findFieldDecl(removed, f);
      const after = findFieldDecl(added, f);
      if (before || after) {
        changeDetails.push({ symbol: f, before, after });
        seen.add(f);
      }
    }
    return { summary, severity, affected, changedSymbols: [...changedKeys], changeDetails };
  }
};

// scripts/pr-impact.mjs
var REPO = process.env.RIPPLE_REPO || ".";
var BASE = process.env.BASE_SHA || "HEAD~1";
var HEAD = process.env.HEAD_SHA || "HEAD";
var REPO_NAME = process.env.REPO_NAME || basename2(process.cwd());
var CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|rb|php|cs|kt|swift|rs|vue|svelte|sql|proto)$/;
var IGNORE = /(^|\/)(node_modules|\.git|dist|build|out|\.next|vendor)\//;
var MAX_FILES = 4e3;
var git = (a) => {
  try {
    return execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  } catch {
    return "";
  }
};
function extractIndex(path, text) {
  const t = text.length > 64e3 ? text.slice(0, 64e3) : text;
  const exports = /* @__PURE__ */ new Set(), imports = /* @__PURE__ */ new Set(), refs = /* @__PURE__ */ new Set();
  for (const m of t.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) exports.add(m[1]);
  for (const m of t.matchAll(/\bexport\s*\{([^}]*)\}/g)) for (const n of m[1].split(",")) {
    const id = n.trim().split(/\s+as\s+/)[0].trim();
    if (id) exports.add(id);
  }
  for (const m of t.matchAll(/\bimport\b[^'"]*['"]([^'"]+)['"]/g)) imports.add(m[1]);
  for (const m of t.matchAll(/\bimport\s*\{([^}]*)\}/g)) for (const n of m[1].split(",")) {
    const id = n.trim().split(/\s+as\s+/)[0].trim();
    if (id) refs.add(id);
  }
  for (const m of t.matchAll(/['"`](\/[\w/:.-]{2,})['"`]/g)) refs.add(m[1]);
  return { path, exports: [...exports], imports: [...imports], refs: [...refs] };
}
function useSites(relPath, symbols) {
  const content = git(["show", `${HEAD}:${relPath}`]);
  if (!content) return [];
  const lines = content.split("\n");
  const sites = [];
  for (const sym of symbols) {
    if (sym.length < 3 || sites.length >= 4) continue;
    const isIdent = /^[A-Za-z_$][\w$]*$/.test(sym);
    const re = isIdent ? new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`) : null;
    for (let i = 0; i < lines.length; i++) {
      if (re ? re.test(lines[i]) : lines[i].includes(sym)) {
        sites.push({ line: i + 1, text: lines[i].trim().slice(0, 100) });
        break;
      }
    }
  }
  return sites;
}
var graph = new GraphProvider();
var allFiles = git(["ls-tree", "-r", "--name-only", HEAD]).split("\n").filter((f) => f && CODE.test(f) && !IGNORE.test(f) && !/\.d\.ts$/.test(f)).slice(0, MAX_FILES);
var knownIndex = [];
for (const f of allFiles) {
  const c = git(["show", `${HEAD}:${f}`]);
  if (c) knownIndex.push(extractIndex(`${REPO_NAME}/${f}`, c));
}
var knownFiles = knownIndex.map((k) => k.path);
var changed = git(["diff", "--name-status", BASE, HEAD]).split("\n").filter(Boolean).map((l) => l.split("	")).filter(([s, p]) => (s === "M" || s === "A") && CODE.test(p) && !IGNORE.test(p) && !/\.d\.ts$/.test(p)).map(([, p]) => p);
var results = [];
for (const f of changed) {
  const diff = git(["diff", BASE, HEAD, "--", f]);
  if (!diff) continue;
  const r = await graph.analyze({ repo: REPO_NAME, file: f, diff, knownFiles, knownIndex });
  if (r.affected.length > 0 && r.severity !== "info") results.push({ file: f, ...r });
}
var ICON = { high: "\u26A0\uFE0F", low: "\u{1F7E1}", info: "\u2139\uFE0F" };
var md = "## \u{1F30A} Ripple \u2014 \uC774 PR\uC758 \uBCC0\uACBD \uC601\uD5A5\n\n";
if (results.length === 0) {
  md += "\uC774 PR \uC758 \uBCC0\uACBD\uC774 \uB2E4\uB978 \uCF54\uB4DC\uC758 \uACC4\uC57D(\uC2DC\uADF8\uB2C8\uCC98\xB7\uC2A4\uD0A4\uB9C8\xB7\uB77C\uC6B0\uD2B8)\uC744 \uAE68\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \u2705\n";
} else {
  md += `\uC774 PR \uC740 **${results.length}\uAC1C \uD30C\uC77C**\uC758 \uBCC0\uACBD\uC774 \uB2E4\uB978 \uCF54\uB4DC\uC5D0 \uC601\uD5A5\uC744 \uC90D\uB2C8\uB2E4.

`;
  for (const r of results.sort((a, b) => a.severity === "high" ? -1 : 1)) {
    md += `### ${ICON[r.severity]} \`${r.file}\`
`;
    for (const d of r.changeDetails.slice(0, 4)) {
      md += `- **\`${d.symbol}\`**${d.note ? ` \u2014 ${d.note}` : ""}
`;
      if (d.before && d.after && d.before !== d.after) md += `  \`\`\`diff
  - ${d.before}
  + ${d.after}
  \`\`\`
`;
    }
    md += `- \uC601\uD5A5\uBC1B\uB294 \uACF3:
`;
    for (const a of r.affected.slice(0, 8)) {
      const rel = a.pathHint.startsWith(`${REPO_NAME}/`) ? a.pathHint.slice(REPO_NAME.length + 1) : a.pathHint;
      const sites = useSites(rel, r.changedSymbols);
      const where = sites.length ? sites.map((s) => `\`${rel}:${s.line}\``).join(", ") : `\`${rel}\``;
      md += `  - ${where}${sites[0] ? ` \u2014 \`${sites[0].text}\`` : ""}
`;
    }
    md += "\n";
  }
  md += "\n> _\uC800\uC7A5 \uC21C\uAC04 \uB77C\uC774\uBE0C \uC54C\uB9BC\uC740 Ripple \uC775\uC2A4\uD150\uC158\uC5D0\uC11C. \uC774 \uCF54\uBA58\uD2B8\uB294 PR \uAC8C\uC774\uD2B8\uC785\uB2C8\uB2E4._\n";
}
process.stdout.write(md);
