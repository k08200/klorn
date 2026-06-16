import { describe, expect, it } from "vitest";
import { isGitHubNotificationPushable } from "../github-push.js";

describe("isGitHubNotificationPushable — recency guard", () => {
  const now = new Date("2026-06-16T12:00:00.000Z").getTime();

  it("allows a notification updated within the last 6 hours", () => {
    const recent = new Date(now - 60 * 60 * 1000); // 1h ago
    expect(isGitHubNotificationPushable(recent, now)).toBe(true);
  });

  it("blocks a stale notification older than 6 hours (resurfaced by the poller)", () => {
    const stale = new Date(now - 7 * 60 * 60 * 1000); // 7h ago
    expect(isGitHubNotificationPushable(stale, now)).toBe(false);
  });

  it("treats the exact 6-hour boundary as still pushable", () => {
    const boundary = new Date(now - 6 * 60 * 60 * 1000);
    expect(isGitHubNotificationPushable(boundary, now)).toBe(true);
  });
});
