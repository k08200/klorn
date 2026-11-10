/**
 * The one server-side gate every calendar `meetingLink` passes before it is
 * stored or handed on (Outlook since C4, Google and the create route since the
 * #1348 follow-up). The link reaches a web `<a href>`, the Mac app's
 * NSWorkspace.open, the model's prompt and MCP tools, so only an absolute https
 * URL with no userinfo, of at most 2048 characters, passes.
 */

import { describe, expect, it } from "vitest";
import { MAX_MEETING_LINK_LENGTH, safeMeetingLink } from "../pim/meeting-link.js";

describe("safeMeetingLink keeps a real join link unchanged", () => {
  it.each([
    ["Google Meet", "https://meet.google.com/abc-defg-hij"],
    ["Google Meet with query", "https://meet.google.com/abc-defg-hij?authuser=0&hs=122"],
    ["Zoom with a passcode", "https://zoom.us/j/123?pwd=x"],
    ["a Zoom vanity subdomain", "https://us02web.zoom.us/j/8512345678?pwd=abc.1"],
    [
      "a Teams meetup-join link, percent-encoding kept as sent",
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22t1%22%7d",
    ],
    ["a fragment", "https://zoom.us/j/1#success"],
  ])("%s", (_label, link) => {
    expect(safeMeetingLink(link)).toBe(link);
  });
});

describe("safeMeetingLink normalises", () => {
  it.each([
    [
      "an uppercase scheme and host",
      "HTTPS://Teams.Microsoft.com/x",
      "https://teams.microsoft.com/x",
    ],
    ["surrounding whitespace", "  https://meet.example.com/a  ", "https://meet.example.com/a"],
    ["a bare origin, given its path", "https://meet.google.com", "https://meet.google.com/"],
    [
      "characters a browser would encode anyway",
      "https://meet.google.com/abc-defg-hij>",
      "https://meet.google.com/abc-defg-hij%3E",
    ],
  ])("%s", (_label, input, expected) => {
    expect(safeMeetingLink(input)).toBe(expected);
  });
});

describe("safeMeetingLink drops anything that is not an https join link", () => {
  it.each([
    ["javascript:", "javascript:alert(document.cookie)"],
    ["file:", "file:///etc/passwd"],
    ["http:", "http://meet.google.com/abc-defg-hij"],
    ["http: with an uppercase scheme", "HTTP://zoom.us/j/1"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["a custom app scheme", "msteams://l/meetup-join/abc"],
    ["zoommtg:", "zoommtg://zoom.us/join?confno=123"],
    ["a scheme-relative link", "//evil.example.com/x"],
    ["a relative path", "/l/meetup-join/abc"],
    ["a username and password", "https://user:secret@evil.example.com/x"],
    ["a username alone", "https://zoom.us@evil.example.com/j/1"],
    ["a password alone", "https://:secret@meet.google.com/abc"],
    ["a malformed URL", "https://"],
    ["plain text", "join my meeting"],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", { href: "https://meet.google.com/abc" }],
  ])("%s", (_label, value) => {
    expect(safeMeetingLink(value)).toBeNull();
  });
});

describe("safeMeetingLink caps a link at 2048 characters", () => {
  const base = "https://meet.example.com/";

  it("is 2048", () => {
    expect(MAX_MEETING_LINK_LENGTH).toBe(2048);
  });

  it("keeps a link of exactly 2048 characters and drops one of 2049", () => {
    const atCap = base + "a".repeat(2048 - base.length);
    expect(atCap).toHaveLength(2048);

    expect(safeMeetingLink(atCap)).toBe(atCap);
    expect(safeMeetingLink(`${atCap}a`)).toBeNull();
  });

  it("holds the cap for the normalised link too: a short value that grows when percent-encoded is dropped", () => {
    // 1100 two-byte characters are 1100 long as written and 6600 once encoded.
    const grows = `${base}${"é".repeat(1100)}`;
    expect(grows.length).toBeLessThan(2048);

    expect(safeMeetingLink(grows)).toBeNull();
  });

  it("measures the raw value before parsing it: a padded value over the cap is dropped", () => {
    const padded = `${" ".repeat(2048)}https://meet.google.com/abc-defg-hij`;
    expect(safeMeetingLink(padded)).toBeNull();
  });
});
