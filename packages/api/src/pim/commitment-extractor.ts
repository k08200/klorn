/**
 * Rule-based commitment candidate extractor.
 *
 * The job here is *narrow*: scan a piece of text (email body, chat message,
 * note) and surface lines that look like a promise. We do not try to fully
 * structure them — that's the LLM stage. Output is a candidate with the
 * matched span, who appears to owe (USER / COUNTERPARTY / UNKNOWN) and a
 * weak due-date hint when the phrasing carried one.
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

export interface CommitmentCandidate {
  text: string; // matched sentence/clause
  owner: CommitmentOwner; // who owes the action
  dueHint: string | null; // raw phrasing of the due window, if any
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

// Common Korean date-window cues — used to extract dueHint from a matched
// sentence. Order matters: longer phrases checked first so "다음 주 월요일"
// wins over "다음 주".
const KO_DUE_HINTS = [
  /(이번\s*달|이번\s*주|다음\s*달|다음\s*주|다음\s*주\s*[월화수목금토일]요일)/,
  /(오늘|내일|모레|글피)/,
  /(\d{1,2}\s*월\s*\d{1,2}\s*일)/,
  /(\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?)/,
  /(주말|평일|월말|금주\s*내|금주\s*안|금일\s*내)/,
];

const EN_DUE_HINTS = [
  /(by\s+(?:end\s+of\s+(?:the\s+)?(?:day|week|month)|EOD|EOW|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+\w+))/i,
  /(within\s+\d+\s+(?:hours?|days?|weeks?))/i,
  /(in\s+\d+\s+(?:hours?|days?|weeks?))/i,
  /(this\s+(?:morning|afternoon|evening|week|month))/i,
  /(next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))/i,
];

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
    // "You/Your" is excluded from the capitalized-subject alternation: a
    // sentence telling the RECIPIENT what will happen ("You will not be
    // allowed to join the queue…") is a notice about the user, never a
    // counterparty promise (founder screen 2026-07-22).
    name: "en-counterparty-future",
    pattern:
      /\b(?:they|he|she|[Tt]he team|(?!Your?\b)[A-Z][a-z]+)\s+(?:will|is going to|'ll|will be|plans to|is supposed to)\s+[^.!?\n]{0,160}/g,
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

function findDueHint(text: string): string | null {
  for (const re of KO_DUE_HINTS) {
    const match = text.match(re);
    if (match?.[1]) return match[1].trim();
  }
  for (const re of EN_DUE_HINTS) {
    const match = text.match(re);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

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
// to park…"). Nobody is promising an action — the sentence describes a
// restriction — so it must never become a ledger commitment no matter which
// subject-rule matched it.
const POLICY_NOTICE_RE = /\bwill\s+not\s+be\s+(?:allowed|permitted|able|eligible|required)\b/i;

function isPolicyNotice(text: string): boolean {
  return POLICY_NOTICE_RE.test(text);
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
          dueHint: findDueHint(matched),
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
  return dedupeCandidates(collected).slice(0, limit);
}
