/**
 * Wire contract for the Rules DSL under `/api/email/rules/dsl`
 * (docs/design/rules-dsl.md): the user's lane pins as editable text, with
 * validate, dry-run and apply. Behind RULES_DSL_ENABLED; `/me` reports
 * `user.rulesDsl`.
 */

import type { LiveTier } from "./firewall.js";

/** One problem in the text; line and column are 1-based. */
export interface RulesDslErrorWire {
  line: number;
  column: number;
  code: string;
  message: string;
}

/** `GET /api/email/rules/dsl/export` */
export interface RulesDslExportResponse {
  text: string;
  /** Identifies the pins the text was made from; apply refuses a stale one (409). */
  baseHash: string;
  ruleCount: number;
  readOnlyCount: number;
  /** False when the rules exceed the text limits (500 rules, 64 KiB): edit them elsewhere. */
  applicable: boolean;
}

/** `POST /api/email/rules/dsl/validate` */
export interface RulesDslValidateResponse {
  ok: boolean;
  ruleCount: number;
  errors: RulesDslErrorWire[];
  truncated: boolean;
}

/** A 400 from dry-run or apply: the text does not compile. */
export interface RulesDslInvalidResponse {
  error: string;
  code: "invalid-rules";
  errors: RulesDslErrorWire[];
  truncated: boolean;
}

export interface RulesDslTransitionWire {
  from: LiveTier;
  /** null = back to the judge: the pin that decided it is gone. */
  to: LiveTier | null;
  count: number;
}

export interface RulesDslSampleWire {
  id: string;
  sender: string;
  subject: string;
  from: LiveTier;
  to: LiveTier | null;
}

/** `POST /api/email/rules/dsl/dry-run` — read-only. */
export interface RulesDslDryRunResponse {
  examined: number;
  changed: number;
  manualKept: number;
  transitions: RulesDslTransitionWire[];
  samples: RulesDslSampleWire[];
}

/** `POST /api/email/rules/dsl/apply` */
export interface RulesDslApplyResponse {
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  /** The fresh export after apply, as from GET /export. */
  text: string;
  baseHash: string;
  applicable: boolean;
}
