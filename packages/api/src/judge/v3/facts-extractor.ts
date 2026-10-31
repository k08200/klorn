/**
 * Facts v1 extractor (docs/design/attention-engine-v3.md §3(1), phase P2).
 *
 * deterministic pre-facts → one LLM call (strict JSON schema; a forced tool on
 * native Anthropic) → parseFactsV1 → evidence check → date window → merge
 * (certain pre-facts win). An unusable answer degrades to keyword facts; a
 * cost-cap refusal propagates so the caller can stop (the shadow never draws
 * on the judge reserve).
 *
 * The result says whether the item must be escalated (doc §4): a dropped
 * evidence quote, `ambiguous`, a malformed answer, or no LLM answer at all.
 */

import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { parseLlmJson } from "../../llm/llm-json.js";
import { type CompletionOptions, createCompletion, JUDGE_MODEL } from "../../llm/openai.js";
import type { ProviderCredentials } from "../../providers/index.js";
import { type EvidenceCheck, verifyFactsEvidence } from "./evidence.js";
import { FACTS_TOOL_NAME, FACTS_V1_JSON_SCHEMA } from "./facts-json-schema.js";
import { buildFactsPrompt, type FactsPromptInput } from "./facts-prompt.js";
import { type FactsV1, parseFactsV1 } from "./facts-schema.js";
import { keywordFallbackFacts } from "./keyword-facts.js";
import { deterministicPreFacts, type PreFacts } from "./pre-facts.js";

export type FactsMailInput = FactsPromptInput;

export type EscalateReason = "llm_failed" | "parse_issues" | "evidence_failed" | "ambiguous";

export interface FactsExtraction {
  facts: FactsV1;
  source: "llm" | "keyword-fallback";
  /** Model that served the answer (null for keyword facts). */
  model: string | null;
  /** Provider that served it, from createCompletion's onServed (null if unknown). */
  provider: string | null;
  /** The user's own (BYOK) key served the call. */
  servedByUserKey: boolean;
  issues: string[];
  evidenceCheck: EvidenceCheck;
  escalate: boolean;
  escalateReasons: EscalateReason[];
  /** Fields fixed by deterministic pre-facts. */
  certain: PreFacts["certain"];
}

type Complete = (
  params: ChatCompletionCreateParamsNonStreaming,
  options: CompletionOptions,
) => Promise<{ model?: string; choices: Array<{ message?: { content?: string | null } }> }>;

export interface ExtractFactsOptions {
  userId?: string;
  credentials?: ProviderCredentials;
  model?: string;
  /** Injected for tests; defaults to createCompletion. */
  complete?: Complete;
}

/** One retry: a single transient provider failure should not cost the facts. */
const FACTS_LLM_ATTEMPTS = 2;
/** Output budget: a full fact set is a few hundred tokens; leave headroom. */
const FACTS_MAX_TOKENS = 1500;
const DAY_MS = 86_400_000;
/** A due date this far before the mail is not a reading of this mail. */
const DUE_WINDOW_PAST_DAYS = 60;
/** …nor one more than this far after it. */
const DUE_WINDOW_FUTURE_DAYS = 400;

export function factsModel(): string {
  return process.env.JUDGE_V3_FACTS_MODEL?.trim() || JUDGE_MODEL;
}

function isCostCapError(err: unknown): boolean {
  return err instanceof Error && err.name === "DailyCostCapExceededError";
}

function withinWindow(iso: string, mailDate: Date): boolean {
  const t = Date.parse(iso);
  const m = mailDate.getTime();
  return t >= m - DUE_WINDOW_PAST_DAYS * DAY_MS && t <= m + DUE_WINDOW_FUTURE_DAYS * DAY_MS;
}

/** Drop dates that cannot be a reading of this mail. Returns new objects. */
export function enforceDateWindow(
  facts: FactsV1,
  mailDate: Date,
): { facts: FactsV1; issues: string[] } {
  const issues: string[] = [];
  const asks = facts.asks.map((a, i) => {
    if (a.due === null || withinWindow(a.due, mailDate)) return { ...a };
    issues.push(`asks[${i}].due: outside the plausible window of the mail date`);
    return { ...a, due: null };
  });
  const event = facts.event
    ? {
        ...facts.event,
        proposedTimes: facts.event.proposedTimes.filter((t, i) => {
          if (withinWindow(t, mailDate)) return true;
          issues.push(`event.proposedTimes[${i}]: outside the plausible window of the mail date`);
          return false;
        }),
      }
    : null;
  return { facts: { ...facts, asks, event, risk: [...facts.risk] }, issues };
}

