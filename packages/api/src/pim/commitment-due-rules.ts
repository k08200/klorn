/**
 * The deadline wordings the Commitment Ledger understands, Korean and English.
 * Rule shapes and shared readers: commitment-due-rule-kit.ts.
 */

import { type DueRule, SLASH_DATE_RULE } from "./commitment-due-rule-kit.js";
import { EN_RULES } from "./commitment-due-rules-en.js";
import { KO_RULES } from "./commitment-due-rules-ko.js";

export { type DueRule, END_OF_DAY } from "./commitment-due-rule-kit.js";

export const DUE_RULES: readonly DueRule[] = [...KO_RULES, ...EN_RULES, SLASH_DATE_RULE];
