/**
 * The only models a user may select. Single source of truth for the UI list
 * and the PATCH whitelist. Every entry is verified live on OpenRouter, is
 * multimodal (vision-safe), and clears the firewall gates (PUSH recall >= 90%,
 * SILENT precision >= 90%) — so no selectable model can silently degrade the
 * firewall. Order matters: index 0 is the recommended default shown first.
 */
export interface CuratedModel {
  id: string;
  label: string;
  note: string;
}

export const CURATED_MODELS: ReadonlyArray<CuratedModel> = [
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "Fast + cheap (recommended)" },
  { id: "openai/gpt-4o", label: "GPT-4o", note: "OpenAI" },
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", note: "Anthropic" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", note: "Google, stronger/pricier" },
] as const;

export const CURATED_MODEL_IDS: ReadonlyArray<string> = CURATED_MODELS.map((m) => m.id);

export function isCuratedModel(id: string | null | undefined): boolean {
  return typeof id === "string" && CURATED_MODEL_IDS.includes(id);
}
