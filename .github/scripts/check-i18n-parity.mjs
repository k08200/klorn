#!/usr/bin/env node
/**
 * Web i18n parity guard.
 *
 * `packages/web/src/lib/locales/<code>.ts` holds one flat table per locale.
 * The module already had a symmetry check, but it only `console.warn`s, only
 * in dev — a warning nobody reads while the build stays green. With two
 * locales that was survivable; the moment a third exists, silent drift is
 * guaranteed, and a missing key renders as the raw key string in the product.
 *
 * This is the CI teeth, deliberately generic over N locales: it reads every
 * file in the locales directory, so adding a language needs no edit here.
 *
 * Parsing note: the tables are FLAT `Record<string, string>` literals, so
 * brace-matching the block and taking depth-1 quoted keys is exact. If the
 * shape ever nests, this script fails loudly rather than silently passing.
 */

import { readdirSync, readFileSync } from "node:fs";

const DIR = "packages/web/src/lib/locales";
const TABLE_RE = /const\s+(\w+)\s*:\s*Record<string,\s*string>\s*=\s*\{/;

function fail(message) {
  console.error(`✗ i18n parity: ${message}`);
  process.exit(1);
}



/** Slice the object literal that starts at `openIndex` (the `{`). */
function readObjectBody(text, openIndex) {
  let depth = 0;
  let inString = null;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    const prev = text[i - 1];
    if (inString) {
      if (ch === inString && prev !== "\\") inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return null;
}

/** Top-level quoted keys of a flat table. Nested objects are a hard error. */
function tableKeys(body, locale) {
  const keys = [];
  let depth = 0;
  let inString = null;
  let pendingKey = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const prev = body[i - 1];
    if (inString) {
      if (ch === inString && prev !== "\\") {
        if (pendingKey !== null) {
          // Closing quote of a candidate key: keep it only if a colon follows.
          const rest = body.slice(i + 1).match(/^\s*:/);
          if (rest && depth === 0) keys.push(pendingKey);
          pendingKey = null;
        }
        inString = null;
      } else if (pendingKey !== null) {
        pendingKey += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      pendingKey = depth === 0 ? "" : null;
      continue;
    }
    if (ch === "`") {
      inString = ch;
      pendingKey = null;
      continue;
    }
    if (ch === "{") {
      depth++;
      if (depth === 1) fail(`${locale} table is no longer flat — this guard must be updated`);
    } else if (ch === "}") depth--;
  }
  return keys;
}

const tables = new Map();
const bodies = new Map();
let files;
try {
  files = readdirSync(DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort();
} catch {
  fail(`could not read ${DIR} — did the locale files move?`);
}

for (const file of files) {
  const locale = file.replace(/\.ts$/, "");
  const source = readFileSync(`${DIR}/${file}`, "utf8");
  const match = TABLE_RE.exec(source);
  if (!match) fail(`${file} has no 'const <locale>: Record<string, string> = {' table`);
  const openIndex = source.indexOf("{", match.index + match[0].length - 1);
  const body = readObjectBody(source, openIndex);
  if (body === null) fail(`could not parse the table in ${file}`);
  tables.set(locale, tableKeys(body, locale));
  bodies.set(locale, body);
}

if (tables.size < 2) {
  fail(`expected at least 2 locale files in ${DIR}, found ${tables.size}`);
}

// English is the source of truth for keys, not whichever file sorts first.
if (!tables.has("en")) fail(`${DIR} has no en.ts — English is the key source of truth`);
const baseLocale = "en";
const baseKeys = tables.get(baseLocale);
const baseSet = new Set(baseKeys);

// Duplicate keys inside one table silently shadow each other — the later wins
// and the earlier translation is dead weight nobody notices.
for (const [locale, keys] of tables) {
  const seen = new Set();
  const dupes = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
  if (dupes.length > 0) {
    fail(`${locale} has duplicate keys: ${[...new Set(dupes)].slice(0, 10).join(", ")}`);
  }
}

let problems = 0;
for (const [locale, keys] of tables) {
  if (locale === baseLocale) continue;
  const localeSet = new Set(keys);
  const missing = baseKeys.filter((k) => !localeSet.has(k));
  const extra = keys.filter((k) => !baseSet.has(k));
  if (missing.length > 0) {
    console.error(
      `✗ ${locale} is missing ${missing.length} key(s): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " …" : ""}`,
    );
    problems++;
  }
  if (extra.length > 0) {
    console.error(
      `✗ ${locale} has ${extra.length} key(s) ${baseLocale} lacks: ${extra.slice(0, 10).join(", ")}${extra.length > 10 ? " …" : ""}`,
    );
    problems++;
  }
}

if (problems > 0) {
  console.error("\nAdd the missing strings in the same commit — a key with no");
  console.error("translation renders as the raw key to the user.");
  process.exit(1);
}

/**
 * Copy guard for the keys a step adds. Key parity cannot see a translation that
 * was never done: copying the English string into every locale passes it, and a
 * localized surface then ships English text. For the prefixes below (scoped to
 * what steps have added, so older strings are not newly flagged) each non-English
 * value must differ from English, be non-empty, and carry the same {placeholders}.
 * To cover a later step's keys, add its prefix here.
 */
const COPY_GUARD_PREFIXES = [
  "settings.apiKeys.permission.",
  "settings.apiKeys.activity.",
  // Assistant hub (productization plan P7).
  "assistantHub.",
  "keys.approvals.",
];

/** Words that are genuinely the same in another language: key -> locales. Keep this tiny. */
const SAME_AS_ENGLISH = {
  "settings.apiKeys.activity.outcome.error": ["es"],
};

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The string value of a flat-table entry, or null when it is not a plain string literal. */
function tableValue(body, key) {
  const literal = new RegExp(
    `(?:^|\\n)\\s*["']${escapeRegExp(key)}["']\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`,
  ).exec(body);
  if (!literal) return null;
  const text = literal[1];
  if (text[0] === '"') return JSON.parse(text);
  return JSON.parse(`"${text.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);
}

const placeholdersOf = (text) => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort().join(" ");

const guardedKeys = baseKeys.filter((key) => COPY_GUARD_PREFIXES.some((p) => key.startsWith(p)));
for (const key of Object.keys(SAME_AS_ENGLISH)) {
  if (!guardedKeys.includes(key)) fail(`SAME_AS_ENGLISH names ${key}, which is not a guarded key`);
}

let copyProblems = 0;
for (const key of guardedKeys) {
  const english = tableValue(bodies.get(baseLocale), key);
  if (english === null) fail(`could not read the value of ${key} in ${baseLocale}.ts`);
  for (const locale of tables.keys()) {
    if (locale === baseLocale) continue;
    const text = tableValue(bodies.get(locale), key);
    if (text === null) fail(`could not read the value of ${key} in ${locale}.ts`);
    const allowedSame = (SAME_AS_ENGLISH[key] ?? []).includes(locale);
    if (text.trim() === "") {
      console.error(`✗ ${locale} ${key} is empty`);
      copyProblems++;
    } else if (text === english && !allowedSame) {
      console.error(`✗ ${locale} ${key} is still the English text`);
      copyProblems++;
    }
    if (placeholdersOf(text) !== placeholdersOf(english)) {
      console.error(`✗ ${locale} ${key} has different {placeholders} than ${baseLocale}`);
      copyProblems++;
    }
  }
}

if (copyProblems > 0) {
  console.error("\nTranslate the string (or, if the word really is the same, list it in");
  console.error("SAME_AS_ENGLISH): a localized surface must not ship English text.");
  process.exit(1);
}

/**
 * Prose guard for surfaces that shipped fully translated. Key parity cannot see
 * a string that never went through t(): it is not in any table. For the
 * directories below, every file is checked for (a) keys passed as literals
 * that en.ts does not have — a typo renders as the raw key — and (b) English
 * written straight into the markup: JSX text, or a literal aria-label / title
 * / placeholder / alt / label / description attribute. Heuristic by design: it
 * reads source text, not a syntax tree. To cover a later surface, add its
 * directory here.
 */
const PROSE_GUARD_DIRS = ["packages/web/src/app/assistant"];
const KEY_LITERAL_RE =
  /["'`]((?:assistantHub|keys|nav|today|receipt|screener|briefing|chat|settings|mailV2|tool\.label)\.[\w.]+)["'`]/g;
// Text that ends at a closing tag or an expression, after a tag or an expression.
const JSX_TEXT_RE = />([^<>{}]+)(?:<\/|\{)|\}([^<>{}]+)<\//g;
const PROSE_RE = /^[\s\w.,:!?'’·—–-]*[A-Za-z]{2}[\s\w.,:!?'’·—–-]*$/;
const ATTRIBUTE_RE = /\b(aria-label|title|placeholder|alt|label|description)="([^"]*[A-Za-z][^"]*)"/g;

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

let proseProblems = 0;
let proseFiles = 0;
for (const dir of PROSE_GUARD_DIRS) {
  let paths;
  try {
    paths = sourceFiles(dir);
  } catch {
    fail(`could not read ${dir} — did the guarded surface move?`);
  }
  for (const path of paths) {
    proseFiles++;
    const source = stripComments(readFileSync(path, "utf8"));
    for (const [, key] of source.matchAll(KEY_LITERAL_RE)) {
      if (baseSet.has(key)) continue;
      console.error(`✗ ${path}: "${key}" is not a key in ${baseLocale}.ts`);
      proseProblems++;
    }
    if (!path.endsWith(".tsx")) continue;
    for (const [, afterTag, afterExpression] of source.matchAll(JSX_TEXT_RE)) {
      const text = afterTag ?? afterExpression;
      if (!PROSE_RE.test(text)) continue;
      console.error(`✗ ${path}: text written into the markup: "${text.trim().slice(0, 60)}"`);
      proseProblems++;
    }
    for (const [, attribute, text] of source.matchAll(ATTRIBUTE_RE)) {
      console.error(`✗ ${path}: ${attribute}="${text.slice(0, 60)}" is not translated`);
      proseProblems++;
    }
  }
}

if (proseProblems > 0) {
  console.error("\nPass the string through t() and add its key to all seven locale tables.");
  process.exit(1);
}

console.log(
  `✓ i18n parity: ${tables.size} locales × ${baseKeys.length} keys (${[...tables.keys()].join(", ")}); copy guard: ${guardedKeys.length} keys; prose guard: ${proseFiles} files`,
);
