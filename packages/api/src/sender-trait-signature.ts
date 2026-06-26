import { createHash } from "node:crypto";

/** The decision-relevant bytes of one source email (mirrors attention-input-hash). */
export interface TraitSourceEmail {
  from: string;
  subject: string;
  snippet: string;
  labels: string[];
}

export const TRAIT_SIG_VERSION = "v1";

/**
 * SHA-256 over a canonical, order-stable JSON of the sampled emails. An
 * unchanged signature means the sender's evidence set is unchanged, so
 * re-extraction can be skipped (idempotent, cost-saving) — the AutoBE
 * decision-ledger staleness pattern, applied per sender.
 */
export function computeTraitSourceSig(emails: TraitSourceEmail[]): string {
  const canonical = emails.map((e) => ({
    from: e.from.trim().toLowerCase(),
    subject: e.subject.normalize("NFC"),
    snippet: e.snippet.normalize("NFC"),
    labels: [...e.labels].sort(),
  }));
  return createHash("sha256")
    .update(`${TRAIT_SIG_VERSION}:${JSON.stringify(canonical)}`)
    .digest("hex");
}