/**
 * Certain pre-facts replace the model's value. The event keeps the model's
 * proposed times when an invite fixes hasInvite; conflict is always null here
 * because it comes from the calendar read, not from the mail text.
 */
export function mergeWithPreFacts(llm: FactsV1, pre: PreFacts): FactsV1 {
  const merged: FactsV1 = { ...llm, asks: llm.asks.map((a) => ({ ...a })), risk: [...llm.risk] };
  for (const field of pre.certain) {
    if (field === "event") continue;
    Object.assign(merged, { [field]: pre.facts[field] });
  }
  const preEvent = pre.certain.includes("event") ? pre.facts.event : undefined;
  const base = preEvent ?? llm.event;
  merged.event = base
    ? {
        proposedTimes: [...(llm.event?.proposedTimes ?? base.proposedTimes)],
        hasInvite: preEvent ? preEvent.hasInvite : base.hasInvite,
        conflict: null,
      }
    : null;
  return merged;
}

async function callModel(
  prompt: ReturnType<typeof buildFactsPrompt>,
  options: ExtractFactsOptions,
): Promise<{ raw: string; model: string | null; provider: string | null; byUserKey: boolean }> {
  const complete = options.complete ?? (createCompletion as unknown as Complete);
  let served: { provider: string; model: string; ownedByUser: boolean } | null = null;
  const response = await complete(
    {
      model: options.model ?? factsModel(),
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: FACTS_TOOL_NAME,
          schema: FACTS_V1_JSON_SCHEMA as unknown as Record<string, unknown>,
          strict: true,
        },
      },
      temperature: 0,
      max_tokens: FACTS_MAX_TOKENS,
    },
    {
      // Background work, never the judge reserve: it stops at (cap - reserve)
      // so new-mail v2 judging keeps its slice.
      ...(options.userId ? { userId: options.userId, priority: "background" as const } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
      onServed: (s) => {
        served = s;
      },
    },
  );
  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("empty completion content");
  const s = served as { provider: string; model: string; ownedByUser: boolean } | null;
  return {
    raw,
    model: s?.model ?? response.model ?? null,
    provider: s?.provider ?? null,
    byUserKey: s?.ownedByUser ?? false,
  };
}

function fallback(input: FactsMailInput, pre: PreFacts, issues: string[]): FactsExtraction {
  return {
    facts: keywordFallbackFacts(input, pre),
    source: "keyword-fallback",
    model: null,
    provider: null,
    servedByUserKey: false,
    issues,
    evidenceCheck: { checked: 0, dropped: [] },
    escalate: true,
    escalateReasons: ["llm_failed"],
    certain: pre.certain,
  };
}

export async function extractFacts(
  input: FactsMailInput,
  options: ExtractFactsOptions = {},
): Promise<FactsExtraction> {
  const pre = deterministicPreFacts(input);
  const prompt = buildFactsPrompt(input, pre);
  const failures: string[] = [];

  for (let attempt = 1; attempt <= FACTS_LLM_ATTEMPTS; attempt++) {
    let answer: Awaited<ReturnType<typeof callModel>>;
    try {
      answer = await callModel(prompt, options);
    } catch (err) {
      if (isCostCapError(err)) throw err;
      failures.push(`attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    let rawJson: unknown;
    try {
      rawJson = parseLlmJson(answer.raw);
    } catch {
      failures.push(`attempt ${attempt}: answer is not JSON`);
      continue;
    }
    const parsed = parseFactsV1(rawJson);
    if (!parsed.facts) {
      failures.push(`attempt ${attempt}: ${parsed.issues.join("; ")}`);
      continue;
    }

    const verified = verifyFactsEvidence(parsed.facts, prompt.haystack);
    const dated = enforceDateWindow(verified.facts, input.receivedAt);
    const facts = mergeWithPreFacts(dated.facts, pre);
    const issues = [...parsed.issues, ...dated.issues];
    const escalateReasons: EscalateReason[] = [];
    if (issues.length > 0) escalateReasons.push("parse_issues");
    if (verified.check.dropped.length > 0) escalateReasons.push("evidence_failed");
    if (facts.ambiguous) escalateReasons.push("ambiguous");
    return {
      facts,
      source: "llm",
      model: answer.model,
      provider: answer.provider,
      servedByUserKey: answer.byUserKey,
      issues,
      evidenceCheck: verified.check,
      escalate: escalateReasons.length > 0,
      escalateReasons,
      certain: pre.certain,
    };
  }
  return fallback(input, pre, failures);
}
