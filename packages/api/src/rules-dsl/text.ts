/**
 * Character-level helpers for the Rules DSL: what a file may contain, how a
 * string is written, and how user text is quoted back in a message or a
 * comment. Linear scans only; no regular expression runs on user text here.
 */

import { RULES_DSL_LIMITS } from "./limits.js";

const TAB = 0x09;
const SPACE = 0x20;
const DEL = 0x7f;

/**
 * C0 controls (tab excepted), DEL, and the bidirectional override/isolate
 * characters ("Trojan Source"): a rules file kept in git must show what it
 * does, and none of these has a use in a rule name, note or sender.
 */
export function isForbiddenCode(code: number): boolean {
  if (code < SPACE) return code !== TAB;
  if (code === DEL) return true;
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/** Index of the first forbidden character, or -1. */
export function findForbidden(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (isForbiddenCode(text.charCodeAt(i))) return i;
  }
  return -1;
}

/** UTF-8 length of `text`, counting no further than `cap + 1` bytes. */
export function utf8ByteLength(text: string, cap = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  for (let i = 0; i < text.length && bytes <= cap; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** True when `text` can be written as a DSL string of at most `max` chars. */
export function isSpellable(text: string, max: number): boolean {
  return text.length <= max && findForbidden(text) === -1;
}

/** `text` as a DSL string literal: only `"` and `\` are escaped. */
export function dslString(text: string): string {
  let out = '"';
  for (const ch of text) {
    out += ch === '"' || ch === "\\" ? `\\${ch}` : ch;
  }
  return `${out}"`;
}

function cut(text: string, max: number, forbiddenTo: string): string {
  let out = "";
  let count = 0;
  for (const ch of text) {
    if (count === max) return `${out}…`;
    const code = ch.charCodeAt(0);
    out += isForbiddenCode(code) || code === TAB ? forbiddenTo : ch;
    count += 1;
  }
  return out;
}

/**
 * User text quoted back in an error message: at most `quoteChars` characters,
 * control characters replaced, so a message never echoes an unbounded or
 * multi-line input.
 */
export function quoteForMessage(text: string): string {
  return `"${cut(text, RULES_DSL_LIMITS.quoteChars, "�")}"`;
}

/**
 * A stored name or value inside a generated `#` comment: cut, every control
 * character (newlines included) replaced by a space, so it cannot end the
 * comment line and smuggle a statement into the exported file.
 */
export function commentString(text: string, max = RULES_DSL_LIMITS.commentNameChars): string {
  return dslString(cut(text, max, " "));
}
