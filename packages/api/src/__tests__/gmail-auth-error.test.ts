import { describe, expect, it } from "vitest";
import { isGoogleAuthError } from "../mail/gmail.js";

describe("isGoogleAuthError", () => {
  it("detects revoked OAuth refresh tokens", () => {
    expect(
      isGoogleAuthError({
        response: {
          status: 400,
          data: { error: { message: "invalid_grant: Token has been expired or revoked." } },
        },
      }),
    ).toBe(true);
  });

  it("detects unauthorized Google API responses", () => {
    expect(isGoogleAuthError({ response: { status: 401, data: { error: "invalid_token" } } })).toBe(
      true,
    );
  });

  it("does not treat quota and ordinary provider errors as auth disconnects", () => {
    expect(isGoogleAuthError({ response: { status: 429, data: { error: "rate_limit" } } })).toBe(
      false,
    );
    expect(isGoogleAuthError({ response: { status: 500, data: { error: "backend_error" } } })).toBe(
      false,
    );
  });
});
