/**
 * Text embeddings — provider-agnostic, flag-gated, free-by-default.
 *
 * Klorn's judge grounds itself in the user's own past decisions. Today that
 * retrieval is lexical (same-sender / same-domain / recency in judge-context.ts).
 * Embeddings let it become semantic: "emails LIKE this one, however worded."
 * (kNN-retrieved demonstrations — Liu et al. 2022; kNN-LM — Khandelwal 2020.)
 *
 * Provider-agnostic on purpose (BYOK, same as the judge): it speaks the OpenAI
 * embeddings API, which local Ollama / LM Studio / vLLM, OpenAI, and Gemini's
 * compat endpoint all implement. Default target is a LOCAL Ollama
 * (nomic-embed-text) so semantic retrieval costs $0 and needs no vendor key —
 * matching the self-host / OSS posture.
 *
 * OFF by default: with EMBEDDING_MODEL unset every function is inert and callers
 * fall back to lexical retrieval, so the CI eval gate (no embeddings) and
 * production are byte-identical until an operator opts in.
 */

import OpenAI from "openai";

// Enable by setting EMBEDDING_MODEL (e.g. "nomic-embed-text" for local Ollama).
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "";
// Default to a local Ollama OpenAI-compat server — free, no key, self-hostable.
const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL || "http://localhost:11434/v1";
// Ollama ignores the key; a non-empty placeholder keeps the SDK from throwing.
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || "ollama";

/** Cap the in-process text→vector cache so repeated corrections aren't re-embedded. */
const CACHE_MAX = 2000;

/** True when an embedding model is configured; otherwise every call is inert. */
export function isEmbeddingEnabled(): boolean {
  return EMBEDDING_MODEL.length > 0;
}

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!isEmbeddingEnabled()) return null;
  if (!client) client = new OpenAI({ baseURL: EMBEDDING_BASE_URL, apiKey: EMBEDDING_API_KEY });
  return client;
}

// Bounded FIFO cache. Insertion order == eviction order (Map preserves it).
const cache = new Map<string, number[]>();
function cacheGet(text: string): number[] | undefined {
  return cache.get(text);
}
function cacheSet(text: string, vec: number[]): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(text, vec);
}

/**
 * Embed a batch of texts. Returns one vector per input, or null in that slot on
 * any failure — never throws, so a retrieval caller degrades to lexical rather
 * than failing the classification. Cached slots skip the network entirely; only
 * cache-misses are sent to the provider.
 */
export async function embedTexts(texts: readonly string[]): Promise<(number[] | null)[]> {
  const c = getClient();
  if (!c || texts.length === 0) return texts.map(() => null);

  const out: (number[] | null)[] = new Array(texts.length).fill(null);
  const missIdx: number[] = [];
  const missText: string[] = [];
  texts.forEach((t, i) => {
    const hit = cacheGet(t);
    if (hit) out[i] = hit;
    else {
      missIdx.push(i);
      missText.push(t);
    }
  });
  if (missText.length === 0) return out;

  try {
    const res = await c.embeddings.create({ model: EMBEDDING_MODEL, input: missText as string[] });
    res.data.forEach((d, j) => {
      const vec = d.embedding as number[];
      const i = missIdx[j];
      out[i] = vec;
      cacheSet(missText[j], vec);
    });
  } catch (err) {
    // Log a signal (invisible via captureError alone when Sentry is off) and
    // leave the missing slots null — caller falls back to lexical ranking.
    console.warn(
      "[embedding] embedTexts failed, falling back to lexical:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return out;
}

/** Embed a single text, or null on failure / when disabled. */
export async function embedText(text: string): Promise<number[] | null> {
  return (await embedTexts([text]))[0] ?? null;
}

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1]. Returns 0 for a
 * length mismatch or a zero-magnitude vector (no signal), never NaN. Pure.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Rank candidates by cosine similarity to the query vector, descending, and
 * return the top-k original indices. Candidates with a null vector are skipped.
 * Pure — no embedding calls here.
 */
export function rankBySimilarity(
  query: readonly number[],
  candidates: ReadonlyArray<number[] | null>,
  k: number,
): number[] {
  const scored = candidates
    .map((vec, index) => (vec ? { index, score: cosineSimilarity(query, vec) } : null))
    .filter((s): s is { index: number; score: number } => s !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, Math.max(0, k)).map((s) => s.index);
}
