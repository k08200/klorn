/**
 * Rule-based commitment candidate extractor.
 *
 * The job here is *narrow*: scan a piece of text (email body, chat message,
 * note) and surface lines that look like a promise. We do not try to fully
 * structure them — that's the LLM stage. Output is a candidate with the
 * matched span, who appears to owe (USER / COUNTERPARTY / UNKNOWN) and the
 * deadline wording when the phrasing carried one (commitment-due.ts).
 *
 * Patterns deliberately err on the side of false positives. The downstream
 * LLM extraction (next PR) decides whether the candidate is real and writes
 * the structured Commitment row.
 *
 * Languages: Korean + English are both first-class. Each language has its
 * own pattern list because the cues are different ("I'll send" vs
 * "보내드릴게요").
 */

import type { CommitmentOwner } from "@prisma/client";
import { findDuePhrase } from "./commitment-due.js";

export interface CommitmentCandidate {
  text: string; // matched sentence/clause
  owner: CommitmentOwner; // who owes the action
  dueHint: string | null; // the deadline wording as written, if any (findDuePhrase)
  pattern: string; // which rule fired (debug aid)
  startIndex: number; // offset within the input — for downstream snippeting
}

interface Rule {
  name: string;
  // Pattern over the full text. Each match becomes a candidate. Use named
  // groups when a match needs to expose substructure (e.g. due hint).
  pattern: RegExp;
  owner: CommitmentOwner;
}

// Korean — first-person commitment (USER owes). Matches modal endings that
// signal intent: -ㄹ게요, -할게요, -보낼게요, -드릴게요, -하겠습니다, -할 예정.
const KO_USER_RULES: Rule[] = [
  {
    name: "ko-user-deliverable",
    pattern:
      /[^.!?\n]{0,160}?(보내드릴게요|보낼게요|드릴게요|보내겠습니다|전달드릴게요|공유드릴게요|발송하겠습니다|회신드릴게요|연락드릴게요|확인하고 회신드릴게요|확인 후 알려드릴게요|업데이트해드릴게요|준비해드릴게요|준비할게요|마무리할게요|정리해드릴게요|할게요|하겠습니다)[^.!?\n]{0,80}/g,
    owner: "USER",
  },
];

// Korean — counterparty commitment ("Sarah will send"). Matches third-person
// future like "보내주신다고", "주실 예정이라고", or quoted promises.
const KO_COUNTERPARTY_RULES: Rule[] = [
  {
    name: "ko-counterparty-future",
    pattern:
      /[^.!?\n]{0,160}?(보내주신다고|보내주실|주신다고|주실 예정|주신다고 하셨|보내주시기로|회신주시기로|확인해주시기로|알려주신다고|알려주시기로)[^.!?\n]{0,80}/g,
    owner: "COUNTERPARTY",
  },
];

