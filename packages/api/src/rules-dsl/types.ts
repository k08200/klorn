/**
 * Rules DSL v1 types (docs/design/rules-dsl.md). Pure data, no behaviour.
 */

import type { LiveTier } from "@klorn/contract";

export type DslLane = LiveTier;

export const DSL_LANES: readonly DslLane[] = ["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"];

export type DslErrorCode =
  | "missing-version"
  | "unsupported-version"
  | "unexpected-token"
  | "unterminated-string"
  | "bad-escape"
  | "forbidden-character"
  | "statement-outside-rule"
  | "empty-rule-name"
  | "duplicate-clause"
  | "too-many-conditions"
  | "missing-when"
  | "missing-then"
  | "unknown-lane"
  | "retired-lane"
  | "invalid-address"
  | "invalid-domain"
  | "public-domain"
  | "duplicate-sender"
  | "text-too-large"
  | "too-many-rules"
  | "string-too-long";

/** One problem in the text; line and column are 1-based (UTF-16 code units). */
export interface DslError {
  line: number;
  column: number;
  code: DslErrorCode;
  message: string;
}

export interface DslFailure {
  ok: false;
  errors: DslError[];
  truncated: boolean;
}

/** `when from address|domain "<value>"`, as written (not yet validated). */
export interface AstWhen {
  scope: "address" | "domain";
  value: string;
  line: number;
  column: number;
  /** Column of the value's opening quote: where a bad sender is reported. */
  valueColumn: number;
}

export interface AstThen {
  lane: DslLane;
  line: number;
  column: number;
}

export interface AstRule {
  name: string;
  note: string | null;
  disabled: boolean;
  /** The `when from …` clause. */
  sender: AstWhen;
  /** The `then lane …` clause. */
  target: AstThen;
  /** Line and column of the `rule` keyword. */
  line: number;
  column: number;
}

export interface DslAst {
  version: 1;
  rules: AstRule[];
}

export type ParseResult = { ok: true; ast: DslAst } | DslFailure;

/**
 * One compiled rule: exactly what one PIN_TIER EmailRule row holds. `scope`
 * uses the pin vocabulary (`sender` | `domain`, @klorn/contract TierPinScope).
 */
export interface CompiledRule {
  name: string;
  description: string | null;
  scope: "sender" | "domain";
  value: string;
  lane: DslLane;
  isActive: boolean;
}

export type CompileResult = { ok: true; rules: CompiledRule[] } | DslFailure;
