import { describe, expect, it } from "vitest";
import { applySpamFloor, hasSpamLabel } from "../judge/poc-judge.js";

describe("hasSpamLabel", () => {
  it("detects Gmail's SPAM label, tolerating absence", () => {
    expect(hasSpamLabel(["INBOX", "UNREAD"])).toBe(false);
    expect(hasSpamLabel(["SPAM", "UNREAD"])).toBe(true);
    expect(hasSpamLabel([])).toBe(false);
    expect(hasSpamLabel(undefined)).toBe(false);
  });
});

describe("applySpamFloor", () => {
  it("demotes interrupting tiers to QUEUE for spam-labeled mail", () => {
    for (const tier of ["PUSH", "MEETING"] as const) {
      const floored = applySpamFloor(["SPAM"], { tier, reason: "r" });
      expect(floored.tier).toBe("QUEUE");
    }
  });

  it("leaves non-interrupting tiers and non-spam mail untouched", () => {
    for (const tier of ["QUEUE", "SILENT", "INFO", "AUTO"] as const) {
      expect(applySpamFloor(["SPAM"], { tier, reason: "r" }).tier).toBe(tier);
    }
    expect(applySpamFloor(["INBOX"], { tier: "PUSH", reason: "r" }).tier).toBe("PUSH");
  });
});
