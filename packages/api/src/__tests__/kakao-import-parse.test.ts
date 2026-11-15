/**
 * The KakaoTalk export parser (kakao-import/parse.ts). Fixtures under
 * fixtures/kakao/ are hand-written and synthetic: every name and message is
 * invented, none is a real person's chat. CRLF, BOM and wrong-encoding
 * variants are built here from those fixtures so the files stay plain LF UTF-8.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  KAKAO_MAX_FILE_BYTES,
  KAKAO_MAX_LINES,
  KAKAO_MAX_MESSAGE_CHARS,
  KAKAO_MAX_SPEAKERS,
  type KakaoMessage,
  type KakaoParseResult,
  parseKakaoExport,
} from "../kakao-import/parse.js";

function fixture(name: string): Buffer {
  return readFileSync(new URL(`./fixtures/kakao/${name}`, import.meta.url));
}

function parsed(bytes: Uint8Array): Extract<KakaoParseResult, { ok: true }> {
  const result = parseKakaoExport(bytes);
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result;
}

function failure(bytes: Uint8Array): string {
  const result = parseKakaoExport(bytes);
  if (result.ok) throw new Error("expected a parse failure");
  return result.code;
}

/** Wall clock as Date.UTC writes it, the way the parser reports `localMs`. */
function wall(y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

function shape(messages: readonly KakaoMessage[]) {
  return messages.map((m) => ({ at: m.localMs, speaker: m.speaker, kind: m.kind, text: m.text }));
}

describe("parseKakaoExport — formats", () => {
  it("reads the mobile dotted-date Korean export: 오전/오후, multi-line, system and media lines", () => {
    const result = parsed(fixture("mobile-dotted-ko.txt"));
    expect(result.format).toBe("mobile-dotted");
    expect(shape(result.messages)).toEqual([
      {
        at: wall(2026, 11, 10, 9, 5),
        speaker: "김지수",
        kind: "text",
        text: "안녕하세요 내일 회의 자료 공유 부탁드려요",
      },
      {
        at: wall(2026, 11, 10, 9, 7),
        speaker: "이민호",
        kind: "text",
        text: "네 내일까지 보내드릴게요",
      },
      {
        at: wall(2026, 11, 10, 12, 30),
        speaker: "김지수",
        kind: "text",
        text: "감사합니다\n점심 맛있게 드세요",
      },
      { at: wall(2026, 11, 10, 12, 31), speaker: "이민호", kind: "media", text: "사진" },
      {
        at: wall(2026, 11, 11, 0, 15),
        speaker: "박서연",
        kind: "text",
        text: "늦은 시간 죄송해요, 계약서는 금요일까지 검토해서 회신드리겠습니다",
      },
      {
        at: wall(2026, 11, 11, 23, 59),
        speaker: "김지수",
        kind: "deleted",
        text: "삭제된 메시지입니다.",
      },
      { at: wall(2026, 11, 11, 23, 59), speaker: "김지수", kind: "media", text: "이모티콘" },
    ]);
    expect(result.systemLines).toBe(1);
  });

  it("reads the mobile Korean-date export, skipping time-only date lines and leave notices", () => {
    const result = parsed(fixture("mobile-korean-date.txt"));
    expect(result.format).toBe("mobile-korean-date");
    expect(shape(result.messages)).toEqual([
      {
        at: wall(2026, 11, 12, 14, 0),
        speaker: "이민호",
        kind: "text",
        text: "다음 주 월요일까지 견적서 드릴게요",
      },
      { at: wall(2026, 11, 12, 14, 1), speaker: "김지수", kind: "text", text: "네 확인했습니다" },
      { at: wall(2026, 11, 13, 10, 0), speaker: "김지수", kind: "media", text: "동영상" },
    ]);
    expect(result.systemLines).toBe(1);
  });

  it("reads the mobile English export: AM/PM, 'at' and comma separators, abbreviated months", () => {
    const result = parsed(fixture("mobile-english.txt"));
    expect(result.format).toBe("mobile-english-date");
    expect(shape(result.messages)).toEqual([
      {
        at: wall(2026, 11, 10, 9, 5),
        speaker: "Alex",
        kind: "text",
        text: "Can you send the deck?",
      },
      {
        at: wall(2026, 11, 10, 9, 7),
        speaker: "Sam",
        kind: "text",
        text: "Sure, I'll send it by Friday.",
      },
      {
        at: wall(2026, 11, 10, 12, 30),
        speaker: "Alex",
        kind: "text",
        text: "Thanks!\nSee you then",
      },
      { at: wall(2026, 11, 10, 0, 0), speaker: "Sam", kind: "media", text: "Photo" },
    ]);
    expect(result.systemLines).toBe(1);
  });

  it("reads the PC/Mac Korean .txt export: dates from separator lines, bracketed speaker and time", () => {
    const result = parsed(fixture("pc-ko.txt"));
    expect(result.format).toBe("pc-bracketed");
    expect(shape(result.messages)).toEqual([
      {
        at: wall(2026, 11, 10, 9, 5),
        speaker: "김지수",
        kind: "text",
        text: "내일 미팅 전에 자료 부탁드려요",
      },
      {
        at: wall(2026, 11, 10, 9, 7),
        speaker: "이민호",
        kind: "text",
        text: "네 오늘 저녁까지 보내드리겠습니다",
      },
      {
        at: wall(2026, 11, 10, 9, 8),
        speaker: "이민호",
        kind: "text",
        text: "첨부 파일은 두 개입니다\n1) 견적서\n2) 일정표",
      },
      { at: wall(2026, 11, 11, 12, 0), speaker: "박서연", kind: "media", text: "사진 3장" },
      {
        at: wall(2026, 11, 11, 13, 30),
        speaker: "김지수",
        kind: "text",
        text: "[중요] 금요일까지 회신 부탁드립니다",
      },
    ]);
    expect(result.systemLines).toBe(1);
  });

  it("reads the PC English .txt export", () => {
    const result = parsed(fixture("pc-en.txt"));
    expect(result.format).toBe("pc-bracketed");
    expect(shape(result.messages)).toEqual([
      {
        at: wall(2026, 11, 10, 9, 5),
        speaker: "Alex",
        kind: "text",
        text: "Can you review the contract?",
      },
      {
        at: wall(2026, 11, 10, 9, 7),
        speaker: "Sam",
        kind: "text",
        text: "I will review it by tomorrow.",
      },
      { at: wall(2026, 11, 11, 23, 30), speaker: "Sam", kind: "media", text: "Emoticons" },
    ]);
    expect(result.systemLines).toBe(1);
  });

  it("reads the PC .csv export: quoted fields, embedded newlines and doubled quotes", () => {
    const result = parsed(fixture("pc.csv"));
    expect(result.format).toBe("csv");
    expect(shape(result.messages)).toEqual([
      {
        at: wall(2026, 11, 10, 9, 5, 12),
        speaker: "김지수",
        kind: "text",
        text: "내일까지 자료 부탁드려요",
      },
      {
        at: wall(2026, 11, 10, 9, 7, 40),
        speaker: "이민호",
        kind: "text",
        text: "네, 내일 오전까지 보내드릴게요",
      },
      {
        at: wall(2026, 11, 10, 9, 8, 1),
        speaker: "이민호",
        kind: "text",
        text: '여러 줄\n메시지 "인용" 포함',
      },
      { at: wall(2026, 11, 10, 9, 9, 0), speaker: "김지수", kind: "text", text: "감사합니다" },
    ]);
  });

  it("reads 24-hour times when the export carries no 오전/오후 or AM/PM", () => {
    const text = "2026. 11. 10. 21:05, 김지수 : 저녁에 연락드릴게요\n";
    expect(shape(parsed(Buffer.from(text)).messages)).toEqual([
      {
        at: wall(2026, 11, 10, 21, 5),
        speaker: "김지수",
        kind: "text",
        text: "저녁에 연락드릴게요",
      },
    ]);
  });

  it("keeps the first ' : ' as the speaker boundary, so a colon in the text survives", () => {
    const text = "2026. 11. 10. 오후 3:00, 이민호 : 시간 : 오후 4시 : 확정\n";
    const [message] = parsed(Buffer.from(text)).messages;
    expect(message.speaker).toBe("이민호");
    expect(message.text).toBe("시간 : 오후 4시 : 확정");
  });
});

describe("parseKakaoExport — line endings and encodings", () => {
  const lf = fixture("mobile-dotted-ko.txt");
  const expected = shape(parsed(lf).messages);

  it("reads CRLF line endings exactly like LF", () => {
    const crlf = Buffer.from(lf.toString("utf8").replace(/\n/g, "\r\n"), "utf8");
    expect(shape(parsed(crlf).messages)).toEqual(expected);
  });

  it("strips a UTF-8 byte-order mark", () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), lf]);
    expect(shape(parsed(bom).messages)).toEqual(expected);
  });

  it("strips a BOM before the CSV header", () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture("pc.csv")]);
    expect(parsed(bom).format).toBe("csv");
  });

  it("rejects UTF-16 (with a BOM) as an unsupported encoding", () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("안녕", "utf16le")]);
    expect(failure(utf16)).toBe("unsupported-encoding");
  });

  it("rejects UTF-16 without a BOM (NUL bytes) as an unsupported encoding", () => {
    expect(failure(Buffer.from("2026. 11. 10. 오후 3:00, a : b", "utf16le"))).toBe(
      "unsupported-encoding",
    );
  });

  it("rejects CP949/EUC-KR bytes (invalid UTF-8) as an unsupported encoding", () => {
    // "안녕" in CP949.
    expect(failure(Buffer.from([0xbe, 0xc8, 0xb3, 0xe7]))).toBe("unsupported-encoding");
  });

  it("rejects a zip archive with its own code, so the UI can say to unzip first", () => {
    expect(failure(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe("zip-not-supported");
  });
});

