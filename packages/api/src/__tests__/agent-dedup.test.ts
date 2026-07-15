import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetDedupForTests,
  recordDedupKey,
  wasRecentlyDeduped,
} from "../agentcore/agent-dedup.js";

describe("agent-dedup", () => {
  beforeEach(() => {
    __resetDedupForTests();
  });

  it("returns false when key was never recorded", () => {
    expect(wasRecentlyDeduped("user-1", "email_followup:abc")).toBe(false);
  });

  it("returns true after recording within TTL", () => {
    const now = 1_000;
    recordDedupKey("user-1", "email_followup:abc", 60_000, now);
    expect(wasRecentlyDeduped("user-1", "email_followup:abc", now + 30_000)).toBe(true);
  });

  it("returns false after TTL expires", () => {
    const now = 1_000;
    recordDedupKey("user-1", "email_followup:abc", 60_000, now);
    expect(wasRecentlyDeduped("user-1", "email_followup:abc", now + 70_000)).toBe(false);
  });

  it("scopes keys per user", () => {
    const now = 1_000;
    recordDedupKey("user-1", "email_followup:abc", 60_000, now);
    expect(wasRecentlyDeduped("user-2", "email_followup:abc", now)).toBe(false);
  });

  it("returns false for empty dedupKey", () => {
    recordDedupKey("user-1", "", 60_000, 1_000);
    expect(wasRecentlyDeduped("user-1", "", 1_500)).toBe(false);
  });

  it("treats different keys as independent", () => {
    const now = 1_000;
    recordDedupKey("user-1", "email_followup:abc", 60_000, now);
    expect(wasRecentlyDeduped("user-1", "email_followup:xyz", now)).toBe(false);
  });

  it("re-recording extends the TTL", () => {
    const now = 1_000;
    recordDedupKey("user-1", "task_overdue:t1", 60_000, now);
    // Re-record at +50_000 with a fresh 60_000 window — entry should now live until 110_000
    recordDedupKey("user-1", "task_overdue:t1", 60_000, now + 50_000);
    expect(wasRecentlyDeduped("user-1", "task_overdue:t1", now + 100_000)).toBe(true);
  });
});
