import { describe, expect, it } from "vitest";
import { dogfoodEmailClassificationFixtures } from "../__fixtures__/email-classification/dogfood.js";
import { fastClassify } from "../email-classifier.js";

/**
 * fastClassify is the keep-the-LLM-out-of-this gate.
 *
 * Every fixture that *should* be handled deterministically by sender / Gmail
 * label / subject markers MUST be claimed here. The point isn't to maximize
 * fastClassify coverage — it's to lock in the regressions audited 2026-05-19
 * so the next time the LLM's politeness gets it to upgrade a 광고 mail to
 * "needs reply", this test fails first.
 */

const DETERMINISTIC_IDS = new Set<string>([
  // Pre-existing fixtures the original implementation already caught.
  "promo_urgent_discount_stays_low",
  "newsletter_action_required_stays_low",
  "security_no_reply_does_not_need_reply",
  // Added 2026-05-19 — the regression set.
  "donotreply_variants_are_automated",
  "korean_ad_marker_stays_low",
  "gmail_promotions_label_overrides_urgent_subject",
  "view_in_browser_is_marketing",
  "korean_marketing_subject_pattern",
  "korean_security_otp_not_a_reply",
  "billing_invoice_no_reply",
  "bounce_postmaster_dropped",
]);

const LLM_ONLY_IDS = new Set<string>([
  "investor_reply_needs_same_day_review",
  "customer_contract_today_is_urgent",
  "meeting_scheduling_is_normal",
]);

describe("fastClassify", () => {
  it("covers every fixture that should bypass the LLM", () => {
    for (const fixture of dogfoodEmailClassificationFixtures) {
      const result = fastClassify({
        from: fixture.from,
        subject: fixture.subject,
        snippet: fixture.snippet,
        labels: [...fixture.labels],
      });

      if (DETERMINISTIC_IDS.has(fixture.id)) {
        expect(result, `${fixture.id} expected fastClassify to fire`).not.toBeNull();
        expect(result?.priority).toBe(fixture.expectedBatchLabel.priority);
        expect(result?.category).toBe(fixture.expectedBatchLabel.category);
        expect(result?.needsReply).toBe(fixture.expectedBatchLabel.needsReply);
      } else if (LLM_ONLY_IDS.has(fixture.id)) {
        expect(result, `${fixture.id} must defer to the LLM`).toBeNull();
      } else {
        // Force the maintainer to claim every new fixture explicitly: either
        // add it to DETERMINISTIC_IDS / LLM_ONLY_IDS, or remove this test's
        // global coverage guarantee.
        throw new Error(
          `Fixture ${fixture.id} is not classified as either deterministic or LLM-only. Add it to the test's coverage sets.`,
        );
      }
    }
  });

  it("matches all common do-not-reply sender variants", () => {
    const variants = [
      "noreply@example.com",
      "no-reply@example.com",
      "no_reply@example.com",
      "donotreply@example.com",
      "do-not-reply@example.com",
      "do_not_reply@example.com",
      "MAILER-DAEMON@example.com",
      "postmaster@example.com",
      "bounce@example.com",
      "bounces@example.com",
      "notifications@example.com",
      "alerts@example.com",
      "billing@example.com",
      "invoice@example.com",
      "newsletter@example.com",
      "marketing@example.com",
    ];

    for (const from of variants) {
      const result = fastClassify({ from, subject: "Anything", snippet: "" });
      expect(result, `${from} should be caught as automated`).not.toBeNull();
      expect(result?.category).toMatch(/automated|system/);
      expect(result?.needsReply).toBe(false);
    }
  });

  it("uses CATEGORY_PROMOTIONS as a hard override regardless of subject urgency", () => {
    const result = fastClassify({
      from: "team@startup.example", // not in the sender deny-list
      subject: "Action required: trial expires tomorrow",
      snippet: "Upgrade now",
      labels: ["INBOX", "CATEGORY_PROMOTIONS"],
    });
    expect(result?.category).toBe("automated");
    expect(result?.needsReply).toBe(false);
  });

  it("upgrades automated security alerts to medium so they surface as system", () => {
    const result = fastClassify({
      from: "noreply@accounts.example",
      subject: "Verify your sign-in",
      snippet: "",
    });
    expect(result?.priority).toBe("medium");
    expect(result?.category).toBe("system");
  });

  it("returns null for a real human-shaped email so the LLM can decide", () => {
    expect(
      fastClassify({
        from: "Mina Park <mina@alpha-capital.com>",
        subject: "Re: Seed round follow-up",
        snippet: "Can you confirm the SAFE cap by EOD?",
      }),
    ).toBeNull();
  });
});
