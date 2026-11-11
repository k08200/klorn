import { describe, expect, it } from "vitest";
import { type PushBucket, resolvePushBucket } from "../notify/push-bucket.js";

// The caller picks the bucket per call; the category no longer does. Interrupt
// is opt-in: a push that does not ask for it rings ambient, whatever its
// category, so an agent that sends email_urgent or meeting cannot use up the
// room real urgent mail, meeting alerts and reminders need.
describe("resolvePushBucket", () => {
  it("rings interrupt only when the caller asks for it", () => {
    expect(resolvePushBucket("interrupt")).toBe("interrupt");
  });

  it("rings ambient when the caller asks for ambient", () => {
    expect(resolvePushBucket("ambient")).toBe("ambient");
  });

  it("defaults to ambient when the caller does not say", () => {
    expect(resolvePushBucket(undefined)).toBe("ambient");
  });

  it("fails closed to ambient for a value that is not a bucket", () => {
    expect(resolvePushBucket("INTERRUPT" as PushBucket)).toBe("ambient");
    expect(resolvePushBucket("" as PushBucket)).toBe("ambient");
  });
});
