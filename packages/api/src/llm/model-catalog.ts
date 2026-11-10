/**
 * The only models a user may select for the CHAT/ASSISTANT surface. Single
 * source of truth for the Settings picker and the PATCH whitelist.
 *
 * Claude-only, native Anthropic ids (founder decision 2026-11-01: Klorn runs
 * on the Claude API only). A non-Claude id here would be silently served as
 * the provider's default Claude model, so the picker would lie about what
 * answers. Every id is listed by Anthropic's GET /v1/models (2026-11-01) and
 * priced in MODEL_RATES (model-fallback.ts). Order matters: index 0 is the
 * recommended default.
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
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Anthropic — fastest" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", note: "Anthropic — balanced" },
  {
    id: "claude-opus-4-8",
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
