import { describe, expect, it } from "vitest";
import { isGoogleLoginStart, isInternalUrl, isSafeExternalUrl } from "../config.js";

// These run against the config defaults (no env overrides): web :8001, api :3001.

describe("isGoogleLoginStart", () => {
  it("matches the API's bare Google login start path", () => {
    expect(isGoogleLoginStart("http://localhost:3001/api/auth/google/login")).toBe(true);
    expect(isGoogleLoginStart("http://localhost:3001/api/auth/google/login?prompt=consent")).toBe(
      true,
    );
  });

  it("does NOT match the native flow's own source=desktop URL (no recursion)", () => {
    expect(
      isGoogleLoginStart("http://localhost:3001/api/auth/google/login?source=desktop&nonce=abc"),
    ).toBe(false);
  });

  it("excludes source=desktop case-insensitively (no recursion via casing)", () => {
    expect(
      isGoogleLoginStart("http://localhost:3001/api/auth/google/login?source=Desktop&nonce=abc"),
    ).toBe(false);
    expect(isGoogleLoginStart("http://localhost:3001/api/auth/google/login?source=DESKTOP")).toBe(
      false,
    );
  });

  it("does not match other origins, paths, or schemes", () => {
    expect(isGoogleLoginStart("http://localhost:8001/api/auth/google/login")).toBe(false); // web origin
    expect(isGoogleLoginStart("http://localhost:3001/api/auth/google/callback")).toBe(false);
    expect(isGoogleLoginStart("https://accounts.google.com/o/oauth2/v2/auth")).toBe(false);
    expect(isGoogleLoginStart("javascript:alert(1)")).toBe(false);
    expect(isGoogleLoginStart("not a url")).toBe(false);
  });
});

describe("origin guards (sanity)", () => {
  it("treats the web origin as internal and other origins as not", () => {
    expect(isInternalUrl("http://localhost:8001/inbox")).toBe(true);
    expect(isInternalUrl("http://localhost:3001/api/auth/google/login")).toBe(false);
  });

  it("accepts only http(s) as safe-external", () => {
    expect(isSafeExternalUrl("https://accounts.google.com")).toBe(true);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
  });
});
