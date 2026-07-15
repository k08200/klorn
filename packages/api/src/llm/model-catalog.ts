/**
 * The only models a user may select for the CHAT/ASSISTANT surface. Single
 * source of truth for the Settings picker and the PATCH whitelist.
 *
 * Frontier-only by design (founder decision 2026-07-04): users choose the
 * model that talks to them — that trust requires current frontier models, not
 * budget SKUs. Every id verified live on OpenRouter 2026-07-04 (public
 * /api/v1/models). Order matters: index 0 is the recommended default.
 *
 * Scope: this choice applies ONLY to conversational surfaces (agent
 * conversations / chat). The firewall judge, summaries, drafts, and vision
 * stay on their measured pins (JUDGE_MODEL etc.) — a user's chat preference
 * must never silently change classification quality.
 */
export interface CuratedModel {
  id: string;
  label: string;
  note: string;
}

export const CURATED_MODELS: ReadonlyArray<CuratedModel> = [
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    note: "Anthropic — recommended",
  },
  { id: "openai/gpt-5.4", label: "GPT-5.4", note: "OpenAI" },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash", note: "Google — fastest" },
  { id: "x-ai/grok-4.3", label: "Grok 4.3", note: "xAI" },
  {
    id: "anthropic/claude-opus-4.8",
    label: "Claude Opus 4.8",
    note: "Anthropic — most capable, pricier",
  },
] as const;

export const CURATED_MODEL_IDS: ReadonlyArray<string> = CURATED_MODELS.map((m) => m.id);

/** Recommended default for users who never picked (index 0 of the catalog). */
export const DEFAULT_CHAT_MODEL = CURATED_MODELS[0].id;

export function isCuratedModel(id: string | null | undefined): boolean {
  return typeof id === "string" && CURATED_MODEL_IDS.includes(id);
}
