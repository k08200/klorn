/**
 * Retro-cleanup classifier for ledger rows mined BEFORE the 2026-07-22
 * commitment-quality fixes (automated-sender gate, policy-notice filter,
 * sender-perspective owner attribution).
 *
 * The contract: mirror the CURRENT ingestion pipeline exactly. A row is
 * deleted iff today's pipeline would not have created it from the same source
 * email, re-attributed iff today's pipeline would have created it with a
 * different owner, kept otherwise. No extra heuristics — cleanup and pipeline
 * must never disagree, or the cleanup itself becomes a second policy surface.
 *
 * Pure decision logic only; the DB walk lives in
 * scripts/cleanup-commitment-noise.ts. One retro gap by construction: the
 * List-Unsubscribe header is not persisted on EmailMessage, so bulk mail from
 * an otherwise human-looking sender cannot be retro-detected — those rows
 * survive unless another gate catches them.
 */

import type { CommitmentOwner } from "@prisma/client";
import { isAutomatedSender, isClearMarketing } from "../judge/keyword-policy.js";
import { extractEmailAddress } from "../mail/email-address.js";
import { type CommitmentCandidate, extractCommitmentCandidates } from "./commitment-extractor.js";

// Mirrors the ingestion default (extractAndUpsertCommitmentsFromText).
const MAX_CANDIDATES = 5;

export interface MinedCommitmentRow {
  id: string;
  owner: CommitmentOwner;
  evidenceText: string | null;
  confidence: number;
}

export interface SourceEmailRow {
  from: string; // raw From header ("Name <addr>")
  fromAddress: string | null; // normalized lowercase address column
  subject: string;
  body: string | null;
  snippet: string | null;
  labels: string[];
}

export type CleanupDecision =
  | { action: "delete"; reason: string }
  | {
      action: "reattribute";
      reason: string;
      owner: "COUNTERPARTY";
      counterpartyEmail: string | null;
    }
  | { action: "keep"; reason: string };

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/…$/, "").trim();
}

/**
 * Evidence was stored as the whitespace-compacted candidate text (possibly
 * ellipsis-truncated), so "same sentence" means mutual-prefix after
 * normalization, not strict equality.
 */
function matchesEvidence(candidate: CommitmentCandidate, evidence: string): boolean {
  const c = normalize(candidate.text);
  const e = normalize(evidence);
  if (c.length === 0 || e.length === 0) return false;
  return c.startsWith(e) || e.startsWith(c);
}

/**
 * Decide what the current pipeline implies for one mined ledger row.
 * `email` is the row's source EmailMessage (null when it was deleted since).
 */
export function classifyMinedCommitment(
  row: MinedCommitmentRow,
  email: SourceEmailRow | null,
  userEmail: string | null,
): CleanupDecision {
  if (!email) {
    return { action: "keep", reason: "source email missing — cannot re-evaluate" };
  }

  // Gate order mirrors persistGmailEmail → extractAndUpsertCommitmentsFromText.
  if (isClearMarketing({ labels: email.labels, subject: email.subject })) {
    return { action: "delete", reason: "marketing mail (firewall skips mining)" };
  }
  if (isAutomatedSender(email.from)) {
    return {
      action: "delete",
      reason: "automated sender (no-reply/system-notification/logistics)",
    };
  }

  const miningText = [email.subject, email.body || email.snippet].filter(Boolean).join("\n\n");
  const candidates = extractCommitmentCandidates(miningText, { maxCandidates: MAX_CANDIDATES });
  const evidence = row.evidenceText ?? "";
  const matched = candidates.find((c) => matchesEvidence(c, evidence));
  if (!matched) {
    return {
      action: "delete",
      reason: "no longer extracted (policy-notice / second-person / transactional filter)",
    };
  }

  // Sender-perspective owner attribution (mirrors ownerForCandidate in
  // commitment-ingestion.ts): first-person text in a received email is the
  // sender's promise unless the user authored the message themselves.
  const senderAddress = email.fromAddress ?? (extractEmailAddress(email.from) || null);
  const senderIsUser =
    userEmail != null && senderAddress != null && senderAddress === userEmail.toLowerCase();
  const expectedOwner = matched.owner === "USER" && !senderIsUser ? "COUNTERPARTY" : matched.owner;

  if (row.owner === "USER" && expectedOwner === "COUNTERPARTY") {
    return {
      action: "reattribute",
      reason: "first-person promise belongs to the sender",
      owner: "COUNTERPARTY",
      counterpartyEmail: senderAddress || null,
    };
  }

  return { action: "keep", reason: "still extracted with the same owner" };
}
