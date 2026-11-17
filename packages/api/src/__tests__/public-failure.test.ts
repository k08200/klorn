/**
 * public-failure.ts: a failure reaches a client, the model or a stored column
 * as a stable code plus a fixed sentence and class/status facts — never the
 * error's own text, which can quote mail, titles or a prompt.
 */
import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  failureFacts,
  PROVIDER_FAILURE_CODES,
  providerFailureMessage,
  publicFailure,
  storedFailure,
} from "../public-failure.js";

const CANARY = "CANARY-7f3a quoted mail body";

/** A googleapis (gaxios) error: status on `response`, Google's reason tokens in `data`. */
function gaxiosError(status: number, data: unknown = {}): Error {
  const err = new Error(`Request failed: ${CANARY}`) as Error & {
    response: { status: number; data: unknown };
    code: string;
  };
  err.name = "GaxiosError";
  err.response = { status, data };
  err.code = String(status);
  return err;
}

function named(name: string, message = CANARY, fields: Record<string, unknown> = {}): Error {
  const err = new Error(message);
  err.name = name;
  return Object.assign(err, fields);
}

describe("classifyFailure", () => {
  it("reads a 401 and a revoked grant as PROVIDER_AUTH_FAILED", () => {
    expect(classifyFailure(gaxiosError(401))).toBe("PROVIDER_AUTH_FAILED");
    expect(classifyFailure(gaxiosError(400, { error: "invalid_grant" }))).toBe(
      "PROVIDER_AUTH_FAILED",
    );
  });

  it("reads Klorn's own 'Gmail not connected' throw as PROVIDER_AUTH_FAILED", () => {
    expect(classifyFailure(new Error("Gmail not connected"))).toBe("PROVIDER_AUTH_FAILED");
  });

  it("reads a 403 as a missing scope, unless Google's reason is a quota", () => {
    expect(classifyFailure(gaxiosError(403))).toBe("PROVIDER_SCOPE_MISSING");
    expect(
      classifyFailure(
        gaxiosError(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }),
      ),
    ).toBe("PROVIDER_RATE_LIMITED");
    expect(classifyFailure(gaxiosError(403, { error: { status: "RESOURCE_EXHAUSTED" } }))).toBe(
      "PROVIDER_RATE_LIMITED",
    );
  });

  it("reads 404 and 410 as PROVIDER_NOT_FOUND, 429 as PROVIDER_RATE_LIMITED", () => {
    expect(classifyFailure(gaxiosError(404))).toBe("PROVIDER_NOT_FOUND");
    expect(classifyFailure(gaxiosError(410))).toBe("PROVIDER_NOT_FOUND");
    expect(classifyFailure(gaxiosError(429))).toBe("PROVIDER_RATE_LIMITED");
  });

  it("reads 5xx, timeouts, socket codes and an exhausted LLM chain as PROVIDER_UNAVAILABLE", () => {
    expect(classifyFailure(gaxiosError(503))).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyFailure(named("Error", CANARY, { code: "ECONNRESET" }))).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    expect(classifyFailure(named("TimeoutError"))).toBe("PROVIDER_UNAVAILABLE");
    expect(
      classifyFailure(named("AllProvidersExhaustedError", CANARY, { cause: { status: 503 } })),
    ).toBe("PROVIDER_UNAVAILABLE");
  });

  it("reads an LLM SDK error's status, on the error or its cause", () => {
    expect(classifyFailure(named("RateLimitError", CANARY, { status: 429 }))).toBe(
      "PROVIDER_RATE_LIMITED",
    );
    expect(classifyFailure(named("Wrapper", CANARY, { cause: { status: 401 } }))).toBe(
      "PROVIDER_AUTH_FAILED",
    );
  });

  it("keeps Klorn's own throttle and the daily cost cap apart from the provider's", () => {
    expect(classifyFailure(named("UserRateLimitedError"))).toBe("RATE_LIMITED");
    expect(classifyFailure(named("DailyCostCapExceededError"))).toBe("DAILY_COST_CAP");
    expect(
      classifyFailure(named("DailyCostCapExceededError", CANARY, { code: "DAILY_COST_CAP_FREE" })),
    ).toBe("DAILY_COST_CAP_FREE");
  });

  it("reads a Prisma error, a JSON.parse failure and a non-Error as INTERNAL_ERROR", () => {
    expect(classifyFailure(named("PrismaClientValidationError"))).toBe("INTERNAL_ERROR");
    expect(classifyFailure(named("SyntaxError", `Unexpected token in ${CANARY}`))).toBe(
      "INTERNAL_ERROR",
    );
    expect(classifyFailure(CANARY)).toBe("INTERNAL_ERROR");
    expect(classifyFailure(null)).toBe("INTERNAL_ERROR");
  });
});

