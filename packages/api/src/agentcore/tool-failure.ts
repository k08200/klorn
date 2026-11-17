/**
 * What the model, an MCP client and the action outbox are told when a tool
 * throws: a fixed classification ("Tool failed: provider rate limited") plus a
 * code. Never the error's text: a tool result is read back by the model, so a
 * provider message quoting a mail would be a prompt-injection channel, and a
 * Prisma message would hand it values from other rows.
 *
 * The only message that passes through is a tool argument the model got
 * wrong (it needs the parameter name to retry); Klorn's other refusals answer
 * a fixed sentence per class.
 */
import { ActionReceiptMismatchError, ActionReceiptSchemaError } from "../judge/attention-floor.js";
import { SendOutcomeUnknownError } from "../mail/providers/send-outcome-unknown.js";
import { classifyFailure, type ProviderFailureCode } from "../public-failure.js";
import { FloorReceiptRequiredError } from "./floor-receipt-error.js";

/** A tool argument the model got wrong. The message names the parameter, nothing else. */
export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolValidationError";
  }
}

export type ToolFailureCode =
  | ProviderFailureCode
  | "INVALID_ARGUMENT"
  | "ACTION_REFUSED"
  | "SEND_OUTCOME_UNKNOWN";

const CLASSIFICATION: Readonly<Record<ProviderFailureCode, string>> = {
  PROVIDER_AUTH_FAILED: "the connected account needs to be reconnected",
  PROVIDER_SCOPE_MISSING: "the connected account lacks a required permission",
  PROVIDER_NOT_FOUND: "the requested item was not found",
  PROVIDER_RATE_LIMITED: "provider rate limited",
  PROVIDER_UNAVAILABLE: "provider unavailable",
  RATE_LIMITED: "request rate limited",
  DAILY_COST_CAP: "daily AI limit reached",
  DAILY_COST_CAP_FREE: "daily AI limit reached",
  SERVICE_UNAVAILABLE: "service temporarily unavailable",
  INTERNAL_ERROR: "internal error",
};

const TOOL_FAILURE_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(CLASSIFICATION),
  "INVALID_ARGUMENT",
  "ACTION_REFUSED",
  "SEND_OUTCOME_UNKNOWN",
]);

/** Codes a later attempt may clear; the action outbox retries these. */
export const TRANSIENT_TOOL_FAILURE_CODES: ReadonlySet<ToolFailureCode> = new Set([
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
]);

export function isToolFailureCode(value: unknown): value is ToolFailureCode {
  return typeof value === "string" && TOOL_FAILURE_CODES.has(value);
}

export interface ToolFailure {
  readonly error: string;
  readonly code: ToolFailureCode;
}

/**
 * Klorn's own refusals, matched by class (never by `name`, which any code can
 * assign). Only a validation message passes through, since it names the
 * parameter the model must fix; the rest answer a fixed sentence.
 */
function klornWritten(err: unknown): ToolFailure | null {
  if (err instanceof ToolValidationError) return { error: err.message, code: "INVALID_ARGUMENT" };
  if (err instanceof FloorReceiptRequiredError) {
    return {
      error: "Tool refused: this action runs only after the user approves it in Klorn.",
      code: "ACTION_REFUSED",
    };
  }
  if (err instanceof ActionReceiptMismatchError || err instanceof ActionReceiptSchemaError) {
    return {
      error:
        "Tool refused: the approved action changed or its approval is outdated; it needs approval again.",
      code: "ACTION_REFUSED",
    };
  }
  // Never retried: the provider may have delivered it (send-outcome-unknown.ts).
  if (err instanceof SendOutcomeUnknownError) {
    return {
      error:
        "Tool failed: the message may already have been sent; check Sent Items before retrying.",
      code: "SEND_OUTCOME_UNKNOWN",
    };
  }
  return null;
}

export function toolFailure(err: unknown): ToolFailure {
  const own = klornWritten(err);
  if (own !== null) return own;
  const code = classifyFailure(err);
  return { error: `Tool failed: ${CLASSIFICATION[code]}`, code };
}

/** The tool result string the model reads: `{"error":"Tool failed: …","code":"…"}`. */
export function toolFailureResult(err: unknown): string {
  return JSON.stringify(toolFailure(err));
}
