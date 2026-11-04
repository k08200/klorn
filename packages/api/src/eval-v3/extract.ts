/**
 * One v3 fact-extraction call for the P1 benchmark: prompt → provider →
 * schema v1 parse → evidence check. Uses the production provider chain
 * (`createCompletion`), so a model runs exactly the way the judge would run
 * it (Haiku 5.5: forced tool; Sonnet/Opus/Fable: auto tool with thinking).
 *
 * Two attempts, like the v2 judge. A provider error on both attempts is an
 * instrument failure (the run is discarded); an answer that never parses is a
 * model failure (counted, routed to QUEUE).
 */
import type { ClassifiableEmail } from "../judge/email-classifier.js";
import { parseLlmJson } from "../llm/llm-json.js";
import { describeErrorChain } from "../llm/model-fallback.js";
import { createCompletion } from "../llm/openai.js";
import { applyEvidenceCheck } from "./evidence.js";
import {
  buildFactsUserPrompt,
  FACTS_JSON_SCHEMA,
  FACTS_SYSTEM_PROMPT,
  FACTS_TOOL_NAME,
  type FactsPrompt,
} from "./facts-prompt.js";
import { type FactsV1, parseFactsV1 } from "./facts-schema.js";

const ATTEMPTS = 2;
/** Schema v1 answers are ~100–400 tokens; thinking headroom is added by the adapter. */
const MAX_TOKENS = 1500;

export interface InterpretedFacts {
  /** Facts after evidence verification (failed asks dropped); null when unparseable. */
  facts: FactsV1 | null;
  /** Facts as the model returned them, before evidence verification. */
  rawFacts: FactsV1 | null;
  issues: string[];
  evidenceTotal: number;
  evidenceValid: number;
  /** Asks kept but with the due nulled: the quote states no deadline. */
  dueUnbound: number;
}

/** Pure: raw completion text → validated, evidence-checked facts. */
export function interpretFactsAnswer(content: string, fields: readonly string[]): InterpretedFacts {
  let raw: unknown;
  try {
    raw = parseLlmJson(content);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      facts: null,
      rawFacts: null,
      issues: [`not JSON: ${why}`],
      evidenceTotal: 0,
      evidenceValid: 0,
      dueUnbound: 0,
    };
  }
  const { facts, issues } = parseFactsV1(raw);
  if (!facts)
    return {
      facts: null,
      rawFacts: null,
      issues,
      evidenceTotal: 0,
      evidenceValid: 0,
      dueUnbound: 0,
    };
  const checked = applyEvidenceCheck(facts, fields);
  return {
    facts: checked.facts,
    rawFacts: facts,
    issues,
    evidenceTotal: checked.evidenceTotal,
    evidenceValid: checked.evidenceValid,
    dueUnbound: checked.dueUnbound,
  };
}

export interface FactsExtraction extends InterpretedFacts {
  attempts: number;
  /** Both attempts threw: the provider, not the model, failed. */
  providerFailed: boolean;
  error?: string;
}

const NO_FACTS = { facts: null, rawFacts: null, evidenceTotal: 0, evidenceValid: 0, dueUnbound: 0 };

/** One provider call. A thrown error is a provider failure; an unusable answer is a model failure. */
async function attemptFacts(
  model: string,
  prompt: FactsPrompt,
  attempt: number,
): Promise<FactsExtraction> {
  try {
    const response = await createCompletion({
      model,
      messages: [
        { role: "system", content: FACTS_SYSTEM_PROMPT },
        { role: "user", content: prompt.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: FACTS_TOOL_NAME, schema: FACTS_JSON_SCHEMA },
      },
      // Parity with the v2 judge; the Anthropic adapter drops it for the 5.5 family.
      temperature: 0,
      max_tokens: MAX_TOKENS,
    });
    const content = response.choices[0]?.message?.content ?? "";
    return {
      ...interpretFactsAnswer(content, prompt.fields),
      attempts: attempt,
      providerFailed: false,
    };
  } catch (err) {
    const error = describeErrorChain(err);
    console.warn(`[V3-FACTS] attempt ${attempt}/${ATTEMPTS} failed: ${error}`);
    return { ...NO_FACTS, issues: [], attempts: attempt, providerFailed: true, error };
  }
}

export async function extractFacts(
  email: ClassifiableEmail & { receivedAt: string },
  model: string,
  includeBody: boolean,
): Promise<FactsExtraction> {
  const prompt = buildFactsUserPrompt(email, includeBody);
  let last: FactsExtraction = {
    ...NO_FACTS,
    issues: ["no attempt ran"],
    attempts: 0,
    providerFailed: true,
  };
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    last = await attemptFacts(model, prompt, attempt);
    if (last.facts) return last;
  }
  return last;
}
