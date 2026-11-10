import { describe, expect, it } from "vitest";
import { linkOutcome, parseLinkComplete } from "./link-relay";

const H = "a".repeat(64);

describe("account link relay", () => {
  it("takes only a well-formed handle from the app's own scheme", () => {
    expect(parseLinkComplete(`ai.klorn.app://link-complete?h=${H}`)).toBe(H);
    expect(parseLinkComplete(`ai.klorn.app:///link-complete?h=${H}`)).toBe(H);
    expect(parseLinkComplete(`ai.klorn.app://oauth-callback?h=${H}`)).toBeNull();
    expect(parseLinkComplete(`evil.app://link-complete?h=${H}`)).toBeNull();
    expect(parseLinkComplete("ai.klorn.app://link-complete?h=short")).toBeNull();
    expect(parseLinkComplete("not a url")).toBeNull();
  });

  it("reads the outcome from the server's next path, failing closed", () => {
    expect(linkOutcome("/settings?inbox=success")).toEqual({ area: "inbox", result: "success" });
    expect(linkOutcome("/calendar?linked=unverified")).toEqual({
      area: "calendar",
      result: "unverified",
    });
    expect(linkOutcome("/files?drive=limit")).toEqual({ area: "drive", result: "limit" });
    expect(linkOutcome("/settings?inbox=pro")).toEqual({ area: "inbox", result: "pro" });
    expect(linkOutcome("/settings?inbox=weird")).toEqual({ area: "inbox", result: "failed" });
    expect(linkOutcome("/settings")).toEqual({ area: "inbox", result: "failed" });
    expect(linkOutcome(undefined).result).toBe("failed");
  });
});
