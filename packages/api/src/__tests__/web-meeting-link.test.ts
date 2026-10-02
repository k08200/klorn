// Pins packages/web/src/lib/meeting-link.ts. The web package has no unit-test
// runner (Playwright e2e only), so its pure helper is exercised from here —
// the util has no imports, which keeps this cross-package import trivial.
import { describe, expect, it } from "vitest";
import { safeMeetingHref } from "../../../web/src/lib/meeting-link";

describe("safeMeetingHref", () => {
  it("allows an absolute https link", () => {
    expect(safeMeetingHref("https://meet.google.com/abc")).toBe("https://meet.google.com/abc");
  });

  it("allows an upper-case scheme and host, normalised", () => {
    expect(safeMeetingHref("HTTPS://Zoom.us/j/1")).toBe("https://zoom.us/j/1");
  });

  it("refuses http", () => {
    expect(safeMeetingHref("http://meet.google.com/abc")).toBeNull();
  });

  it.each([
    ["javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["file:///etc/passwd"],
    ["zoommtg://zoom.us/join?confno=1"],
    ["msteams://teams.microsoft.com/l/meetup-join/x"],
    ["ftp://example.com/x"],
  ])("refuses a non-https scheme: %s", (raw) => {
    expect(safeMeetingHref(raw)).toBeNull();
  });

  it.each([
    ["https://user:pass@host/"],
    ["https://user@host/"],
    ["https://:pass@host/"],
    ["https://meet.google.com@evil.example/abc"],
  ])("refuses a link carrying userinfo: %s", (raw) => {
    expect(safeMeetingHref(raw)).toBeNull();
  });

  it.each([
    [""],
    [" https://x.example/"],
    ["https://x.example/ "],
    ["\thttps://x.example/"],
    ["https://x.exa\nmple/"],
    ["/x"],
    ["//evil.example/x"],
    ["meet.google.com/abc"],
  ])("refuses empty, padded, or relative input: %j", (raw) => {
    expect(safeMeetingHref(raw)).toBeNull();
  });

  it("refuses null and undefined", () => {
    expect(safeMeetingHref(null)).toBeNull();
    expect(safeMeetingHref(undefined)).toBeNull();
  });

  it("allows an IDN host, opened as its punycode form", () => {
    expect(safeMeetingHref("https://bücher.example/room")).toBe(
      "https://xn--bcher-kva.example/room",
    );
  });

  it("allows a punycode host as-is", () => {
    expect(safeMeetingHref("https://xn--bcher-kva.example/room")).toBe(
      "https://xn--bcher-kva.example/room",
    );
  });

  it("keeps the path and query of a real join link", () => {
    expect(safeMeetingHref("https://us02web.zoom.us/j/123?pwd=abc")).toBe(
      "https://us02web.zoom.us/j/123?pwd=abc",
    );
  });
});
