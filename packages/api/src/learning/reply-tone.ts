/**
 * The user's explicitly-chosen reply register.
 *
 * Distinct from the voice profile (learning/voice-profile-extractor.ts), which
 * *infers* how the user already writes. This is what they *asked* for, so when
 * both exist the explicit choice wins — an inferred "casual" must not override
 * someone who just ticked "formal" in Preferences.
 *
 * "MATCH_ME" is the default and means "no explicit choice": fall back to the
 * learned profile alone, i.e. the behaviour that existed before this setting.
 */

import { prisma } from "../db.js";

export const REPLY_TONES = ["MATCH_ME", "FORMAL", "FRIENDLY", "CASUAL"] as const;

export type ReplyTone = (typeof REPLY_TONES)[number];

export interface ReplyTonePolicy {
  tone: ReplyTone;
  label: string;
  description: string;
}

export const REPLY_TONE_POLICIES: Record<ReplyTone, ReplyTonePolicy> = {
  MATCH_ME: {
    tone: "MATCH_ME",
    label: "Match my writing",
    description: "Learn the register from your own sent mail.",
  },
  FORMAL: {
    tone: "FORMAL",
    label: "Polite",
    description: "Polite and businesslike. Honorifics where the language has them.",
  },
  FRIENDLY: {
    tone: "FRIENDLY",
    label: "Work",
    description: "Warm but still professional. The everyday default.",
  },
  CASUAL: {
    tone: "CASUAL",
    label: "Casual",
    description: "Relaxed and short, the way you'd write to a teammate.",
  },
};

export function normalizeReplyTone(value: unknown): ReplyTone {
  return REPLY_TONES.includes(value as ReplyTone) ? (value as ReplyTone) : "MATCH_ME";
}

export function listReplyTonePolicies(): ReplyTonePolicy[] {
  return REPLY_TONES.map((tone) => REPLY_TONE_POLICIES[tone]);
}

const TONE_INSTRUCTIONS: Record<Exclude<ReplyTone, "MATCH_ME">, string> = {
  FORMAL:
    "Write formally: complete sentences, no slang or emoji, and the polite/honorific register if the reply language has one (e.g. Korean 존댓말, Japanese 敬語).",
  FRIENDLY:
    "Write in a warm but professional register: courteous, plain sentences, no slang or emoji.",
  CASUAL:
    "Write casually, the way you'd message a close colleague: short sentences, contractions, no stiff formalities. Still no slang the sender didn't use, and no emoji.",
};

/**
 * Prompt fragment for the user's chosen register, or "" for MATCH_ME.
 *
 * Callers append this AFTER the voice-profile hint so it is the last word on
 * register when the two disagree; the wording says so explicitly rather than
 * relying on position alone.
 */
export function buildReplyTonePromptHint(value: unknown): string {
  const tone = normalizeReplyTone(value);
  if (tone === "MATCH_ME") return "";
  return `[Reply tone — the user chose this explicitly; it overrides any inferred writing style above]\n${TONE_INSTRUCTIONS[tone]}`;
}

/**
 * Load the user's chosen register and render it as a prompt fragment.
 *
 * Returns "" for MATCH_ME, for a user with no config row yet, and on a read
 * failure. Degrading to "no explicit tone" is the safe direction: the reply
 * still gets drafted from the voice profile instead of the whole draft failing
 * over a preference lookup.
 */
export async function buildReplyToneHint(userId: string): Promise<string> {
  try {
    const config = await prisma.automationConfig.findUnique({
      where: { userId },
      select: { replyTone: true },
    });
    return buildReplyTonePromptHint(config?.replyTone);
  } catch (err) {
    console.warn("[TONE] buildReplyToneHint read failed:", err);
    return "";
  }
}
