/**
 * Row signals — the per-row context chips (mail-first shell, 2026-08-26).
 *
 * The lanes move from navigation to labels: every row carries its lane chip,
 * plus ONE relationship/category signal so the intelligence shows on the row
 * without turning it into a tag cloud. These are the pure mappings the route
 * uses; each claim must come from a recorded fact, never a guess — a wrong
 * "first contact" label on a ten-year colleague is worse than no label.
 */

import { describe, expect, it } from "vitest";
import { gmailCategoryOf, judgeSignalOf, rowSignalFor } from "../judge/row-signals.js";

describe("judgeSignalOf", () => {
  it("surfaces the classifier's relationship/function categories", () => {
    expect(judgeSignalOf("internal")).toBe("internal");
    expect(judgeSignalOf("customer")).toBe("customer");
    expect(judgeSignalOf("investor")).toBe("investor");
    expect(judgeSignalOf("system")).toBe("system");
  });

  it("maps the vocabulary the summarize pass ACTUALLY stores", () => {
    // EmailMessage.category is written by email-summarize (billing | meeting |
    // engineering | conversation | automated | newsletter | personal |
    // business | other) — the classifier's 8-word vocabulary reaches the DB
    // only via the agent tool. The first mapping shipped against the wrong
    // list, so 회사/고객/투자자 chips could never appear on real rows.
    expect(judgeSignalOf("billing")).toBe("billing");
    expect(judgeSignalOf("engineering")).toBe("system");
    expect(judgeSignalOf("newsletter")).toBe("promotions");
  });

  it("folds automated into promotions — one bulk-mail category, not two", () => {
    expect(judgeSignalOf("automated")).toBe("promotions");
  });

  it("meeting/conversation/other claim nothing (the lane already says meeting)", () => {
    expect(judgeSignalOf("meeting")).toBeNull();
    expect(judgeSignalOf("conversation")).toBeNull();
    expect(judgeSignalOf("other")).toBeNull();
    // personal/business stay unclaimed: the summarize pass can't tell 회사
    // from 고객, and a wrong claim is worse than none.
    expect(judgeSignalOf("personal")).toBeNull();
    expect(judgeSignalOf("business")).toBeNull();
    expect(judgeSignalOf(null)).toBeNull();
    expect(judgeSignalOf("garbage-from-old-rows")).toBeNull();
  });
});

describe("gmailCategoryOf", () => {
  it("maps Gmail category labels, first match in fixed precedence", () => {
    expect(gmailCategoryOf(["INBOX", "CATEGORY_PROMOTIONS"])).toBe("promotions");
    expect(gmailCategoryOf(["CATEGORY_SOCIAL", "UNREAD"])).toBe("social");
    expect(gmailCategoryOf(["CATEGORY_UPDATES"])).toBe("updates");
    expect(gmailCategoryOf(["CATEGORY_FORUMS"])).toBe("forums");
    // Promotions wins when Gmail stamps several (it is the strongest claim).
    expect(gmailCategoryOf(["CATEGORY_UPDATES", "CATEGORY_PROMOTIONS"])).toBe("promotions");
    expect(gmailCategoryOf(["INBOX", "IMPORTANT"])).toBeNull();
    expect(gmailCategoryOf(undefined)).toBeNull();
  });
});

describe("rowSignalFor", () => {
  it("a declared company domain outranks everything — it is a recorded fact about WHO", () => {
    // A colleague forwarding a receipt: 회사 (declared), not 청구 (judged).
    expect(
      rowSignalFor({
        internal: true,
        judgeCategory: "billing",
        category: "updates",
        repliedCount: 0,
      }),
    ).toEqual({ kind: "category", category: "internal" });
    // Not on a company domain: the rest of the ladder is untouched.
    expect(
      rowSignalFor({ internal: false, judgeCategory: "billing", category: null, repliedCount: 0 }),
    ).toEqual({ kind: "category", category: "billing" });
  });

  it("the judge's verdict outranks Gmail's tab — 회사 beats a stray label", () => {
    expect(
      rowSignalFor({ judgeCategory: "internal", category: "updates", repliedCount: 6 }),
    ).toEqual({ kind: "category", category: "internal" });
  });

  it("a security notice is 시스템 even from a first-time sender", () => {
    // The founder's screenshot: an OpenAI sign-in alert labelled 첫 연락.
    expect(rowSignalFor({ judgeCategory: "system", category: null, repliedCount: 0 })).toEqual({
      kind: "category",
      category: "system",
    });
  });

  it("category outranks relationship — a newsletter is never 'first contact'", () => {
    expect(rowSignalFor({ category: "promotions", repliedCount: 0 })).toEqual({
      kind: "category",
      category: "promotions",
    });
  });

  it("replied count is the personal signal when history exists", () => {
    expect(rowSignalFor({ category: null, repliedCount: 6 })).toEqual({
      kind: "replied",
      count: 6,
    });
  });

  it("no category and no reply history = first contact", () => {
    expect(rowSignalFor({ category: null, repliedCount: 0 })).toEqual({ kind: "first" });
  });

  it("unknown history (no engagement lookup) claims nothing", () => {
    // null repliedCount means we could not look it up — a missing fact must
    // render as no chip, not as "first contact".
    expect(rowSignalFor({ category: null, repliedCount: null })).toBeNull();
  });
});
