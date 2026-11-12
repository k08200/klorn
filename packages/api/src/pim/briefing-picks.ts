/**
 * Briefing picks: the model's answer, checked and rendered by the server.
 *
 * The model answers in JSON (BRIEFING_ANSWER_SCHEMA): one signal line, up to
 * three picks, and short "connected" / "other" bullets. A pick names one mail
 * from the prompt by its ref (m1, m2, …) and quotes the exact phrase in it —
 * a deadline or an ask — that makes it matter. The quote is evidence only
 * when the mail really contains it, so every pick is checked here
 * (`quoteIsInMail`) and a pick that fails is dropped rather than shown.
 *
 * Every field the model writes is flattened to one plain line before the
 * server renders it: the model read untrusted mail, so its output cannot be
 * allowed to add sections, links or the wrapper tags back.
 */

import { stripUntrusted } from "../untrusted.js";
import type { BriefingCopy } from "./briefing-copy.js";

/** Picks shown per briefing. */
export const MAX_PICKS = 3;
/** Entries read from the model's pick list before the cap: room for drops. */
const PICK_CANDIDATES = 6;
/** A quote shorter than this is not evidence ("the", "Re:"); CJK packs more per character. */
const MIN_QUOTE_CHARS = 6;
const MIN_QUOTE_CHARS_CJK = 4;
const MAX_QUOTE_CHARS = 200;
/** Model output is cut to this multiple of a field's cap before any regex runs. */
const RAW_SLICE_FACTOR = 4;
const SIGNAL_MAX = 300;
const ACTION_MAX = 160;
const REASON_MAX = 200;
const BULLET_MAX = 200;
const MAX_CONNECTED = 2;
const MAX_OTHER = 3;

export interface BriefingPick {
  rank: number;
  /** EmailMessage.id of the picked mail. */
  emailId: string;
  action: string;
  reason: string;
  /** Verified substring of the mail. */
  quote: string;
  /** When the user first opened the mail from this pick (ISO), if ever. */
  openedAt?: string | null;
}

/**
 * A mail the model may pick: its id and the texts a quote must come from
 * (subject, snippet, excerpt — each on its own, so a quote cannot span two).
 */
export interface PickableMail {
  emailId: string;
  texts: readonly string[];
}

export interface BriefingAnswer {
  signal: string;
  picks: BriefingPick[];
  connected: string[];
  other: string[];
}

/** JSON schema of the model's answer (response_format json_schema). */
export const BRIEFING_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    signal: {
      type: "string",
      description: "One sentence naming the single thing that shapes today.",
    },
    picks: {
      type: "array",
      maxItems: MAX_PICKS,
      description: "Up to three mails to act on today, most important first.",
      items: {
        type: "object",
        properties: {
          mail: { type: "string", description: "The mail's ref from the data, e.g. m2." },
          action: { type: "string", description: "What to do, imperative, under 12 words." },
          reason: { type: "string", description: "Why it matters today, one short clause." },
          quote: {
            type: "string",
            description:
              "The deadline or ask, copied character for character from that mail's subject, snippet or excerpt. 3-120 characters.",
          },
        },
        required: ["mail", "action", "reason", "quote"],
      },
    },
    connected: {
      type: "array",
      maxItems: MAX_CONNECTED,
      items: { type: "string" },
      description: "How mail, tasks and calendar relate. Empty when nothing clearly does.",
    },
    other: {
      type: "array",
      maxItems: MAX_OTHER,
      items: { type: "string" },
      description: "Two or three short bullets of lower-priority context.",
    },
  },
  required: ["signal", "picks", "connected", "other"],
} as const;

const ENTITY: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITY[name.toLowerCase()] ?? whole;
  });
}

/**
 * The comparable form of mail text and of a quote: entities decoded (Gmail
 * snippets carry `&#39;`), NFKC, typographic quotes made straight, whitespace
 * collapsed. Case is kept: the quote must be the mail's own words.
 */
