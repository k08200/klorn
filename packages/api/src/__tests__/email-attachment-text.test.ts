import { deflateRawSync, constants as zlibConstants } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  extractAttachmentContent,
  extractUtf16TextChunks,
  inflateRawCapped,
  isReadableEmailAttachment,
} from "../mail/email-attachment-text.js";
import { expectLinear, fastestCpuMs, repeatTo } from "./helpers/linear-timing.js";

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

  it("recovers text from a deflated legacy hwp section, wherever it starts", () => {
    // HWP 5 keeps BodyText sections raw-deflated inside an OLE file, at
    // 64-byte (mini-sector) or 512-byte boundaries.
    const section = deflateRawSync(
      Buffer.from(
        `이름: 김하늘\n역할: 연출\n${"공연 일정과 리허설 메모. ".repeat(400)}`,
        "utf16le",
      ),
    );
    for (const at of [64, 512, 4096, 65_536]) {
      const hwp = Buffer.concat([
        Buffer.from("HWP Document File V5\0"),
        Buffer.alloc(at - 21, 0x01),
        section,
        Buffer.alloc(300, 0x02),
      ]);
      const result = extractAttachmentContent(hwp, "profile.hwp", "application/haansofthwp");
      expect(result.status, `section at ${at}`).toBe("readable");
      expect(result.text, `section at ${at}`).toContain("김하늘");
      expect(result.text, `section at ${at}`).toContain("리허설");
    }
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

describe("email attachment extraction stays linear on crafted attachments", () => {
  const extract = (buffer: Buffer, filename: string, mimeType: string) => () =>
    extractAttachmentContent(buffer, filename, mimeType);
  const zipped = (entry: string, filename: string, mimeType: string) => (xml: string) =>
    extract(makeZip({ [entry]: xml }), filename, mimeType)();

  it("pdf literal-string flood", () => {
    expectLinear(
      (n) => repeatTo(n, "\\(", "%PDF-1.4\n("),
      (raw) => extract(Buffer.from(raw, "latin1"), "x.pdf", "application/pdf")(),
    );
  });

  it("docx text-run, tab and tag-strip floods", () => {
    const docx = zipped(
      "word/document.xml",
      "x.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expectLinear((n) => repeatTo(n, "<w:t>"), docx);
    expectLinear((n) => repeatTo(n, "<w:tab "), docx);
    expectLinear((n) => repeatTo(n, "<"), docx);
  });

  it("xlsx and pptx text-run floods", () => {
    const xlsx = zipped(
      "xl/sharedStrings.xml",
      "x.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const pptx = zipped(
      "ppt/slides/slide1.xml",
      "x.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expectLinear((n) => repeatTo(n, "<t>"), xlsx);
    expectLinear((n) => repeatTo(n, "<"), pptx);
  });

  it("legacy hwp: a flood of empty stored deflate blocks", () => {
    // Each 5-byte block (non-final, stored, LEN 0) is a valid deflate block, so
    // every probe offset used to inflate all the way to the end of the file:
    // 2 MB took 8.7 s (security review, 2026-10-23).
    expectLinear(
      (n) => repeatTo(n, "\u0000\u0000\u0000ÿÿ"),
      (raw) => extract(Buffer.from(raw, "latin1"), "x.hwp", "application/haansofthwp")(),
    );
  });

  it("legacy hwp: a small file of streams that each inflate to megabytes", () => {
    // 7.7 KB of deflate → 7.9 MB of "A", repeated 20 times (155 KB): every
    // probe overflows, so each offset earned a full read — 4.3 s before the
    // full reads shared one output budget.
    const stream = deflateRawSync(Buffer.alloc(7_900_000, 0x41), { level: 9 });
    const unit = Buffer.concat([stream, Buffer.alloc((64 - (stream.length % 64)) % 64, 0xfe)]);
    const file = Buffer.concat(Array.from({ length: 20 }, () => unit));
    expect(fastestCpuMs(() => extract(file, "x.hwp", "application/haansofthwp")())).toBeLessThan(
      1000,
    );
  });

  it("legacy hwp: a flood of tiny streams that each inflate to kilobytes of zeros", () => {
    // 61 bytes of fixed-Huffman deflate → 9 KB of zeros, one at every 64-byte
    // offset: 1 KB of probe input is no bound on its own (4.9 s per MB).
    const unit = deflateRawSync(Buffer.alloc(9_000, 0), {
      strategy: zlibConstants.Z_FIXED,
      level: 9,
    }).toString("latin1");
    const padded = unit + "\u0000".repeat(64 - unit.length);
    expectLinear(
      (n) => repeatTo(n, padded),
      (raw) => extract(Buffer.from(raw, "latin1"), "x.hwp", "application/haansofthwp")(),
    );
  });

  it("hwpx tab, br and closing-tag floods", () => {
    const hwpx = zipped("Contents/section0.xml", "x.hwpx", "application/haansofthwpx");
    expectLinear((n) => repeatTo(n, "<tab", "", "/>"), hwpx);
    expectLinear((n) => repeatTo(n, "<br", "", "/>"), hwpx);
    expectLinear((n) => repeatTo(n, "</"), hwpx);
  });

  it("keeps a fetched body over the 8MB budget as metadata instead of scanning it", () => {
    const result = extractAttachmentContent(
      Buffer.alloc(8_000_001, 0x28),
      "x.pdf",
      "application/pdf",
    );

    expect(result.status).toBe("metadata");
    expect(result.text).toContain("8000001 bytes");
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

describe("extractUtf16TextChunks decodes whole runs (2026-10-24)", () => {
  // The previous implementation, character by character: the reference.
  function previous(buffer: Buffer): string[] {
    const readable = (code: number) =>
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0x20 ||
      (code >= 0x21 && code <= 0x7e) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0x3130 && code <= 0x318f) ||
      (code >= 0x1100 && code <= 0x11ff);
    const push = (chunks: string[], value: string) => {
      const cleaned = value.replace(/\s+/g, " ").trim();
      if (cleaned.length < 6 || !/[가-힣A-Za-z0-9]/.test(cleaned)) return;
      chunks.push(cleaned);
    };
    const chunks: string[] = [];
    for (const offset of [0, 1]) {
      let current = "";
      for (let i = offset; i + 1 < buffer.length; i += 2) {
        const code = buffer.readUInt16LE(i);
        if (readable(code)) current += String.fromCharCode(code);
        else {
          push(chunks, current);
          current = "";
        }
      }
      push(chunks, current);
    }
    return chunks;
  }

  it("matches the character-by-character reference on text, binary and odd lengths", () => {
    const samples = [
      Buffer.from("이름: 박서연\n역할: 배우\n연락처: 010-2222-3333", "utf16le"),
      Buffer.concat([
        Buffer.from([0, 1, 2]),
        Buffer.from("Quarterly plan 2027", "utf16le"),
        Buffer.from([9]),
      ]),
      Buffer.concat([
        Buffer.from("가나다라마바사", "utf16le"),
        Buffer.from([0xff, 0xfe]),
        Buffer.from("ㄱㄴㄷ abc def", "utf16le"),
      ]),
    ];
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    for (let n = 0; n < 200; n++) {
      const bytes = Buffer.alloc(1 + (random() % 400));
      for (let i = 0; i < bytes.length; i++) {
        // Bias toward readable code units so runs actually form.
        bytes[i] =
          random() % 3 === 0 ? random() % 256 : [0x41, 0x00, 0x20, 0xac, 0x31][random() % 5];
      }
      samples.push(bytes);
    }
    for (const sample of samples) {
      expect(extractUtf16TextChunks(sample)).toEqual(previous(sample));
    }
  });
});
