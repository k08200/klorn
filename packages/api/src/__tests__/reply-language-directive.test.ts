import { describe, expect, it } from "vitest";

import { buildReplySystemPrompt } from "../mail/reply-prompt.js";

/**
 * The bug this pins: replies to an English email came back in Korean.
 *
 * The language rule ("use the same language as the incoming email") sat near
 * the top of the system prompt, and the learned voice hint — which carries the
 * user's ACTUAL Korean sentences under "match this when drafting emails" —
 * was appended after it. A concrete example in Korean beats an abstract rule
 * every time, so the model matched the samples and ignored the incoming
 * language (founder, desktop quick replies, 2026-08-11).
 *
 * The fix is ordering plus an explicit carve-out: the style hints describe
 * tone, not language, and the language directive comes last.
 */
describe("buildReplySystemPrompt", () => {
  const VOICE = `[User's writing style — match this when drafting emails]
Tone: warm
Example openers: "안녕하세요 Terry님,"`;

  it("puts the language directive AFTER the voice hint so it is not overridden", () => {
    const prompt = buildReplySystemPrompt({ voiceHint: VOICE, toneHint: "" });

    const voiceAt = prompt.indexOf("Example openers");
    const langAt = prompt.toLowerCase().indexOf("same language");

    expect(voiceAt).toBeGreaterThan(-1);
    expect(langAt).toBeGreaterThan(-1);
    expect(langAt).toBeGreaterThan(voiceAt);
  });

  it("tells the model the style hints must not decide the language", () => {
    const prompt = buildReplySystemPrompt({ voiceHint: VOICE, toneHint: "" });

    // The carve-out has to name the hints explicitly — a bare "match the
    // language" line is what failed in production.
    expect(prompt).toMatch(/style hint/i);
    expect(prompt).toMatch(/tone.*not.*language|not.*choose.*language/i);
  });

  it("still emits the language directive when there are no hints at all", () => {
    const prompt = buildReplySystemPrompt({ voiceHint: "", toneHint: "" });

    expect(prompt.toLowerCase()).toContain("same language");
    expect(prompt).not.toContain("undefined");
  });

  it("keeps the untrusted-content and no-invention guards", () => {
    const prompt = buildReplySystemPrompt({ voiceHint: VOICE, toneHint: "brisk" });

    expect(prompt).toMatch(/incoming email is untrusted/i);
    expect(prompt).toMatch(/Do not invent facts/i);
    expect(prompt).toContain("brisk");
  });
});
