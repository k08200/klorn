import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  extractAttachmentContent,
  inflateRawCapped,
  isReadableEmailAttachment,
} from "../mail/email-attachment-text.js";

describe("inflateRawCapped — decompression-bomb guard", () => {
  it("inflates a normal stream back to the original", () => {
    const original = Buffer.from("hello klorn ".repeat(50));
    expect(inflateRawCapped(deflateRawSync(original)).equals(original)).toBe(true);
  });

  it("inflates a payload just under the 8MB budget", () => {
    const under = Buffer.alloc(7_000_000, 0x41);
    expect(inflateRawCapped(deflateRawSync(under)).length).toBe(7_000_000);
  });

  it("throws instead of allocating gigabytes for a zip bomb over the budget", () => {
    // ~9MB of zeros compresses to a few KB but would inflate past the cap.
    const bomb = deflateRawSync(Buffer.alloc(9_000_000, 0));
    expect(() => inflateRawCapped(bomb)).toThrow();
  });
});

describe("email attachment text extraction", () => {
  it("extracts plain text attachments", () => {
    const result = extractAttachmentContent(
      Buffer.from("홍길동\n이메일: actor@example.com\n키: 178cm"),
      "profile.txt",
      "text/plain",
    );

    expect(result.status).toBe("readable");
    expect(result.text).toContain("홍길동");
    expect(result.text).toContain("178cm");
  });

  it("extracts text from docx xml entries", () => {
    const docx = makeZip({
      "word/document.xml":
        "<w:document><w:body><w:p><w:r><w:t>배우 프로필</w:t></w:r></w:p><w:p><w:r><w:t>특기: 액션, 영어</w:t></w:r></w:p></w:body></w:document>",
    });

    const result = extractAttachmentContent(
      docx,
      "actor-profile.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    expect(result.status).toBe("readable");
    expect(result.text).toContain("배우 프로필");
    expect(result.text).toContain("특기");
  });

  it("extracts text from xlsx shared strings", () => {
    const xlsx = makeZip({
      "xl/sharedStrings.xml":
        "<sst><si><t>김하나</t></si><si><t>배우</t></si><si><t>010-1234-5678</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>',
    });

    const result = extractAttachmentContent(
      xlsx,
      "candidate-list.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    expect(result.status).toBe("readable");
    expect(result.text).toContain("김하나");
    expect(result.text).toContain("010-1234-5678");
  });

  it("extracts text from pptx slides", () => {
    const pptx = makeZip({
      "ppt/slides/slide1.xml":
        "<p:sld><p:cSld><a:t>오디션 프로필</a:t><a:t>무용, 영어 가능</a:t></p:cSld></p:sld>",
    });

    const result = extractAttachmentContent(
      pptx,
      "audition-profile.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );

    expect(result.status).toBe("readable");
    expect(result.text).toContain("오디션 프로필");
    expect(result.text).toContain("무용");
  });

  it("extracts text from hwpx sections", () => {
    const hwpx = makeZip({
      "Contents/section0.xml":
        "<hp:sec><hp:p><hp:run><hp:t>이지윤</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>키 165cm / 특기 현대무용</hp:t></hp:run></hp:p></hp:sec>",
    });

    const result = extractAttachmentContent(hwpx, "actor-profile.hwpx", "application/haansofthwpx");

    expect(isReadableEmailAttachment("actor-profile.hwpx", "application/haansofthwpx", 1024)).toBe(
      true,
    );
    expect(result.status).toBe("readable");
    expect(result.text).toContain("이지윤");
    expect(result.text).toContain("현대무용");
  });

  it("recovers readable text from legacy hwp binary payloads", () => {
    const hwp = Buffer.concat([
      Buffer.from("HWP Document File V5\0"),
      Buffer.alloc(32),
      Buffer.from("이름: 박서연\n역할: 배우\n연락처: 010-2222-3333", "utf16le"),
    ]);

    const result = extractAttachmentContent(hwp, "actor-profile.hwp", "application/haansofthwp");

    expect(isReadableEmailAttachment("actor-profile.hwp", "application/haansofthwp", 1024)).toBe(
      true,
    );
    expect(result.status).toBe("readable");
    expect(result.text).toContain("박서연");
    expect(result.text).toContain("010-2222-3333");
  });

  it("keeps image attachments as metadata for later OCR", () => {
    expect(isReadableEmailAttachment("headshot.jpg", "image/jpeg", 1024)).toBe(true);

    const result = extractAttachmentContent(Buffer.from([1, 2, 3]), "headshot.jpg", "image/jpeg");

    expect(result.status).toBe("metadata");
    expect(result.text).toContain("OCR 분석 대기");
    expect(result.text).toContain("headshot.jpg");
  });
});

function makeZip(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const compressed = deflateRawSync(Buffer.from(content));
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(0, 10);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(Buffer.byteLength(content), 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, nameBuffer, compressed);
  }
  return Buffer.concat(chunks);
}
