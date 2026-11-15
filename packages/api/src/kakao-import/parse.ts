/**
 * The KakaoTalk chat-export parser (docs/providers/kakaotalk-import.md §2).
 *
 * Input is a user-uploaded file holding other people's messages: untrusted,
 * possibly multi-MB, possibly hostile. This repo has had event-loop outages
 * from regexes and parsers on untrusted text (#1414, #1466/#1467, #1534), so:
 * - every size is capped up front: bytes, lines, line length, message length,
 *   messages, speakers;
 * - it is a linear, line-oriented state machine: each line is read once by the
 *   bounded scanners in scan.ts, and no regex touches export text;
 * - an unrecognised file is refused with a code, never guessed at.
 *
 * Pure: no I/O, no clock, no zone. Timestamps come back as the wall clock the
 * export printed (`localMs`, written as if UTC); the caller applies the zone.
 */

import {
  bracketHead,
  csvTimestamp,
  dottedHead,
  englishDateHead,
  koreanDateHead,
  type LineHead,
  type LocalDate,
  separatorDate,
  wallClockMs,
} from "./scan.js";
import {
  capChars,
  classifyKakaoText,
  isPcNoticeLine,
  type KakaoMessageKind,
  stripControls,
  stripFormatChars,
  TextBuilder,
} from "./text.js";

export type { KakaoMessageKind } from "./text.js";

export const KAKAO_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const KAKAO_MAX_LINES = 400_000;
export const KAKAO_MAX_LINE_CHARS = 8_000;
export const KAKAO_MAX_MESSAGE_CHARS = 4_000;
export const KAKAO_MAX_MESSAGES = 200_000;
export const KAKAO_MAX_SPEAKERS = 500;
export const KAKAO_MAX_SPEAKER_CHARS = 80;
/** Lines read to recognise the format before giving up. */
const DETECT_MAX_LINES = 1_000;
/** Non-empty lines checked for a KakaoTalk header. */
const HEADER_MAX_LINES = 5;
/** A speaker-to-text boundary further than this into a head means a notice. */
const SPEAKER_WINDOW = KAKAO_MAX_SPEAKER_CHARS + 3;

export type KakaoFormat =
  | "mobile-dotted"
  | "mobile-korean-date"
  | "mobile-english-date"
  | "pc-bracketed"
  | "csv";

export interface KakaoMessage {
  /** The printed wall clock, as `Date.UTC(y, m - 1, d, h, mi, s)`. */
  readonly localMs: number;
  readonly speaker: string;
  readonly kind: KakaoMessageKind;
  readonly text: string;
}

export type KakaoParseErrorCode =
  | "empty-file"
  | "file-too-large"
  | "unsupported-encoding"
  | "zip-not-supported"
  | "unknown-format"
  | "no-messages"
  | "too-many-lines"
  | "too-many-messages"
  | "too-many-speakers";

export type KakaoParseResult =
  | {
      readonly ok: true;
      readonly format: KakaoFormat;
      readonly messages: readonly KakaoMessage[];
      /** Join/leave/invite notices skipped. */
      readonly systemLines: number;
    }
  | { readonly ok: false; readonly code: KakaoParseErrorCode };

class ParseFailure extends Error {
  constructor(readonly code: KakaoParseErrorCode) {
    super(code);
    this.name = "KakaoParseFailure";
  }
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const UTF8_BOM = [0xef, 0xbb, 0xbf];

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, i) => bytes[i] === byte);
}

/** UTF-8 only: a BOM is dropped; UTF-16, CP949 and anything invalid are refused. */
function decodeExport(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new ParseFailure("empty-file");
  if (bytes.length > KAKAO_MAX_FILE_BYTES) throw new ParseFailure("file-too-large");
  if (startsWithBytes(bytes, ZIP_MAGIC)) throw new ParseFailure("zip-not-supported");
  const body = startsWithBytes(bytes, UTF8_BOM) ? bytes.subarray(UTF8_BOM.length) : bytes;
  // UTF-16 (with or without its BOM) is NUL-heavy, and Postgres text cannot hold NUL.
  if (body.includes(0)) throw new ParseFailure("unsupported-encoding");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new ParseFailure("unsupported-encoding");
  }
}

/** Lines without their `\r` (a final newline ends the last line), each capped; refused past the line cap. */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (lines.length >= KAKAO_MAX_LINES) throw new ParseFailure("too-many-lines");
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const stop = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    lines.push(capChars(text.slice(start, stop), KAKAO_MAX_LINE_CHARS));
    start = end + 1;
  }
  return lines;
}

