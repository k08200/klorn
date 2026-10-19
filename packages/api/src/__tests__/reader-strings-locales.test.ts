/**
 * Every template string a reader sees (deterministic tier reasons, the
 * needs-reply reason line) renders in each of the seven UI locales, and the
 * Korean copy carries no English template words — only brand and lane names
 * may stay Latin.
 */

import { describe, expect, it } from "vitest";
import { resolveTierReason, STATIC_TIER_REASONS } from "../judge/tier-reason-strings.js";
import {
  NEEDS_REPLY_REASON_COPY,
  needsReplyReasonText,
} from "../mail/needs-reply-reason-strings.js";
import { NOTIFICATION_LANGUAGES } from "../notify/notification-strings.js";

// Names that are the same word in every language.
const LATIN_ALLOWED = /\b(Klorn|PUSH|MEETING|QUEUE|INFO|SILENT|Gmail|Outlook)\b/g;

function latinWordsIn(text: string): string[] {
  return text.replace(LATIN_ALLOWED, "").match(/[A-Za-z]+/g) ?? [];
}

const TIER_KEYS = Object.keys(STATIC_TIER_REASONS) as Array<keyof typeof STATIC_TIER_REASONS>;
const REPLY_CODES = Object.keys(NEEDS_REPLY_REASON_COPY) as Array<
  keyof typeof NEEDS_REPLY_REASON_COPY
>;

describe("tier reasons per UI locale", () => {
  it.each(NOTIFICATION_LANGUAGES)("%s: every key resolves to that locale's copy", (lang) => {
    for (const key of TIER_KEYS) {
      expect(resolveTierReason(key, lang)).toBe(STATIC_TIER_REASONS[key][lang]);
    }
  });

  it.each(
    NOTIFICATION_LANGUAGES.filter((l) => l !== "en"),
  )("%s: copy is translated, not the English string", (lang) => {
    for (const key of TIER_KEYS) {
      expect(STATIC_TIER_REASONS[key][lang]).not.toBe(STATIC_TIER_REASONS[key].en);
    }
  });

  it("Korean tier reasons contain no Latin template words", () => {
    for (const key of TIER_KEYS) {
      expect(latinWordsIn(STATIC_TIER_REASONS[key].ko), key).toEqual([]);
    }
  });

  it("LLM prose (not a key) passes through in whatever language it was written", () => {
    expect(resolveTierReason("Investor asked for a call", "ko")).toBe("Investor asked for a call");
  });
});

describe("needs-reply reason line per UI locale", () => {
  it.each(NOTIFICATION_LANGUAGES)("%s: every code resolves to that locale's copy", (lang) => {
    for (const code of REPLY_CODES) {
      expect(needsReplyReasonText(code, lang)).toBe(NEEDS_REPLY_REASON_COPY[code][lang]);
    }
  });

  it.each(
    NOTIFICATION_LANGUAGES.filter((l) => l !== "en"),
  )("%s: copy is translated, not the English string", (lang) => {
    for (const code of REPLY_CODES) {
      expect(NEEDS_REPLY_REASON_COPY[code][lang]).not.toBe(NEEDS_REPLY_REASON_COPY[code].en);
    }
  });

  it("Korean reply reasons contain no Latin template words", () => {
    for (const code of REPLY_CODES) {
      expect(latinWordsIn(NEEDS_REPLY_REASON_COPY[code].ko), code).toEqual([]);
    }
  });

  it("negative, unknown and empty codes have no line (never the raw code)", () => {
    for (const code of ["no_reply_signal", "self_sent", "automated_or_low_value_sender"]) {
      expect(needsReplyReasonText(code, "ko")).toBeNull();
    }
    expect(needsReplyReasonText("something_new", "en")).toBeNull();
    expect(needsReplyReasonText(null, "en")).toBeNull();
    expect(needsReplyReasonText("", "en")).toBeNull();
  });

  it("an unknown language falls back to English", () => {
    expect(needsReplyReasonText("action_items_present", "xx")).toBe(
      NEEDS_REPLY_REASON_COPY.action_items_present.en,
    );
  });
});
