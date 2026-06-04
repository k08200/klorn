import { describe, expect, it } from "vitest";
import { isModelUnavailableError } from "../model-fallback.js";

describe("isModelUnavailableError — provider returned 404 / model retired", () => {
  it("matches a status-404 error object whose message mentions an endpoint", () => {
    expect(isModelUnavailableError({ status: 404, message: "No endpoint" })).toBe(true);
  });

  it("does NOT match a bare status-404 — message must point at a model or endpoint", () => {
    // A 404 with no body text is ambiguous (could be a route, auth, anything).
    // We must NOT silently swap providers on it.
    expect(isModelUnavailableError({ status: 404, message: "Not found" })).toBe(false);
  });

  it("matches a 404 SDK Error with the status prefixed in the message", () => {
    expect(isModelUnavailableError(new Error("404 No endpoints found"))).toBe(true);
  });

  it("matches OpenRouter's 'No endpoints found for ...' phrasing", () => {
    expect(
      isModelUnavailableError(new Error("No endpoints found for google/gemini-2.5-flash:free.")),
    ).toBe(true);
  });

  it("matches generic 'model not found' and 'no allowed providers' messages", () => {
    expect(isModelUnavailableError(new Error("model not found"))).toBe(true);
    expect(isModelUnavailableError(new Error("No allowed providers are available"))).toBe(true);
    expect(isModelUnavailableError(new Error("model has been deprecated"))).toBe(true);
  });

  it("does NOT match generic 404s that are clearly not about models", () => {
    expect(isModelUnavailableError(new Error("404 user route not found"))).toBe(false);
    expect(isModelUnavailableError(new Error("Page Not Found"))).toBe(false);
  });

  it("does NOT match credit / quota errors (those have their own classifiers)", () => {
    expect(isModelUnavailableError({ status: 402, message: "insufficient credits" })).toBe(false);
    expect(isModelUnavailableError({ status: 429, message: "rate limit" })).toBe(false);
  });

  it("does NOT match transient 5xx errors", () => {
    expect(isModelUnavailableError(new Error("500 Internal Server Error"))).toBe(false);
    expect(isModelUnavailableError({ status: 503, message: "service unavailable" })).toBe(false);
  });

  it("returns false for non-error inputs", () => {
    expect(isModelUnavailableError(null)).toBe(false);
    expect(isModelUnavailableError(undefined)).toBe(false);
    expect(isModelUnavailableError("just a string")).toBe(false);
  });
});
