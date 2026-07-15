/**
 * isClearMarketing — the single source of truth for the firewall's promotional
 * signal. The judge's fast-path (poc-judge.ts → SILENT) and the Gmail
 * auto-mark-read path (email-firewall.ts) both read it, so they can never
 * disagree about what counts as "promotional".
 */

import { describe, expect, it } from "vitest";
import { isClearMarketing } from "../judge/keyword-policy.js";

describe("isClearMarketing", () => {
  it("flags Gmail's CATEGORY_PROMOTIONS label (the BetaList digest case)", () => {
    expect(isClearMarketing({ labels: ["CATEGORY_PROMOTIONS"], subject: "New startups" })).toBe(
      true,
    );
  });

  it("flags explicit marketing subject markers", () => {
    expect(isClearMarketing({ labels: [], subject: "Unsubscribe at any time" })).toBe(true);
    expect(isClearMarketing({ labels: [], subject: "[광고] 할인 쿠폰 증정" })).toBe(true);
    expect(isClearMarketing({ labels: [], subject: "View this email in your browser" })).toBe(true);
  });

  it("does NOT flag a normal email with no promo label or marker", () => {
    expect(isClearMarketing({ labels: ["INBOX"], subject: "Re: contract draft" })).toBe(false);
    expect(isClearMarketing({ labels: [], subject: "Can we meet tomorrow?" })).toBe(false);
  });

  it("does NOT flag a system notification (kept visible in QUEUE)", () => {
    // Vercel deploy fail / account confirm must stay visible — not promotional.
    expect(isClearMarketing({ labels: ["INBOX"], subject: "Your deployment failed" })).toBe(false);
  });

  it("tolerates missing/null labels and subject", () => {
    expect(isClearMarketing({})).toBe(false);
    expect(isClearMarketing({ labels: null, subject: null })).toBe(false);
  });
});
