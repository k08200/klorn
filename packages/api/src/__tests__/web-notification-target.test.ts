// Where a click on a notification may go. A meeting notification's link can
// come from a calendar invite anyone can send, so an absolute link opens in a
// new tab only when it is a plain https URL, and nothing navigates the app
// tab off-origin. Run from the api suite because the web package has no
// unit-test runner (see web-auth-surfaces.test.ts).
import { describe, expect, it } from "vitest";
import {
  notificationClickTarget,
  notificationLinkTarget,
} from "../../../web/src/lib/notification-target";

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

// What a click on a bell row opens (the bell's getNotificationTarget). An
// urgent-mail row used to fall through to the email type's route, /briefing,
// instead of opening the mail it names.
describe("notificationClickTarget", () => {
  const row = (fields: Partial<Parameters<typeof notificationClickTarget>[0]>) => ({
    type: "email",
    link: null,
    sourceEmailId: null,
    conversationId: null,
    pendingActionId: null,
    pendingActionStatus: null,
    ...fields,
  });

  it("follows the row's own link first", () => {
    expect(notificationClickTarget(row({ link: "/email/e1", sourceEmailId: "other" }))).toEqual({
      kind: "internal",
      path: "/email/e1",
    });
  });

  it("opens the mail a row names when it has no link (rows written before the link)", () => {
    expect(notificationClickTarget(row({ sourceEmailId: "e1" }))).toEqual({
      kind: "internal",
      path: "/email/e1",
    });
  });

  it("encodes the mail id, so it can never add a path segment", () => {
    expect(notificationClickTarget(row({ sourceEmailId: "a/../b" }))).toEqual({
      kind: "internal",
      path: "/email/a%2F..%2Fb",
    });
  });

  it("falls back to the mail list for an email row that names no mail", () => {
    expect(notificationClickTarget(row({}))).toEqual({ kind: "internal", path: "/email" });
  });

  it("an unsafe link is ignored, never followed", () => {
    expect(notificationClickTarget(row({ link: "//evil.example", sourceEmailId: "e1" }))).toEqual({
      kind: "internal",
      path: "/email/e1",
    });
  });

  it("a meeting row's https join link still opens outside the app", () => {
    expect(
      notificationClickTarget(row({ type: "meeting", link: "https://meet.google.com/abc" })),
    ).toEqual({ kind: "external", url: "https://meet.google.com/abc" });
  });

  it("a meeting row without a link keeps its type route", () => {
    expect(notificationClickTarget(row({ type: "meeting" }))).toEqual({
      kind: "internal",
      path: "/briefing",
    });
  });

  it("a pending action still waiting opens the inbox, even on a row that names a mail", () => {
    expect(
      notificationClickTarget(
        row({
          type: "agent_proposal",
          pendingActionId: "pa1",
          pendingActionStatus: "PENDING",
          sourceEmailId: "e1",
        }),
      ),
    ).toEqual({ kind: "internal", path: "/inbox" });
  });

  it("keeps the other type routes", () => {
    expect(notificationClickTarget(row({ type: "briefing" }))).toEqual({
      kind: "internal",
      path: "/briefing",
    });
    expect(notificationClickTarget(row({ type: "task" }))).toEqual({
      kind: "internal",
      path: "/inbox",
    });
    expect(notificationClickTarget(row({ type: "unknown" }))).toEqual({
      kind: "internal",
      path: "/inbox",
    });
  });
});
