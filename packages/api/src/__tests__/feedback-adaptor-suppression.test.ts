import { describe, expect, it } from "vitest";
import { isSuppressed, priorityBucket, suppressionKey } from "../learning/feedback-adaptor.js";

describe("priorityBucket", () => {
  it("classifies high/medium/low correctly", () => {
    expect(priorityBucket(100)).toBe("HIGH");
    expect(priorityBucket(70)).toBe("HIGH");
    expect(priorityBucket(69)).toBe("MEDIUM");
    expect(priorityBucket(40)).toBe("MEDIUM");
    expect(priorityBucket(39)).toBe("LOW");
    expect(priorityBucket(0)).toBe("LOW");
  });
});

describe("suppressionKey", () => {
  it("returns a bucket-less key when bucket is null/undefined", () => {
    expect(suppressionKey("TASK", "DEADLINE")).toBe("TASK:DEADLINE");
    expect(suppressionKey("TASK", "DEADLINE", null)).toBe("TASK:DEADLINE");
  });

  it("returns a bucket-scoped key when bucket is present", () => {
    expect(suppressionKey("TASK", "DEADLINE", "LOW")).toBe("TASK:DEADLINE:LOW");
  });
});

describe("isSuppressed", () => {
  it("matches granular tuple before falling back to broad pair", () => {
    const set = new Set([suppressionKey("TASK", "DEADLINE", "LOW")]);
    expect(isSuppressed(set, "TASK", "DEADLINE", 10)).toBe(true);
    expect(isSuppressed(set, "TASK", "DEADLINE", 90)).toBe(false);
  });

  it("treats a legacy (no-bucket) entry as a wildcard match across buckets", () => {
    const set = new Set([suppressionKey("TASK", "DEADLINE")]);
    expect(isSuppressed(set, "TASK", "DEADLINE", 10)).toBe(true);
    expect(isSuppressed(set, "TASK", "DEADLINE", 90)).toBe(true);
  });

  it("returns false when neither key is present", () => {
    const set = new Set<string>();
    expect(isSuppressed(set, "TASK", "DEADLINE", 50)).toBe(false);
  });

  it("checks only the broad pair when priority is omitted", () => {
    const granular = new Set([suppressionKey("TASK", "DEADLINE", "LOW")]);
    // Without a priority we cannot match the bucket-scoped key, so the
    // broad pair lookup must be the only signal.
    expect(isSuppressed(granular, "TASK", "DEADLINE")).toBe(false);

    const broad = new Set([suppressionKey("TASK", "DEADLINE")]);
    expect(isSuppressed(broad, "TASK", "DEADLINE")).toBe(true);
  });
});
