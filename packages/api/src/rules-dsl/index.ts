/**
 * Rules DSL v1 (docs/design/rules-dsl.md): a human-readable text layer over
 * the user's PIN_TIER rules. Pure: parse, compile, serialize, inventory,
 * apply plan and dry-run math. Reads and writes live in
 * mail/rules-dsl-store.ts; routes in routes/rules-dsl.ts.
 */

export { checkRules, compileRules, senderKey } from "./compile.js";
export {
  currentPinRules,
  DRY_RUN_SAMPLE_LIMIT,
  type DryRunMail,
  type DryRunResult,
  type DryRunSample,
  type DryRunTransition,
  dryRunRules,
  proposedPinRules,
} from "./dry-run.js";
export {
  type ApplyPlan,
  buildInventory,
  exportText,
  type InventoryRule,
  planApply,
  type RuleInventory,
  type StoredEmailRule,
  type StoredLearnedRule,
  toRuleRow,
} from "./inventory.js";
export { RULES_DSL_LIMITS } from "./limits.js";
export { parseRules } from "./parse.js";
export { type ReadOnlyEntry, type SerializeInput, serializeRules } from "./serialize.js";
export type {
  CompiledRule,
  CompileResult,
  DslAst,
  DslError,
  DslErrorCode,
  DslFailure,
  DslLane,
  ParseResult,
} from "./types.js";