describe("parseKakaoExport — refusals", () => {
  it("refuses an empty file", () => {
    expect(failure(Buffer.alloc(0))).toBe("empty-file");
  });

  it("refuses a file over the byte cap before decoding it", () => {
    expect(failure(Buffer.alloc(KAKAO_MAX_FILE_BYTES + 1, 0x61))).toBe("file-too-large");
  });

  it("names an unknown format instead of guessing (a WhatsApp-style export)", () => {
    expect(failure(fixture("unknown.txt"))).toBe("unknown-format");
  });

  it("says a recognisable KakaoTalk header with no messages has no messages", () => {
    expect(failure(fixture("header-only.txt"))).toBe("no-messages");
  });

  it("refuses more lines than the line cap", () => {
    expect(failure(Buffer.from("\n".repeat(KAKAO_MAX_LINES + 1)))).toBe("too-many-lines");
  });

  it("refuses more distinct speakers than the speaker cap", () => {
    const lines = Array.from(
      { length: KAKAO_MAX_SPEAKERS + 1 },
      (_, i) => `2026. 11. 10. 오후 3:00, 사람${i} : 안녕`,
    );
    expect(failure(Buffer.from(lines.join("\n")))).toBe("too-many-speakers");
  });

  it("does not take an impossible date or hour for a message header", () => {
    const text = [
      "2026. 11. 10. 오후 3:00, 김지수 : 시작",
      "2026. 2. 30. 오후 3:00, 김지수 : 2월 30일",
      "2026. 11. 10. 오후 13:00, 김지수 : 오후 13시",
    ].join("\n");
    const [only, ...rest] = parsed(Buffer.from(text)).messages;
    expect(rest).toEqual([]);
    expect(only.text).toBe(
      "시작\n2026. 2. 30. 오후 3:00, 김지수 : 2월 30일\n2026. 11. 10. 오후 13:00, 김지수 : 오후 13시",
    );
  });
});

