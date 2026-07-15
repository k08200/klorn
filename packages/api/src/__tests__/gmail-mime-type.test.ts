import { describe, expect, it } from "vitest";
import { safeMimeType } from "../mail/gmail.js";

// safeMimeType reduces a client-supplied attachment Content-Type to a clean
// RFC 2045 type/subtype token before it is interpolated into a MIME header.
describe("safeMimeType", () => {
  it("passes a valid type/subtype through (lowercased)", () => {
    expect(safeMimeType("application/pdf")).toBe("application/pdf");
    expect(safeMimeType("IMAGE/PNG")).toBe("image/png");
  });

  it("drops parameters like charset and name", () => {
    expect(safeMimeType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(safeMimeType('application/octet-stream; name="x"')).toBe("application/octet-stream");
  });

  it("falls back to octet-stream for empty or non-type values", () => {
    expect(safeMimeType("")).toBe("application/octet-stream");
    expect(safeMimeType("notamimetype")).toBe("application/octet-stream");
    expect(safeMimeType('evil"; x="y')).toBe("application/octet-stream");
  });

  it("never emits header-breaking characters (CRLF / ; / quotes)", () => {
    const out = safeMimeType('text/plain\r\nX-Injected: evil; name="z"');
    expect(out).not.toMatch(/[\r\n;"]/);
    expect(out).not.toContain(" ");
    // Output must still be a clean single type/subtype token (or the fallback).
    expect(out).toMatch(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/);
  });
});
