/**
 * Generating the day's briefing text: one model call over the gathered data,
 * checked against the mail it may pick from, with a rule-based view when the
 * model is unavailable or unusable. Split from briefing.ts, which re-exports
 * the public surface.
 */

import { describeLlmFailure } from "../llm/describe-failure.js";
import { getUserLlmCredentials } from "../llm/llm-credentials.js";
import { parseLlmJson } from "../llm/llm-json.js";
import { createCompletion, MODEL } from "../llm/openai.js";
import { logLlmFailure } from "../llm/report-llm-failure.js";
import { stripUntrusted } from "../untrusted.js";
import { type BriefingCopy, briefingCopy } from "./briefing-copy.js";
import {
  buildPrompt,
  buildQuietBriefing,
  gatherBriefingData,
  quietMorningKind,
  userBriefingContext,
} from "./briefing-gather.js";
import {
  BRIEFING_ANSWER_SCHEMA,
  type BriefingPick,
  type PickableMail,
  parseBriefingAnswer,
  renderBriefingAnswer,
} from "./briefing-picks.js";
import { BRIEFING_SYSTEM_PROMPT } from "./briefing-prompt.js";
import type { BriefingSignals } from "./briefing-signals.js";

/** Output cap for the briefing call: the JSON answer is ~400 tokens. */
const BRIEFING_MAX_TOKENS = 1500;

/**
 * Outcome of the briefing's LLM path, surfaced by POST /generate so "AI
 * summary unavailable" is diagnosable in prod (which branch fired, and why).
 * Threaded through return values — request-scoped, never shared module state
 * (a singleton here leaks one user's diagnostic metadata to another).
 * "skipped": a quiet morning, delivered without a model call.
 */
export interface BriefingLlmOutcome {
  source: "ai" | "fallback" | "cache" | "skipped";
  reason: string | null;
  model: string;
}

export interface GeneratedBriefing {
  content: string;
  llm: BriefingLlmOutcome;
  /** Verified picks (empty for the quiet card and for every fallback). */
  picks: BriefingPick[];
  /** A quiet card: saved, but announced without a device push. */
  quiet: boolean;
}

/** The model's answer as briefing text: the checked JSON, else legacy prose, else null. */
function readModelAnswer(
  raw: string,
  refs: ReadonlyMap<string, PickableMail>,
  copy: BriefingCopy,
): { content: string; picks: BriefingPick[] } | null {
  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch {
    // A provider that ignored response_format and wrote prose: keep it (clean).
    // Broken JSON (cut off, or fenced and cut off) is not prose: fall back.
    return /^\s*(?:\{|```)/.test(raw) ? null : { content: stripUntrusted(raw), picks: [] };
  }
  const answer = parseBriefingAnswer(parsed, refs);
  return answer ? { content: renderBriefingAnswer(answer, copy), picks: answer.picks } : null;
}

export default async function generateBriefing(
  userId: string,
  now: Date = new Date(),
): Promise<GeneratedBriefing> {
  const ctx = await userBriefingContext(userId, now);
  const data = await gatherBriefingData(userId, ctx.todayKey, now);
  const copy = briefingCopy(ctx.lang);

  const quietKind = quietMorningKind(data);
  if (quietKind) {
    return {
      content: buildQuietBriefing(data.openPush, ctx.lang, quietKind),
      llm: { source: "skipped", reason: `quiet morning (${quietKind})`, model: "" },
      picks: [],
      quiet: true,
    };
  }

  const fallback = (reason: string): GeneratedBriefing => ({
    content: buildSignalOnlyBriefing(data.signals),
    llm: { source: "fallback", reason, model: MODEL },
    picks: [],
    quiet: false,
  });
  const { prompt, refs } = buildPrompt(data, ctx, now);
  const credentials = await getUserLlmCredentials(userId);
  try {
    const response = await createCompletion(
      {
        model: MODEL,
        // The answer is ~400 tokens of JSON; the cap bounds what reaches the
        // server-side checks if a mail steers the model into rambling.
        max_tokens: BRIEFING_MAX_TOKENS,
        response_format: {
          type: "json_schema",
          json_schema: { name: "briefing", schema: BRIEFING_ANSWER_SCHEMA },
        },
        messages: [
          { role: "system", content: BRIEFING_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      },
      // The usage-ledger feature this call carried while it lived in
      // pim/briefing.ts: llm-caller.ts reads it from the call site's path,
      // and the briefing's cost series must not change name with the file.
      { credentials, userId, priority: "background", feature: "pim/briefing" },
    );

    const raw = response.choices[0]?.message?.content?.trim();
    const answer = raw ? readModelAnswer(raw, refs, copy) : null;
    if (answer) {
      return { ...answer, llm: { source: "ai", reason: null, model: MODEL }, quiet: false };
    }
    const finish = response.choices[0]?.finish_reason ?? "none";
    console.warn(`[BRIEFING] LLM answer unusable for ${userId} — falling back to rule-based view`);
    return fallback(raw ? "unusable answer" : `empty content (finish_reason=${finish})`);
  } catch (err) {
    // LLM provider exhausted, rate-limited, or otherwise unreachable.
    // Fall back to the deterministic signal summary so the user still
    // gets a useful briefing instead of an error or empty screen.
    // Log the reason — without it, "AI summary unavailable" is invisible
    // in prod and the user has no idea whether the issue is credentials,
    // the cost cap, or a transient provider outage. Facts only, in the log
    // and in the reason: the provider's error can quote the briefing's mail.
    logLlmFailure("[BRIEFING] LLM call failed — falling back to rule-based view", err, {
      ids: { userId },
    });
    return fallback(describeLlmFailure(err));
  }
}

/**
 * Render BriefingSignals (already rule-based — see briefing-signals.ts) as a
 * human-readable briefing without any LLM call. Used when every provider is
 * locked out so the briefing page never goes blank.
 */
export const FALLBACK_BRIEFING_SENTINEL = "**Briefing (AI summary unavailable — rule-based view)**";

export function buildSignalOnlyBriefing(signals: BriefingSignals): string {
  const lines: string[] = [FALLBACK_BRIEFING_SENTINEL, ""];

  const topActions = signals.topActions.slice(0, 3);
  if (topActions.length > 0) {
    lines.push("**Top 3 Today**");
    topActions.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.action} — ${a.reason}`);
    });
    lines.push("");
  }

  if (signals.deadlines.length > 0) {
    lines.push("**Deadlines**");
    const seen = new Set<string>();
    let printed = 0;
    for (const d of signals.deadlines) {
      const key = `${d.source}:${d.title.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const due = d.dueText || d.dueAt || "soon";
      lines.push(`- ${d.title} (${due}) — ${d.reason}`);
      printed += 1;
      if (printed === 5) break;
    }
    lines.push("");
  }

  if (signals.urgentItems.length > 0) {
    lines.push("**Urgent**");
    const seen = new Set<string>();
    let printed = 0;
    for (const u of signals.urgentItems) {
      const key = `${u.source}:${u.title.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${u.title} — ${u.reason}`);
      printed += 1;
      if (printed === 5) break;
    }
    lines.push("");
  }

  if (signals.crossLinks.length > 0) {
    lines.push("**Connected items**");
    for (const link of signals.crossLinks.slice(0, 3)) {
      lines.push(`- ${link.reason}`);
    }
    lines.push("");
  }

  if (
    topActions.length === 0 &&
    signals.deadlines.length === 0 &&
    signals.urgentItems.length === 0
  ) {
    lines.push("Nothing urgent surfaced from today's data. Use the open block to plan ahead.");
  }

  return lines.join("\n").trim();
}