describe("providerFailureMessage", () => {
  it("has a fixed sentence for every code and service, naming the service", () => {
    for (const code of PROVIDER_FAILURE_CODES) {
      for (const service of ["gmail", "googleCalendar", "mail", "ai"] as const) {
        const message = providerFailureMessage(code, service);
        expect(message.length).toBeGreaterThan(10);
        expect(message).not.toContain("undefined");
      }
    }
    expect(providerFailureMessage("PROVIDER_RATE_LIMITED", "gmail")).toContain("Gmail");
  });

  it("keeps 'not connected' in the mail reconnect sentence (web clients match it)", () => {
    expect(providerFailureMessage("PROVIDER_AUTH_FAILED", "gmail").toLowerCase()).toContain(
      "not connected",
    );
  });

  it("tells an AI key failure to check the key, not to reconnect an account", () => {
    expect(providerFailureMessage("PROVIDER_AUTH_FAILED", "ai")).toMatch(/API key/);
  });
});

describe("publicFailure / failureFacts / storedFailure", () => {
  const failures = [
    gaxiosError(503, { error: { message: CANARY, errors: [{ message: CANARY }] } }),
    named("PrismaClientValidationError", `Invalid \`prisma.note.create()\` invocation: ${CANARY}`),
    named("SyntaxError", `Unexpected token in JSON at position 3: "${CANARY}"`),
    named("RateLimitError", CANARY, { status: 429, error: { message: CANARY } }),
    named("Error", CANARY, { cause: new Error(CANARY) }),
  ];

  it("never carries the error's text", () => {
    for (const err of failures) {
      const out = JSON.stringify([
        publicFailure(err, "gmail"),
        failureFacts(err),
        storedFailure("AI analysis failed", err),
      ]);
      expect(out).not.toContain("CANARY");
    }
  });

  it("states the class and status as facts", () => {
    expect(failureFacts(gaxiosError(503))).toBe("GaxiosError 503");
    expect(failureFacts(named("RateLimitError", CANARY, { status: 429 }))).toBe(
      "RateLimitError 429",
    );
    expect(failureFacts(named("PrismaClientKnownRequestError", CANARY, { code: "P2002" }))).toBe(
      "PrismaClientKnownRequestError P2002",
    );
  });

  it("stores the label, the code and the facts", () => {
    expect(storedFailure("AI analysis failed", gaxiosError(429))).toBe(
      "AI analysis failed (PROVIDER_RATE_LIMITED; GaxiosError 429)",
    );
  });

  it("answers the code with its fixed sentence", () => {
    expect(publicFailure(gaxiosError(401), "googleCalendar")).toEqual({
      code: "PROVIDER_AUTH_FAILED",
      error: providerFailureMessage("PROVIDER_AUTH_FAILED", "googleCalendar"),
    });
  });

  it("passes the cost cap's own Klorn-written sentence through", () => {
    const capped = named(
      "DailyCostCapExceededError",
      "Daily AI limit reached. Resets at 00:00 UTC.",
    );
    expect(publicFailure(capped, "ai")).toEqual({
      code: "DAILY_COST_CAP",
      error: "Daily AI limit reached. Resets at 00:00 UTC.",
    });
  });
});
