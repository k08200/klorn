/**
 * Facts v1 extractor (docs/design/attention-engine-v3.md §3(1), phase P2).
 *
 * deterministic pre-facts → one LLM call (strict JSON schema; a forced tool on
 * native Anthropic) → parseFactsV1 → evidence check → date window → merge
 * (certain pre-facts win). An unusable answer degrades to keyword facts. A
 * budget refusal (daily cost cap, daily call cap) propagates so the caller can
 * stop: the call is background priority and never draws on the judge reserve.
 *
 * The result says whether the item must be escalated (doc §4): a dropped
 * evidence quote or due date, `ambiguous`, a malformed answer, or no answer.
 */

import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { parseLlmJson } from "../../llm/llm-json.js";
import { type CompletionOptions, createCompletion, JUDGE_MODEL } from "../../llm/openai.js";
import type { ProviderCredentials } from "../../providers/index.js";
import { type EvidenceCheck, verifyFactsEvidence } from "./evidence.js";
import { FACTS_TOOL_NAME, FACTS_V1_JSON_SCHEMA } from "./facts-json-schema.js";
import { enforceDateWindow, mergeWithPreFacts } from "./facts-merge.js";
import { buildFactsPrompt, type FactsPrompt, type FactsPromptInput } from "./facts-prompt.js";
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
  /** Validator issues and failure notes; no mail text. */
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

/** Transport attempts. A malformed answer is not retried: at temperature 0 it repeats. */
const FACTS_LLM_ATTEMPTS = 2;
/** Output budget: a full fact set is a few hundred tokens; leave headroom. */
const FACTS_MAX_TOKENS = 1500;
/** A longer answer is degenerate (and parseLlmJson is slow on huge whitespace runs). */
export const MAX_ANSWER_CHARS = 20_000;
const MAX_FAILURE_NOTE_CHARS = 160;

/** Errors that mean "stop spending for this user now", not "try again". */
const BUDGET_STOP_ERRORS = new Set(["DailyCostCapExceededError", "UserRateLimitedError"]);
/** Errors a second attempt cannot fix: the provider chain already failed over. */
const NO_RETRY_ERRORS = new Set(["AllProvidersExhaustedError"]);

export function factsModel(): string {
  return process.env.JUDGE_V3_FACTS_MODEL?.trim() || JUDGE_MODEL;
}

function failureNote(attempt: number, err: unknown): string {
  const name = err instanceof Error ? err.name : "Error";
  const message = err instanceof Error ? err.message : String(err);
  return `attempt ${attempt}: ${name}: ${message}`.slice(0, MAX_FAILURE_NOTE_CHARS);
}

interface ModelAnswer {
  raw: string;
  model: string | null;
  provider: string | null;
  byUserKey: boolean;
}

function requestParams(prompt: FactsPrompt, model: string): ChatCompletionCreateParamsNonStreaming {
  return {
    model,
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
  };
}

async function callModel(prompt: FactsPrompt, options: ExtractFactsOptions): Promise<ModelAnswer> {
  const complete = options.complete ?? (createCompletion as unknown as Complete);
  let served: { provider: string; model: string; ownedByUser: boolean } | undefined;
  const response = await complete(requestParams(prompt, options.model ?? factsModel()), {
    // Background, never the judge reserve: it stops at (cap - reserve) so
    // new-mail v2 judging keeps its slice. Background even without a userId,
    // so it always goes through the pacer.
    priority: "background",
    ...(options.userId ? { userId: options.userId } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
    onServed: (s) => {
      served = s;
    },
  });
  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("empty completion content");
  const s = served as { provider: string; model: string; ownedByUser: boolean } | undefined;
  return {
    raw,
    model: s?.model ?? response.model ?? null,
    provider: s?.provider ?? null,
    byUserKey: s?.ownedByUser ?? false,
  };
}

/** One answer, or null after the transport attempts. Budget stops propagate. */
async function fetchAnswer(
  prompt: FactsPrompt,
  options: ExtractFactsOptions,
  failures: string[],
): Promise<ModelAnswer | null> {
  for (let attempt = 1; attempt <= FACTS_LLM_ATTEMPTS; attempt++) {
    try {
      return await callModel(prompt, options);
    } catch (err) {
      if (err instanceof Error && BUDGET_STOP_ERRORS.has(err.name)) throw err;
      failures.push(failureNote(attempt, err));
      if (err instanceof Error && NO_RETRY_ERRORS.has(err.name)) return null;
    }
  }
  return null;
}

function parseAnswer(raw: string, failures: string[]): ReturnType<typeof parseFactsV1> | null {
  if (raw.length > MAX_ANSWER_CHARS) {
    failures.push(`answer too long (${raw.length} chars)`);
    return null;
  }
  let json: unknown;
  try {
    json = parseLlmJson(raw);
  } catch {
    failures.push("answer is not JSON");
    return null;
  }
  const parsed = parseFactsV1(json);
  if (!parsed.facts) {
    failures.push(parsed.issues.join("; ").slice(0, MAX_FAILURE_NOTE_CHARS));
    return null;
  }
  return parsed;
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

function finish(
  facts: FactsV1,
  answer: ModelAnswer,
  pre: PreFacts,
  issues: string[],
  check: EvidenceCheck,
): FactsExtraction {
  const escalateReasons: EscalateReason[] = [];
  if (issues.length > 0) escalateReasons.push("parse_issues");
  if (check.dropped.length > 0) escalateReasons.push("evidence_failed");
  if (facts.ambiguous) escalateReasons.push("ambiguous");
  return {
    facts,
    source: "llm",
    model: answer.model,
    provider: answer.provider,
    servedByUserKey: answer.byUserKey,
    issues,
    evidenceCheck: check,
    escalate: escalateReasons.length > 0,
    escalateReasons,
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
  const answer = await fetchAnswer(prompt, options, failures);
  const parsed = answer ? parseAnswer(answer.raw, failures) : null;
  if (!answer || !parsed?.facts) return fallback(input, pre, failures);

  const verified = verifyFactsEvidence(parsed.facts, prompt.haystack);
  const dated = enforceDateWindow(verified.facts, input.receivedAt);
  const facts = mergeWithPreFacts(dated.facts, pre);
  return finish(facts, answer, pre, [...parsed.issues, ...dated.issues], verified.check);
}