/** Collects messages under the message and speaker caps. */
class MessageSink {
  readonly messages: KakaoMessage[] = [];
  private readonly speakers = new Set<string>();
  systemLines = 0;

  add(localMs: number, rawSpeaker: string, text: string): void {
    const visible = stripFormatChars(stripControls(rawSpeaker, false));
    const speaker = capChars(visible.trim(), KAKAO_MAX_SPEAKER_CHARS);
    if (speaker === "") {
      this.systemLines++;
      return;
    }
    if (this.messages.length >= KAKAO_MAX_MESSAGES) throw new ParseFailure("too-many-messages");
    if (!this.speakers.has(speaker)) {
      if (this.speakers.size >= KAKAO_MAX_SPEAKERS) throw new ParseFailure("too-many-speakers");
      this.speakers.add(speaker);
    }
    this.messages.push({ localMs, speaker, kind: classifyKakaoText(text.trim()), text });
  }
}

/** A message whose continuation lines may still follow. */
interface Open {
  readonly localMs: number;
  readonly speaker: string;
  readonly body: TextBuilder;
}

function close(open: Open | null, sink: MessageSink): null {
  if (open !== null) sink.add(open.localMs, open.speaker, open.body.build());
  return null;
}

/** `, speaker : text` after a mobile head; anything else is a notice. */
function speakerAndText(rest: string): { speaker: string; text: string } | null {
  if (!rest.startsWith(", ")) return null;
  const boundary = rest.slice(0, SPEAKER_WINDOW + 2).indexOf(" : ", 2);
  if (boundary === -1) return null;
  return { speaker: rest.slice(2, boundary), text: rest.slice(boundary + 3) };
}

function parseMobile(lines: readonly string[], head: (line: string) => LineHead | null) {
  const sink = new MessageSink();
  let open: Open | null = null;
  for (const line of lines) {
    const found = head(line);
    if (found !== null) {
      open = close(open, sink);
      if (found.rest.trim() === "") continue; // a date line that also prints a time
      const message = speakerAndText(found.rest);
      if (message === null) {
        sink.systemLines++;
        continue;
      }
      const body = new TextBuilder(message.text, KAKAO_MAX_MESSAGE_CHARS);
      open = { localMs: found.localMs, speaker: message.speaker, body };
      continue;
    }
    if (separatorDate(line) !== null) {
      open = close(open, sink);
      continue;
    }
    open?.body.append(line);
  }
  close(open, sink);
  return sink;
}

function parsePc(lines: readonly string[]) {
  const sink = new MessageSink();
  let open: Open | null = null;
  let date: LocalDate | null = null;
  for (const line of lines) {
    // Only the dashed separator: a message's own line that happens to be a
    // bare date ("2026년 3월 5일 목요일") must not move later messages' day.
    const separator = line.startsWith("---") ? separatorDate(line) : null;
    if (separator !== null) {
      open = close(open, sink);
      date = separator;
      continue;
    }
    const found = bracketHead(line, KAKAO_MAX_SPEAKER_CHARS);
    if (found !== null && date !== null) {
      open = close(open, sink);
      const body = new TextBuilder(found.text, KAKAO_MAX_MESSAGE_CHARS);
      open = { localMs: wallClockMs(date, found.time), speaker: found.speaker, body };
      continue;
    }
    if (open !== null && isPcNoticeLine(line)) {
      open = close(open, sink);
      sink.systemLines++;
      continue;
    }
    open?.body.append(line);
  }
  close(open, sink);
  return sink;
}

/** One CSV field being read, capped: past the cap its characters stop counting. */
class FieldBuilder {
  private readonly parts: string[] = [];
  private length = 0;
  constructor(private readonly max: number) {}

  push(piece: string): void {
    if (piece === "" || this.length >= this.max) return;
    const kept = capChars(piece, this.max - this.length);
    this.parts.push(kept);
    this.length += kept.length;
  }

  take(): string {
    const value = this.parts.join("");
    this.parts.length = 0;
    this.length = 0;
    return value;
  }
}

const CSV_HEADERS = new Set(["date,user,message", "날짜,사용자,메시지"]);

function isCsvHeader(line: string): boolean {
  return CSV_HEADERS.has(line.split('"').join("").trim().toLowerCase());
}

/**
 * RFC 4180 records over lines: a quoted field may run across lines. Date and
 * user end at a comma; the message keeps any unquoted commas.
 */
class CsvRecords {
  private readonly fields: string[] = [];
  private readonly field = new FieldBuilder(KAKAO_MAX_MESSAGE_CHARS);
  private quoted = false;

