/**
 * Rules DSL v1 line tokenizer: words, double-quoted strings and `#`
 * comments. One left-to-right pass per line (no regular expression, no
 * backtracking), so cost is linear in the input whatever it holds.
 */

import type { DslErrorCode } from "./types.js";

export interface Token {
  kind: "word" | "string";
  text: string;
  /** 1-based column of the token's first character (the quote for a string). */
  column: number;
  /** 1-based column just past the token's last character. */
  end: number;
}

export interface LineError {
  column: number;
  code: DslErrorCode;
  message: string;
}

export type TokenizeResult = { tokens: Token[] } | { error: LineError };

function isBlank(ch: string): boolean {
  return ch === " " || ch === "\t";
}

function readString(line: string, start: number): { token: Token; next: number } | LineError {
  const chunks: string[] = [];
  let i = start + 1;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === '"') {
      return {
        token: { kind: "string", text: chunks.join(""), column: start + 1, end: i + 2 },
        next: i + 1,
      };
    }
    if (ch === "\\") {
      const next = line[i + 1];
      if (next !== '"' && next !== "\\") {
        return {
          column: i + 1,
          code: "bad-escape",
          message: 'Only \\" and \\\\ can be escaped inside a string.',
        };
      }
      chunks.push(next);
      i += 2;
      continue;
    }
    chunks.push(ch);
    i += 1;
  }
  return {
    column: start + 1,
    code: "unterminated-string",
    message: "This string has no closing quote on the same line.",
  };
}

function wordEnd(line: string, start: number): number {
  let i = start;
  while (i < line.length) {
    const c = line[i] as string;
    if (isBlank(c) || c === '"' || c === "#") break;
    i += 1;
  }
  return i;
}

export function tokenizeLine(line: string): TokenizeResult {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === "#") break;
    if (isBlank(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      const read = readString(line, i);
      if ("code" in read) return { error: read };
      tokens.push(read.token);
      i = read.next;
      continue;
    }
    const end = wordEnd(line, i);
    tokens.push({ kind: "word", text: line.slice(i, end), column: i + 1, end: end + 1 });
    i = end;
  }
  return { tokens };
}
