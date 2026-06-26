import { asString, asUnitInterval } from "./llm-coerce.js";
import { parseLlmJson } from "./llm-json.js";
import { createCompletion, JUDGE_MODEL } from "./openai.js";
import type { ProviderCredentials } from "./providers/index.js";
import { captureError } from "./sentry.js";
import type { CandidateTrait } from "./sender-trait-policy.js";
import { TRAIT_KINDS, validateTraitValue } from "./sender-trait-policy.js";
import type { TraitSourceEmail } from "./sender-trait-signature.js";

interface RawTrait {
  value?: unknown;
  confidence?: unknown;
  evidence?: unknown;
}
type RawResponse = Partial<Record<string, RawTrait>>;

function buildPrompt(emails: TraitSourceEmail[]): string {
  const lines = emails.map(
    (e, i) => `${i}. from=${e.from} | subject=${e.subject} | ${e.snippet}`,
  );
  return `You profile an email SENDER from their recent messages. Return JSON only, shape:
{"relationship":{"value":"investor","confidence":0.0-1.0,"evidence":"short quote"},
 "recurring_intent":{"value":"billing","confidence":0.0-1.0,"evidence":"short quote"}}
relationship is one of: vendor, customer, investor, internal_colleague, recruiter, service_automated, personal, unknown.
recurring_intent is one of: billing, scheduling, newsletter, transactional_receipt, support, sales_outreach, personal_correspondence, none.
evidence MUST be a short verbatim quote from the emails. Omit a key if unsure.

Emails:
${lines.join("\n")}`;
}

/**
 * Extract validated sender traits from a sample of one sender's emails. Returns
 * only candidates whose value is in the taxonomy (hallucinations are dropped).
 * Never throws — an LLM/parse failure yields [] (the caller skips the sender).
 */
export async function extractTraitsFromEmails(
  emails: TraitSourceEmail[],
  opts: { userId?: string; credentials?: ProviderCredentials },
): Promise<CandidateTrait[]> {
  try {
    const response = await createCompletion(
      {
        model: JUDGE_MODEL,
        messages: [
          { role: "system", content: "You are a strict JSON sender profiler. JSON only, no fences." },
          { role: "user", content: buildPrompt(emails) },
        ],
        response_format: { type: "json_object" },
      },
      {
        ...(opts.userId ? { userId: opts.userId, priority: "background" as const } : {}),
        ...(opts.credentials ? { credentials: opts.credentials } : {}),
      },
    );
    const raw = response.choices[0]?.message?.content;
    if (!raw) return [];
    const parsed = parseLlmJson<RawResponse>(raw);

    const out: CandidateTrait[] = [];
    for (const kind of TRAIT_KINDS) {
      const entry = parsed[kind];
      if (!entry) continue;
      const value = validateTraitValue(kind, entry.value);
      const evidenceText = asString(entry.evidence);
      if (value === null || evidenceText === "") continue;
      out.push({
        factKind: kind,
        factValue: value,
        confidence: asUnitInterval(entry.confidence),
        evidenceText,
      });
    }
    return out;
  } catch (err) {
    console.warn("[TRAITS] extraction failed — skipping sender:", err instanceof Error ? err.message : String(err));
    captureError(err, { tags: { scope: "sender-traits.extract" } });
    return [];
  }
}
