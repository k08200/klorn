/**
 * What the model, an MCP client and the action outbox are told when a tool
 * throws: a fixed classification ("Tool failed: provider rate limited") plus a
 * code. Never the error's text: a tool result is read back by the model, so a
 * provider message quoting a mail would be a prompt-injection channel, and a
 * Prisma message would hand it values from other rows.
 *
 * The only messages that pass through are Klorn's own: a tool argument the
 * model got wrong (it needs the parameter name to retry) and the floor
 * refusals, whose text is a FLOOR_ACTIONS name, a schema version and hash
 * prefixes.
 */
import { classifyFailure, type ProviderFailureCode } from "../public-failure.js";

/** A tool argument the model got wrong. The message names the parameter, nothing else. */
export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolValidationError";
  }
}

/** Klorn-written error classes, matched by name so this module imports none of them. */
const KLORN_WRITTEN: ReadonlySet<string> = new Set([
  "ToolValidationError",
  "FloorReceiptRequiredError",
  "ActionReceiptMismatchError",
  "ActionReceiptSchemaError",
]);

export type ToolFailureCode = ProviderFailureCode | "INVALID_ARGUMENT" | "ACTION_REFUSED";

const CLASSIFICATION: Readonly<Record<ProviderFailureCode, string>> = {
  PROVIDER_AUTH_FAILED: "the connected account needs to be reconnected",
  PROVIDER_SCOPE_MISSING: "the connected account lacks a required permission",
  PROVIDER_NOT_FOUND: "the requested item was not found",
  PROVIDER_RATE_LIMITED: "provider rate limited",
  PROVIDER_UNAVAILABLE: "provider unavailable",
  RATE_LIMITED: "request rate limited",
  DAILY_COST_CAP: "daily AI limit reached",
  DAILY_COST_CAP_FREE: "daily AI limit reached",
  INTERNAL_ERROR: "internal error",
};

const TOOL_FAILURE_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(CLASSIFICATION),
  "INVALID_ARGUMENT",
  "ACTION_REFUSED",
]);

/** Codes a later attempt may clear; the action outbox retries these. */
export const TRANSIENT_TOOL_FAILURE_CODES: ReadonlySet<ToolFailureCode> = new Set([
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
]);

export function isToolFailureCode(value: unknown): value is ToolFailureCode {
  return typeof value === "string" && TOOL_FAILURE_CODES.has(value);
}

export interface ToolFailure {
  readonly error: string;
  readonly code: ToolFailureCode;
}

export function toolFailure(err: unknown): ToolFailure {
  if (err instanceof Error && KLORN_WRITTEN.has(err.name)) {
    const code = err.name === "ToolValidationError" ? "INVALID_ARGUMENT" : "ACTION_REFUSED";
    return { error: err.message, code };
  }
  const code = classifyFailure(err);
  return { error: `Tool failed: ${CLASSIFICATION[code]}`, code };
}

/** The tool result string the model reads: `{"error":"Tool failed: …","code":"…"}`. */
export function toolFailureResult(err: unknown): string {
  return JSON.stringify(toolFailure(err));
}
