/**
 * tool-failure.ts: what the model reads when a tool throws. Klorn's own
 * refusals are matched by class, never by `name` (assignable by anyone), and
 * only a validation message passes through.
 */
import { describe, expect, it } from "vitest";
import { FloorReceiptRequiredError } from "../agentcore/floor-receipt-error.js";
import { ToolValidationError, toolFailure } from "../agentcore/tool-failure.js";
import { SendOutcomeUnknownError } from "../mail/providers/send-outcome-unknown.js";

const CANARY = "CANARY-tool quoted mail body";

describe("toolFailure", () => {
  it("passes a validation message through, so the model can fix the argument", () => {
    expect(toolFailure(new ToolValidationError("Missing or invalid parameter: to"))).toEqual({
      error: "Missing or invalid parameter: to",
      code: "INVALID_ARGUMENT",
    });
  });

  it("answers a floor refusal with a fixed sentence", () => {
    expect(toolFailure(new FloorReceiptRequiredError("send_email"))).toEqual({
      error: "Tool refused: this action runs only after the user approves it in Klorn.",
      code: "ACTION_REFUSED",
    });
  });

  it("never trusts a borrowed class name to pass its message through", () => {
    for (const name of ["ToolValidationError", "FloorReceiptRequiredError"]) {
      const spoof = Object.assign(new Error(CANARY), { name });
      expect(JSON.stringify(toolFailure(spoof))).not.toContain("CANARY");
      expect(toolFailure(spoof).code).toBe("INTERNAL_ERROR");
    }
  });

  it("never retries a send whose outcome is unknown, even over a network cause", () => {
    const err = new SendOutcomeUnknownError({
      cause: Object.assign(new Error(CANARY), { code: "ECONNRESET" }),
    });
    const failure = toolFailure(err);
    expect(failure.code).toBe("SEND_OUTCOME_UNKNOWN");
    expect(JSON.stringify(failure)).not.toContain("CANARY");
  });

  it("classifies a database pool timeout as a transient service failure", () => {
    const err = Object.assign(new Error(CANARY), {
      name: "PrismaClientKnownRequestError",
      code: "P2024",
    });
    expect(toolFailure(err)).toEqual({
      error: "Tool failed: service temporarily unavailable",
      code: "SERVICE_UNAVAILABLE",
    });
  });
});
