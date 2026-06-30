import { describe, expect, it } from "vitest";
import { isRoutineAccountConfirmation } from "../poc-judge.js";

const email = (subject: string, snippet = "", body = "") => ({
  from: "security@service.example.com",
  subject,
  snippet,
  body,
});

// Founder decision (2026-06-30): routine account/security CONFIRMATIONS are
// QUEUE, not PUSH. This guard caps their urgency, but must NEVER catch a genuine
// alert that asks the user to act — those stay urgent.
describe("isRoutineAccountConfirmation", () => {
  it("flags routine account/security confirmations (→ urgency capped → QUEUE)", () => {
    expect(isRoutineAccountConfirmation(email("Phone number added on Instagram"))).toBe(true);
    expect(
      isRoutineAccountConfirmation(email("Phone number added as a two-factor authentication method")),
    ).toBe(true);
    expect(isRoutineAccountConfirmation(email("Security alert: new sign-in on Mac"))).toBe(true);
    expect(isRoutineAccountConfirmation(email("Your password was reset"))).toBe(true);
    expect(isRoutineAccountConfirmation(email("New device added to your account"))).toBe(true);
  });

  it("does NOT flag genuine alerts that ask the user to act (must stay PUSH-eligible)", () => {
    expect(isRoutineAccountConfirmation(email("Action required: verify unusual transaction"))).toBe(
      false,
    );
    // action language in the snippet
    expect(
      isRoutineAccountConfirmation(
        email("New sign-in detected", "If you didn't do this, secure your account now"),
      ),
    ).toBe(false);
    // action language in the body only (exclusion scans the body too)
    expect(
      isRoutineAccountConfirmation(email("New sign-in detected", "", "Was this you? Verify now.")),
    ).toBe(false);
  });

  it("does NOT flag unrelated mail with no confirmation pattern (stays PUSH-eligible)", () => {
    expect(isRoutineAccountConfirmation(email("Due diligence docs due Friday"))).toBe(false);
    expect(isRoutineAccountConfirmation(email("Action required: confirm your interview slot"))).toBe(
      false,
    );
    expect(isRoutineAccountConfirmation(email("URGENT: production down, need response ASAP"))).toBe(
      false,
    );
  });
});