const EN_USER_RULES: Rule[] = [
  {
    name: "en-user-future",
    pattern:
      /\b(I(?:'|’)?ll|I will|I am going to|I'm going to|I'll send|I'll share|I'll get back|I'll follow up|I will follow up|I'll have it|I'll get|I'll write|I'll review|I'll prepare|let me send|let me share|let me get|let me follow|let me draft)\b[^.!?\n]{0,160}/gi,
    owner: "USER",
  },
];

const EN_COUNTERPARTY_RULES: Rule[] = [
  {
    // Excluded from the capitalized-subject alternation (founder screen +
    // prod ledger audit 2026-07-22): "You/Your" — a sentence telling the
    // RECIPIENT what will happen is a notice, not a counterparty promise —
    // and audience-cohort nouns (Attendees/Students/Visitors/…) — an
    // announcement about a group is never a promise owed to the user.
    name: "en-counterparty-future",
    pattern:
      /\b(?:they|he|she|[Tt]he team|(?!Your?\b|Attendees?\b|Students?\b|Visitors?\b|Volunteers?\b|Applicants?\b|Participants?\b|Members?\b|Customers?\b|Users?\b|Guests?\b|Patients?\b|Winners?\b|Recipients?\b)[A-Z][a-z]+)\s+(?:will|is going to|'ll|will be|plans to|is supposed to)\s+[^.!?\n]{0,160}/g,
    owner: "COUNTERPARTY",
  },
  {
    name: "en-counterparty-promise",
    pattern:
      /\b(?:they|he|she|the team|[A-Z][a-z]+)\s+(?:said|mentioned|promised|committed to)\s+(?:they(?:'|’)?d|that they will|that they would)\s+[^.!?\n]{0,160}/g,
    owner: "COUNTERPARTY",
  },
];

const ALL_RULES: Rule[] = [
  ...KO_USER_RULES,
  ...KO_COUNTERPARTY_RULES,
  ...EN_USER_RULES,
  ...EN_COUNTERPARTY_RULES,
];

function dedupeCandidates(candidates: CommitmentCandidate[]): CommitmentCandidate[] {
  // Two candidates are duplicates if their matched text is identical (case
  // insensitive). The first hit wins to preserve the earliest pattern.
  const seen = new Set<string>();
  const out: CommitmentCandidate[] = [];
  for (const c of candidates) {
    const key = c.text.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Transactional / shipping noise: order-confirmation and delivery emails phrase
// updates as "Order will arrive…" / "Amazon will deliver your package". The key
// disambiguator vs a real commitment: in a notification the transactional word
// is the SUBJECT of the matched span ("Order will…", "Delivery will…", "Your
// package will…"); in a human commitment it is a verb/object ("Sarah will SHIP
// the feature", "John will ORDER the laptop", "He will send a RECEIPT"). So we
// match transactional nouns only in subject position, plus unambiguous shipping
// phrases — never bare verbs like ship/order/deliver/refund/receipt.
const TRANSACTIONAL_NOISE_RE =
  /^(?:your\s+)?(?:orders?|shipments?|parcels?|packages?|deliver(?:y|ies)|tracking|courier)\b|\byour (?:order|package|parcel|shipment)\b|\b(?:out for delivery|estimated (?:delivery|arrival)|tracking number|has shipped|on its way|will be delivered)\b/i;

function isTransactionalNoise(text: string): boolean {
  return TRANSACTIONAL_NOISE_RE.test(text);
}

// Policy-notice noise: automated notices phrase rules as negated permission
// ("Applicants will not be permitted to enter…", "Visitors will not be able
// to park…") or as expiry countdowns ("It will expire in 5 minutes" — OTP
// codes, offers). Nobody is promising an action — the sentence describes a
// restriction or a deadline — so it must never become a ledger commitment no
// matter which subject-rule matched it.
const POLICY_NOTICE_RE =
  /\bwill\s+not\s+be\s+(?:allowed|permitted|able|eligible|required)\b|\bwill\s+expire\b/i;

// Korean formulaic closings: politeness boilerplate ending in -하겠습니다
// ("노력하겠습니다", "최선을 다하겠습니다", "알려주시면 감사하겠습니다")
// carries no concrete deliverable — it is how Korean mail signs off, not a
// promise. Prod ledger audit 2026-07-22 found these mined as I-OWE rows.
const KO_FORMULAIC_CLOSING_RE =
  /(?:노력하겠습니다|최선을\s*다하겠습니다|감사하겠습니다|보답하겠습니다)/;

function isPolicyNotice(text: string): boolean {
  return POLICY_NOTICE_RE.test(text) || KO_FORMULAIC_CLOSING_RE.test(text);
}

/**
 * Scan a chunk of text for commitment-shaped sentences. Returns at most
 * `maxCandidates` results (default 10), in order of appearance.
 */
export function extractCommitmentCandidates(
  text: string,
  opts?: { maxCandidates?: number },
): CommitmentCandidate[] {
  if (!text || text.trim().length === 0) return [];
  const limit = opts?.maxCandidates ?? 10;
  const collected: CommitmentCandidate[] = [];

  for (const rule of ALL_RULES) {
    rule.pattern.lastIndex = 0; // RegExp objects with /g hold state
    let match: RegExpExecArray | null = rule.pattern.exec(text);
    while (match !== null) {
      const matched = match[0].trim();
      if (matched.length > 0 && !isTransactionalNoise(matched) && !isPolicyNotice(matched)) {
        collected.push({
          text: matched,
          owner: rule.owner,
          dueHint: null, // filled below, only for the candidates that survive
          pattern: rule.name,
          startIndex: match.index,
        });
      }
      // Guard against zero-width matches looping forever
      if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
      match = rule.pattern.exec(text);
    }
  }

  collected.sort((a, b) => a.startIndex - b.startIndex);
  // The deadline scan runs ~40 patterns, so it runs after dedupe + cap, not
  // per raw match: a long body with thousands of matches pays it only `limit` times.
  return dedupeCandidates(collected)
    .slice(0, limit)
    .map((candidate) => ({ ...candidate, dueHint: findDuePhrase(candidate.text) }));
}