export function normalizeQuoteText(text: string): string {
  return decodeEntities(text)
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const QUOTE_MARKS = new Set(['"', "'", "«", "»", "「", "」", "『", "』", " "]);

/** Surrounding quote marks and spaces removed, in linear time. */
function trimQuoteMarks(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && QUOTE_MARKS.has(text[start] ?? "")) start++;
  while (end > start && QUOTE_MARKS.has(text[end - 1] ?? "")) end--;
  return text.slice(start, end);
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

/**
 * True when `quote` occurs in one of `texts` and is long enough to be
 * evidence: at least 6 characters (4 with CJK or Hangul), at most 200.
 */
export function quoteIsInMail(quote: string, texts: readonly string[]): boolean {
  if (quote.length > MAX_QUOTE_CHARS * RAW_SLICE_FACTOR) return false;
  const needle = trimQuoteMarks(normalizeQuoteText(quote));
  const length = [...needle].length;
  const min = CJK.test(needle) ? MIN_QUOTE_CHARS_CJK : MIN_QUOTE_CHARS;
  if (length < min || length > MAX_QUOTE_CHARS) return false;
  return texts.some((text) => normalizeQuoteText(text).includes(needle));
}

function clamp(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

const LIST_OR_HEADING_MARKER = /^(?:[-*•>]|#{1,6}|\d{1,3}[.)])\s+/;
const MARKER_PASSES = 4;

/**
 * Text safe to show inside the briefing, whoever wrote it: wrapper tags, HTML
 * or autolink brackets, URLs, link brackets and backticks removed, so no field
 * can render as a link, a code block or markup; whitespace collapsed. Input is
 * cut before any regex runs, and every pattern is bounded.
 */
export function displaySafe(value: string, max: number): string {
  let text = stripUntrusted(value.slice(0, max * RAW_SLICE_FACTOR))
    .replace(/!?\[([^[\]]{0,300})\]\([^()\s]{0,500}\)/g, "$1")
    .replace(/<[^<>]{0,500}>/g, "")
    .replace(/\b(?:https?|ftp|mailto|file|javascript|data):[^\s]{0,2000}/gi, "")
    .replace(/\bwww\.[^\s]{1,2000}/gi, "")
    .replace(/[[\]<>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (let pass = 0; pass < MARKER_PASSES && LIST_OR_HEADING_MARKER.test(text); pass++) {
    text = text.replace(LIST_OR_HEADING_MARKER, "");
  }
  return clamp(text, max);
}

/** One plain line from a model-written field (displaySafe), or "" for a non-string. */
function plainLine(value: unknown, max: number): string {
  return typeof value === "string" ? displaySafe(value, max) : "";
}

function plainList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => plainLine(item, BULLET_MAX))
    .filter((line) => line.length > 0)
    .slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPicks(value: unknown, mails: ReadonlyMap<string, PickableMail>): BriefingPick[] {
  if (!Array.isArray(value)) return [];
  const picks: BriefingPick[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, PICK_CANDIDATES)) {
    if (picks.length === MAX_PICKS) break;
    if (!isRecord(entry) || typeof entry.mail !== "string") continue;
    const mail = mails.get(entry.mail.trim());
    if (!mail || seen.has(mail.emailId)) continue;
    const action = plainLine(entry.action, ACTION_MAX);
    const quote = typeof entry.quote === "string" ? entry.quote : "";
    if (!action || !quoteIsInMail(quote, mail.texts)) continue;
    // Verified, but still the sender's words: shown only in its safe form, and
    // a quote that is mostly a link or markup is not evidence worth showing.
    const shown = displaySafe(trimQuoteMarks(normalizeQuoteText(quote)), MAX_QUOTE_CHARS);
    if ([...shown].length < MIN_QUOTE_CHARS_CJK) continue;
    seen.add(mail.emailId);
    picks.push({
      rank: picks.length + 1,
      emailId: mail.emailId,
      action,
      reason: plainLine(entry.reason, REASON_MAX),
      quote: shown,
    });
  }
  return picks;
}

/**
 * The model's answer, checked: null when it has no signal line (the caller
 * then falls back), otherwise at most three verified picks and the bullets.
 */
export function parseBriefingAnswer(
  raw: unknown,
  mails: ReadonlyMap<string, PickableMail>,
): BriefingAnswer | null {
  if (!isRecord(raw)) return null;
  const signal = plainLine(raw.signal, SIGNAL_MAX);
  if (!signal) return null;
  return {
    signal,
    picks: readPicks(raw.picks, mails),
    connected: plainList(raw.connected, MAX_CONNECTED),
    other: plainList(raw.other, MAX_OTHER),
  };
}

/** A quote shown inside italics: no character that would end or nest them. */
function displayQuote(quote: string): string {
  return quote.replace(/[*_`]/g, "");
}

/** The briefing text the user reads, rendered by the server around the answer. */
export function renderBriefingAnswer(answer: BriefingAnswer, copy: BriefingCopy): string {
  const blocks: string[][] = [[answer.signal]];
  if (answer.picks.length > 0) {
    blocks.push([
      `**${copy.top}**`,
      // Always the dash: the web client takes the label up to it.
      ...answer.picks.map(
        (p) => `${p.rank}. ${p.action} — ${p.reason ? `${p.reason} ` : ""}*“${displayQuote(p.quote)}”*`,
      ),
    ]);
  }
  if (answer.connected.length > 0) {
    blocks.push([`**${copy.connected}**`, ...answer.connected.map((line) => `- ${line}`)]);
  }
  if (answer.other.length > 0) {
    blocks.push([`**${copy.other}**`, ...answer.other.map((line) => `- ${line}`)]);
  }
  return blocks.map((block) => block.join("\n")).join("\n\n");
}

/** Picks as stored on the briefing note (Note.picks), malformed entries dropped. */
export function readStoredPicks(value: unknown): BriefingPick[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): BriefingPick[] => {
    if (!isRecord(entry)) return [];
    const { rank, emailId, action, reason, quote, openedAt } = entry;
    if (
      typeof rank !== "number" ||
      !Number.isInteger(rank) ||
      typeof emailId !== "string" ||
      typeof action !== "string" ||
      typeof reason !== "string" ||
      typeof quote !== "string"
    ) {
      return [];
    }
    return [
      {
        rank,
        emailId,
        action,
        reason,
        quote,
        openedAt: typeof openedAt === "string" ? openedAt : null,
      },
    ];
  });
}
