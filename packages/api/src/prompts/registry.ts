/**
 * Prompt registry.
 *
 * All LLM system prompts and user-facing templates live here as versioned
 * strings. The point of a registry — instead of inline string literals —
 * is to make every prompt:
 *   1. Discoverable (one grep finds them all).
 *   2. Versionable (each prompt has an explicit `version`; A/B routing can
 *      pick a different version at runtime without a code deploy).
 *   3. Testable (snapshot tests can pin the active prompt body).
 *
 * Adding a new prompt:
 *   - Pick a stable kebab-case `id` (e.g. `email-classifier-batch`).
 *   - Bump `version` whenever the body changes meaningfully.
 *   - Optionally read `PROMPT_VERSIONS` env var (JSON `{ "id": "vN" }`)
 *     to route a subset of users to a different version for evaluation.
 *
 * This file does NOT pull prompts from a database yet — that's the next
 * step. For now it's a typed in-memory registry that already makes
 * versioning, testing, and centralized access possible.
 */

export interface PromptDefinition {
  id: string;
  version: string;
  body: string;
  /** Short human-readable purpose, surfaced in audit tooling. */
  purpose: string;
}

const PROMPTS: PromptDefinition[] = [];

export function registerPrompt(def: PromptDefinition): PromptDefinition {
  const existing = PROMPTS.find((p) => p.id === def.id && p.version === def.version);
  if (existing) {
    throw new Error(`Duplicate prompt ${def.id}@${def.version}`);
  }
  PROMPTS.push(def);
  return def;
}

let overrides: Record<string, string> | null = null;
function loadOverrides(): Record<string, string> {
  if (overrides) return overrides;
  const raw = process.env.PROMPT_VERSIONS;
  if (!raw) {
    overrides = {};
    return overrides;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    overrides = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    overrides = {};
  }
  return overrides;
}

/**
 * Resolve a prompt body by id. If PROMPT_VERSIONS env routes a specific
 * version, that version is returned; otherwise the first registered
 * version of that id wins.
 */
export function getPrompt(id: string): PromptDefinition {
  const requestedVersion = loadOverrides()[id];
  if (requestedVersion) {
    const exact = PROMPTS.find((p) => p.id === id && p.version === requestedVersion);
    if (exact) return exact;
    // Fall through to default if the requested version isn't registered;
    // we never want a typo in env to break agent operation.
  }
  const fallback = PROMPTS.find((p) => p.id === id);
  if (!fallback) {
    throw new Error(`Unknown prompt id: ${id}`);
  }
  return fallback;
}

export function listPrompts(): readonly PromptDefinition[] {
  return PROMPTS;
}