describe("parseKakaoExport — message bodies that look like structure", () => {
  it("in a PC export, keeps a bare date line inside a message and the day unchanged", () => {
    const text = [
      "--------------- 2026년 11월 10일 화요일 ---------------",
      "[김지수] [오전 9:05] 일정 공유드려요",
      "2026년 3월 5일 목요일",
      "[이민호] [오전 9:07] 확인했습니다",
    ].join("\n");
    const messages = parsed(Buffer.from(text)).messages;
    expect(messages.map((m) => m.text)).toEqual([
      "일정 공유드려요\n2026년 3월 5일 목요일",
      "확인했습니다",
    ]);
    expect(messages[1].localMs).toBe(wall(2026, 11, 10, 9, 7));
  });

  it("reads '파일: …' as a file placeholder only when a file name follows", () => {
    const text = [
      "2026. 11. 10. 오후 3:00, 김지수 : 파일: 견적서 v2.pdf",
      "2026. 11. 10. 오후 3:01, 김지수 : 파일: 내일까지 보내드릴게요",
    ].join("\n");
    expect(parsed(Buffer.from(text)).messages.map((m) => m.kind)).toEqual(["media", "text"]);
  });

  it("drops zero-width and bidi characters from speaker names", () => {
    const text = "2026. 11. 10. 오후 3:00, 김\u200b지\u202e수 : 안녕\n";
    expect(parsed(Buffer.from(text)).messages[0].speaker).toBe("김지수");
  });

  it("takes exactly the line cap, with or without a final newline", () => {
    // One message, then continuation lines: KAKAO_MAX_LINES lines in all.
    const exact = `2026. 11. 10. 오후 3:00, 김지수 : 안녕\n${"a\n".repeat(KAKAO_MAX_LINES - 1)}`;
    expect(parseKakaoExport(Buffer.from(exact)).ok).toBe(true);
    expect(parseKakaoExport(Buffer.from(exact.slice(0, -1))).ok).toBe(true);
    expect(failure(Buffer.from(`${exact}a\n`))).toBe("too-many-lines");
  });
});

describe("parseKakaoExport — caps", () => {
  it("caps a message's text, however many continuation lines follow", () => {
    const body = Array.from({ length: 2000 }, () => "계속되는 줄입니다").join("\n");
    const text = `2026. 11. 10. 오후 3:00, 김지수 : 시작\n${body}`;
    const [message] = parsed(Buffer.from(text)).messages;
    expect(message.text.length).toBeLessThanOrEqual(KAKAO_MAX_MESSAGE_CHARS);
    expect(message.text.startsWith("시작\n계속되는 줄입니다")).toBe(true);
  });

  it("caps one enormous line and keeps parsing the lines after it", () => {
    const huge = "가".repeat(200_000);
    const text = `2026. 11. 10. 오후 3:00, 김지수 : ${huge}\n2026. 11. 10. 오후 3:01, 이민호 : 다음`;
    const messages = parsed(Buffer.from(text)).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].text.length).toBeLessThanOrEqual(KAKAO_MAX_MESSAGE_CHARS);
    expect(messages[1].text).toBe("다음");
  });

  it("drops control characters from speaker names and text", () => {
    const text = "2026. 11. 10. 오후 3:00, 김\u0007지수 : 보내\u001bㄹ게요\n";
    const [message] = parsed(Buffer.from(text)).messages;
    expect(message.speaker).toBe("김지수");
    expect(message.text).toBe("보내ㄹ게요");
  });
});
