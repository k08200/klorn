// Where a click on a notification may go. A meeting notification's link can
// come from a calendar invite anyone can send, so an absolute link opens in a
// new tab only when it is a plain https URL, and nothing navigates the app
// tab off-origin. Run from the api suite because the web package has no
// unit-test runner (see web-auth-surfaces.test.ts).
import { describe, expect, it } from "vitest";
import { notificationLinkTarget } from "../../../web/src/lib/notification-target";

describe("notificationLinkTarget", () => {
  it("routes a same-origin path inside the app", () => {
    expect(notificationLinkTarget("/email/abc")).toEqual({ kind: "internal", path: "/email/abc" });
    expect(notificationLinkTarget("/briefing?d=1")).toEqual({
      kind: "internal",
      path: "/briefing?d=1",
    });
  });

  it("opens an https meeting link outside the app", () => {
    expect(notificationLinkTarget("https://meet.google.com/abc-defg-hij")).toEqual({
      kind: "external",
      url: "https://meet.google.com/abc-defg-hij",
    });
  });

  it.each([
    "/\\evil.com",
    "//evil.com",
    "/.//evil.com",
    "http://evil.com",
    "javascript:alert(1)",
    "zoommtg://zoom.us/join?confno=1",
    "https://user@evil.com",
    "evil.com",
  ])("ignores %j", (link) => {
    expect(notificationLinkTarget(link)).toBeNull();
  });

  it("is null without a link", () => {
    expect(notificationLinkTarget(null)).toBeNull();
    expect(notificationLinkTarget(undefined)).toBeNull();
    expect(notificationLinkTarget("")).toBeNull();
  });
});
