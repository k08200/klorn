/**
 * Message text handling for the KakaoTalk import, linear and size-capped
 * (docs/providers/kakaotalk-import.md §3). Single passes only; no regex is
 * run on, or built from, export text.
 */

export type KakaoMessageKind = "text" | "media" | "deleted";

const NEWLINE = 10;
const TAB = 9;
const DEL = 127;
const C1_END = 159;
const SPACE = 32;

/** Placeholders the exports print instead of a photo, video, emoticon or file. */
const MEDIA_EXACT = new Set([
  "사진",
  "동영상",
  "이모티콘",
  "(이모티콘)",
  "스티커",
  "음성메시지",
  "Photo",
  "Photos",
  "Video",
  "Emoticon",
  "Emoticons",
  "(Emoticon)",
  "Sticker",
  "Voice message",
]);
const MEDIA_PREFIXES = ["샵검색: ", "#Search: "];
/** `파일: 견적서.pdf` — a file placeholder only when what follows reads as a file name. */
const FILE_PREFIXES = ["파일: ", "File: "];
const MAX_FILE_NAME = 255;
const MAX_EXTENSION = 5;
const DELETED_EXACT = new Set([
  "삭제된 메시지입니다.",
  "메시지가 삭제되었습니다.",
  "This message was deleted.",
  "Deleted message.",
]);

/** PC .txt notices carry no timestamp: these endings mark them. */
const NOTICE_SUFFIXES = [
  "님이 들어왔습니다.",
  "님이 나갔습니다.",
  "초대했습니다.",
  "초대하였습니다.",
  "내보냈습니다.",
  "메시지를 가렸습니다.",
  "joined this chatroom.",
  "left this chatroom.",
  "to the chatroom.",
  "from the chatroom.",
];
const MAX_NOTICE_CHARS = 200;

function isDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/** `사진 3장` / `3 photos` */
function isCountedMedia(text: string): boolean {
  if (text.startsWith("사진 ") && text.endsWith("장")) return isDigits(text.slice(3, -1));
  if (text.endsWith(" photos")) return isDigits(text.slice(0, -" photos".length));
  return false;
}

function isAsciiAlphanumeric(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const ok =
      (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (!ok) return false;
  }
  return value.length > 0;
}

/** One line ending in `.ext` (1-5 letters or digits). */
function looksLikeFileName(name: string): boolean {
  if (name.length > MAX_FILE_NAME || name.includes("\n")) return false;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  return extension.length <= MAX_EXTENSION && isAsciiAlphanumeric(extension);
}

export function classifyKakaoText(text: string): KakaoMessageKind {
  if (DELETED_EXACT.has(text)) return "deleted";
  if (MEDIA_EXACT.has(text) || isCountedMedia(text)) return "media";
  if (MEDIA_PREFIXES.some((prefix) => text.startsWith(prefix))) return "media";
  const file = FILE_PREFIXES.find((prefix) => text.startsWith(prefix));
  if (file !== undefined && looksLikeFileName(text.slice(file.length))) return "media";
  return "text";
}

export function isPcNoticeLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_NOTICE_CHARS &&
    NOTICE_SUFFIXES.some((suffix) => trimmed.endsWith(suffix))
  );
}

/**
 * Control characters dropped (C0 and C1, DEL; newline and tab kept when
 * `keepLines`). One pass, slicing around what is dropped.
 */
export function stripControls(value: string, keepLines: boolean): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const control = code < SPACE || (code >= DEL && code <= C1_END);
    if (!control || (keepLines && (code === NEWLINE || code === TAB))) continue;
    out += value.slice(from, i);
    from = i + 1;
  }
  return from === 0 ? value : out + value.slice(from);
}

/** Zero-width and bidi format characters: invisible, and able to spoof a name's display. */
function isFormatChar(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/** Format characters dropped (speaker names). One pass. */
export function stripFormatChars(value: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < value.length; i++) {
    if (!isFormatChar(value.charCodeAt(i))) continue;
    out += value.slice(from, i);
    from = i + 1;
  }
  return from === 0 ? value : out + value.slice(from);
}

/** At most `max` UTF-16 units, never splitting a surrogate pair. */
export function capChars(value: string, max: number): string {
  if (value.length <= max) return value;
  const code = value.charCodeAt(max - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return value.slice(0, cut);
}

/** A message's lines, joined up to a cap: later lines stop counting once it is full. */
export class TextBuilder {
  private readonly parts: string[];
  private length: number;

  constructor(
    first: string,
    private readonly max: number,
  ) {
    const head = capChars(first, max);
    this.parts = [head];
    this.length = head.length;
  }

  append(line: string): void {
    if (this.length >= this.max) return;
    const piece = capChars(`\n${line}`, this.max - this.length);
    this.parts.push(piece);
    this.length += piece.length;
  }

  build(): string {
    return stripControls(this.parts.join(""), true).trimEnd();
  }
}
