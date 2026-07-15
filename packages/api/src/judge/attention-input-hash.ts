/**
 * Content-addressed classification — hash the decision-relevant input bytes
 * at classify time, store the hash with the AttentionItem, re-hash on read
 * and fail loud on mismatch. Closes the silent-re-invocation hole that
 * PR #454's read-path invariant test left open.
 *
 * The threat model (from a dev.to thread on the firewall classifier, 2026-06-01):
 *
 *   > The silent re-invocation problem is the right one to be worried
 *   > about. The shape that scares me most is when enrichment gets added
 *   > 6 months later by someone who doesn't know the original gate exists.
 *   > PR review catches "is this calling the scorer" but not "is this
 *   > implicitly triggering a re-classification of something already
 *   > trusted." What helps is making the classifier read-only against a
 *   > versioned snapshot of the input. Once a signature is classified at
 *   > v1 of the input bytes, the result is keyed against the input hash.
 *   > Any enrichment that mutates the input invalidates the classification
 *   > and forces a re-decision. Mutating without invalidating is a type
 *   > error.
 *
 * What this module guarantees:
 *
 *   1. The hash function is stable — same input bytes always produce the
 *      same hash, regardless of field iteration order, missing optional
 *      fields, or whitespace in serialization. JSON.stringify with sorted
 *      keys gives us this without a 3rd-party canonicalizer.
 *
 *   2. The hash function is sensitive — any change to a classification-
 *      relevant field (from, subject, snippet, labels) produces a different
 *      hash. Unit-tested with one-character mutations on each field.
 *
 *   3. Verification fails loud on mismatch. Production code can opt to log
 *      + re-decide instead of throwing, but the helper itself throws so
 *      the default path is the safe one.
 *
 * What this module does NOT do:
 *
 *   - It does not store anything. attention-mirror.ts is the write site.
 *   - It does not trigger re-classification on mismatch. That's a caller
 *     decision (refire judgeEmail, or just refuse to serve the cached tier).
 *   - It does not cover MEDIUM/HIGH-risk action payloads. PendingAction
 *     bodies have their own integrity story (toolArgs JSONB + an explicit
 *     /approve transition), separate from this read-path hash.
 *
 * Why sha256:
 *   - Collision risk is irrelevant for a single-user-keyed lookup (we never
 *     compare hashes across users), but treating the hash as opaque means
 *     we can swap algorithms behind the helper without callers caring.
 *   - 64-char hex stores neatly in a TEXT column and grep-greps easily.
 */

import crypto from "node:crypto";

/**
 * The exact field set that participates in the classification decision.
 * Adding a new field to the classifier MUST add it here too; missing
 * fields invalidate the integrity guarantee silently (a mutation to an
 * un-hashed field would slip past verifyAttentionInputHash).
 *
 * If you ever change this shape, bump HASH_SCHEMA_VERSION so old rows
 * deliberately fail verification and force a clean re-decision.
 */
export interface AttentionHashInput {
  from: string;
  subject: string;
  snippet: string | null;
  labels: string[];
}

/**
 * Bumped any time the hash input shape OR the hash algorithm changes.
 * Old rows are still findable by their stored hash but won't match the
 * new function, which is the correct behaviour — they need re-decision
 * under the new policy.
 */
export const HASH_SCHEMA_VERSION = "v1" as const;

/**
 * Produce a stable, sensitive 64-char hex digest of the inputs that
 * determined a classification. Same input bytes → same hash, regardless
 * of field iteration order or label list order.
 *
 *   - Labels are sorted so reordering on Gmail's side doesn't invalidate.
 *   - Strings are NFC-normalized so visually identical Unicode (composed
 *     vs decomposed Korean syllables) hashes the same.
 *   - The schema version is prefixed so a future shape change forces
 *     all existing rows to fail verification at the same moment.
 */
export function computeAttentionInputHash(input: AttentionHashInput): string {
  const canonical = {
    v: HASH_SCHEMA_VERSION,
    from: (input.from ?? "").normalize("NFC"),
    subject: (input.subject ?? "").normalize("NFC"),
    snippet: input.snippet == null ? null : input.snippet.normalize("NFC"),
    labels: [...input.labels].sort(),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export class AttentionHashMismatchError extends Error {
  constructor(
    public readonly storedHash: string,
    public readonly currentHash: string,
  ) {
    super(
      `invariant violated: classification input mutated post-decision (stored=${storedHash.slice(
        0,
        12,
      )}… current=${currentHash.slice(0, 12)}…)`,
    );
    this.name = "AttentionHashMismatchError";
  }
}

/**
 * Throw on mismatch. Use this when the caller wants the failure mode that
 * caused the original incident — silent re-invocation — to surface as a
 * loud invariant violation.
 *
 * Returns the current hash on success so callers can keep using it without
 * recomputing.
 */
export function verifyAttentionInputHash(
  storedHash: string | null | undefined,
  currentInput: AttentionHashInput,
): string {
  const currentHash = computeAttentionInputHash(currentInput);
  // A null stored hash means this row predates the doctrine. Treat as
  // "skip the integrity check" — the alternative would be to break the
  // firewall for every legacy item until they're all re-classified.
  if (!storedHash) return currentHash;
  if (storedHash !== currentHash) {
    throw new AttentionHashMismatchError(storedHash, currentHash);
  }
  return currentHash;
}

/**
 * Soft variant — log + return false on mismatch instead of throwing. Use
 * at read sites where breaking the request would be worse than serving a
 * stale tier (the firewall page is the obvious case). Pair with a
 * background re-classify trigger when you care about the row.
 */
export function checkAttentionInputHash(
  storedHash: string | null | undefined,
  currentInput: AttentionHashInput,
): { ok: true; currentHash: string } | { ok: false; storedHash: string; currentHash: string } {
  const currentHash = computeAttentionInputHash(currentInput);
  if (!storedHash) return { ok: true, currentHash };
  if (storedHash !== currentHash) {
    return { ok: false, storedHash, currentHash };
  }
  return { ok: true, currentHash };
}
