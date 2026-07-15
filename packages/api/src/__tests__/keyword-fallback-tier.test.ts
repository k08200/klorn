import { describe, expect, it } from "vitest";
import { keywordFeatures } from "../judge/keyword-policy.js";
import { type TierFeatures, tierFromFeatures } from "../judge/tier-policy.js";

/**
 * The keyword fallback (used when the LLM judge is unavailable) scores the four
 * features deterministically, then the SAME tier rule decides the tier. A stray
 * `PUSH` from this path is a false interrupt.
 *
 * Item 6: a promo blast carrying an urgent word ("URGENT: sale today!") used to
 * borrow the urgentWord urgency (0.85) AND a pattern-matched confidence (0.7),
 * clearing the PUSH gate — marketing reaching PUSH in the fallback. Checking
 * marketing FIRST in the urgency branch caps marketing urgency low, so it can
 * never PUSH. The genuine PUSH paths (investor/system + urgency) are preserved.
 */

const tierOf = (email: { from: string; subject: string; snippet?: string }) =>
  tierFromFeatures(keywordFeatures(email)).tier;

describe("keyword fallback tiers — marketing can never PUSH (item 6)", () => {
  it("a promo blast with an urgent word does NOT PUSH", () => {
    expect(
      tierOf({
        from: "promos@shop.example",
        subject: "URGENT: sale ends today — unsubscribe anytime",
      }),
    ).not.toBe("PUSH");
  });

  it("caps marketing urgency below the PUSH gate even with urgent words", () => {
    const f: TierFeatures = keywordFeatures({
      from: "newsletter@shop.example",
      subject: "URGENT today only",
    });
    expect(f.urgency).toBeLessThan(0.7);
  });

  it("an urgent investor email STILL pushes (no regression)", () => {
    expect(tierOf({ from: "partner@vc.com", subject: "Urgent: term sheet expires today" })).toBe(
      "PUSH",
    );
  });

  it("an urgent mail from an unknown human does NOT push in the fallback", () => {
    // The fallback caps an unfamiliar sender's confidence at 0.55 (< the 0.7
    // PUSH gate), so it falls to QUEUE — the LLM retry is what catches these.
    expect(
      tierOf({ from: "stranger@unknown.example", subject: "URGENT please respond today" }),
    ).not.toBe("PUSH");
  });
});
