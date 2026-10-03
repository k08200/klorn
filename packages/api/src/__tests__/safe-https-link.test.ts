/**
 * The one rule for a link Klorn stores or hands on, whatever it points at
 * (safe-https-link.ts). A meeting link and a file link go through the same
 * function: pim/meeting-link.ts keeps its names as aliases, so the meeting
 * behaviour pinned by meeting-link.test.ts is unchanged by construction.
 */

import { describe, expect, it } from "vitest";
import { MAX_MEETING_LINK_LENGTH, safeMeetingLink } from "../pim/meeting-link.js";
import { MAX_HTTPS_LINK_LENGTH, safeHttpsLink } from "../safe-https-link.js";

describe("safeHttpsLink", () => {
  it("keeps an absolute https link, normalised", () => {
    expect(safeHttpsLink("https://drive.google.com/file/d/abc/view")).toBe(
      "https://drive.google.com/file/d/abc/view",
    );
    expect(safeHttpsLink("HTTPS://Example.com")).toBe("https://example.com/");
  });

  it.each([
    "javascript:alert(1)",
    "http://example.com/x",
    "file:///etc/passwd",
    "data:text/html,x",
    "https://user:pass@example.com/x",
    "https://user@example.com/x",
    "//example.com/x",
    "/relative",
    "not a url",
    "",
  ])("drops %j", (value) => {
    expect(safeHttpsLink(value)).toBeNull();
  });

  it.each([null, undefined, 7, {}, ["https://example.com"]])("drops the non-string %j", (value) => {
    expect(safeHttpsLink(value)).toBeNull();
  });

  it("drops a link longer than the cap, before or after normalising", () => {
    expect(MAX_HTTPS_LINK_LENGTH).toBe(2048);
    const base = "https://example.com/";
    expect(
      safeHttpsLink(`${base}${"a".repeat(MAX_HTTPS_LINK_LENGTH - base.length)}`),
    ).not.toBeNull();
    expect(safeHttpsLink(`${base}${"a".repeat(MAX_HTTPS_LINK_LENGTH)}`)).toBeNull();
    // Each space becomes %20: within the cap as typed, over it once normalised.
    expect(safeHttpsLink(`${base}${" x".repeat(900)}`)).toBeNull();
  });
});

describe("the meeting names are the same function and the same cap", () => {
  it("safeMeetingLink is safeHttpsLink", () => {
    expect(safeMeetingLink).toBe(safeHttpsLink);
    expect(MAX_MEETING_LINK_LENGTH).toBe(MAX_HTTPS_LINK_LENGTH);
  });
});
