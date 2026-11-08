import { describe, expect, it } from "vitest";
import type { NotifCategory } from "../notify/notification-prefs.js";
import { pushBucketFor } from "../notify/push-bucket.js";

// Urgent mail and meeting alerts are the interrupts the user must always get:
// they ring against their own bucket, which nothing else can use up.
describe("pushBucketFor", () => {
  it.each<NotifCategory>([
    "email_urgent",
    "meeting",
  ])("%s rings against the interrupt bucket", (c) => {
    expect(pushBucketFor(c)).toBe("interrupt");
  });

  it.each<NotifCategory>([
    "email_candidate",
    "task_due",
    "agent_proposal",
    "daily_briefing",
    "system",
  ])("%s rings against the ambient bucket", (c) => {
    expect(pushBucketFor(c)).toBe("ambient");
  });
});