  constructor(private readonly sink: MessageSink) {}

  /** Feed one line; a record ends at the first line end outside quotes. */
  line(line: string): void {
    if (!this.quoted && line === "") return;
    let from = 0;
    for (let i = 0; i < line.length; i++) {
      if (!this.isBoundary(line[i])) continue;
      this.field.push(line.slice(from, i));
      i = this.cross(line, i);
      from = i + 1;
    }
    this.field.push(line.slice(from));
    if (this.quoted) this.field.push("\n");
    else this.finish();
  }

  private isBoundary(ch: string): boolean {
    return ch === '"' || (!this.quoted && ch === "," && this.fields.length < 2);
  }

  /** Step over a field end or a quote; returns the index of the last character consumed. */
  private cross(line: string, i: number): number {
    if (line[i] === ",") {
      this.fields.push(this.field.take());
      return i;
    }
    if (!this.quoted) {
      this.quoted = true;
      return i;
    }
    if (line[i + 1] === '"') {
      this.field.push('"');
      return i + 1;
    }
    this.quoted = false;
    return i;
  }

  /** The file ended inside an open quote: what was read is still a record. */
  end(): void {
    if (this.quoted) this.finish();
  }

  private finish(): void {
    this.fields.push(this.field.take());
    const [date, user, ...message] = this.fields.splice(0, this.fields.length);
    const localMs = date === undefined ? null : csvTimestamp(date);
    if (localMs === null || user === undefined || message.length === 0) this.sink.systemLines++;
    else this.sink.add(localMs, user, stripControls(message.join(","), true).trimEnd());
  }
}

function parseCsv(lines: readonly string[]) {
  const sink = new MessageSink();
  const records = new CsvRecords(sink);
  for (let n = 1; n < lines.length; n++) records.line(lines[n]);
  records.end();
  return sink;
}

const MOBILE_HEADS: ReadonlyArray<[KakaoFormat, (line: string) => LineHead | null]> = [
  ["mobile-dotted", dottedHead],
  ["mobile-korean-date", koreanDateHead],
  ["mobile-english-date", englishDateHead],
];

function isMessageHead(head: LineHead | null): boolean {
  return head !== null && speakerAndText(head.rest) !== null;
}

function detectFormat(lines: readonly string[]): KakaoFormat | null {
  if (isCsvHeader(lines[0] ?? "")) return "csv";
  const limit = Math.min(lines.length, DETECT_MAX_LINES);
  for (let i = 0; i < limit; i++) {
    for (const [format, head] of MOBILE_HEADS) {
      if (isMessageHead(head(lines[i]))) return format;
    }
    if (bracketHead(lines[i], KAKAO_MAX_SPEAKER_CHARS) !== null) return "pc-bracketed";
  }
  return null;
}

/** The first lines of a KakaoTalk export: title and save date, KO or EN. */
function hasKakaoHeader(lines: readonly string[]): boolean {
  const heads = lines
    .slice(0, DETECT_MAX_LINES)
    .filter((line) => line.trim() !== "")
    .slice(0, HEADER_MAX_LINES);
  return heads.some((raw) => {
    const line = raw.trim();
    const lower = line.toLowerCase();
    return (
      line.endsWith("카카오톡 대화") ||
      line.startsWith("저장한 날짜") ||
      lower.startsWith("date saved") ||
      lower.startsWith("chat with ") ||
      lower.startsWith("talk with ") ||
      lower.includes("kakaotalk chats")
    );
  });
}

function parseLines(lines: readonly string[]): KakaoParseResult {
  const format = detectFormat(lines);
  if (format === null) {
    return { ok: false, code: hasKakaoHeader(lines) ? "no-messages" : "unknown-format" };
  }
  const mobileHead = MOBILE_HEADS.find(([name]) => name === format)?.[1];
  const sink =
    format === "csv"
      ? parseCsv(lines)
      : format === "pc-bracketed"
        ? parsePc(lines)
        : parseMobile(lines, mobileHead ?? dottedHead);
  if (sink.messages.length === 0) return { ok: false, code: "no-messages" };
  return { ok: true, format, messages: sink.messages, systemLines: sink.systemLines };
}

/** Parse one exported chat. Total: every refusal is a result code, never a throw. */
export function parseKakaoExport(bytes: Uint8Array): KakaoParseResult {
  try {
    return parseLines(splitLines(decodeExport(bytes)));
  } catch (err) {
    if (err instanceof ParseFailure) return { ok: false, code: err.code };
    throw err;
  }
}
