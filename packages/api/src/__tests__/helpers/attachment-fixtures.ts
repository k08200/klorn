/**
 * Real-looking attachment fixtures for the extractor characterisation tests.
 * Every fixture is built from fixed bytes (no zlib output is pinned, and the
 * "binary" PDF stream comes from a seeded LCG), so the extracted text is the
 * same on every Node/zlib version.
 */
import { deflateRawSync } from "node:zlib";

export interface AttachmentFixture {
  name: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export function makeZip(files: Record<string, string>): Buffer {
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

/** Deterministic pseudo-random bytes, standing in for an image stream. */
export function lcgBytes(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const DOCX_DOCUMENT = `${XML_DECL}<w:document ${W_NS}><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>배우 프로필</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">이름: </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>김하나</w:t></w:r><w:r><w:tab/><w:t>Tom &amp; Jerry &lt;tag&gt; &quot;q&quot; &apos;a&apos;</w:t></w:r></w:p>
<w:p><w:r><w:t>첫 줄</w:t><w:br/><w:t>둘째 줄</w:t><w:br w:type="page"/></w:r></w:p>
<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tr><w:tc><w:p><w:r><w:t>키</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>178cm</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t xml:space="preserve">   spaced    out   </w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;

const DOCX_HEADER = `${XML_DECL}<w:hdr ${W_NS}><w:p><w:r><w:t>Confidential — casting</w:t></w:r></w:p></w:hdr>`;
const DOCX_FOOTER = `${XML_DECL}<w:ftr ${W_NS}><w:p><w:r><w:t>Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:p></w:ftr>`;

/** No <w:t> runs at all, and a trailing unterminated "<" — the tag-strip fallback. */
const DOCX_FALLBACK_DOCUMENT = `${XML_DECL}<w:document ${W_NS}><w:body><w:p><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://klorn.ai" </w:instrText></w:r></w:p><w:p><w:r><w:tab/></w:r></w:p><>plain body words</w:body></w:document> 3 < 5`;

const SST_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const XLSX_SHARED_STRINGS = `${XML_DECL}<sst ${SST_NS} count="4" uniqueCount="4"><si><t>김하나</t></si><si><t>배우</t></si><si><r><rPr><b/><sz val="11"/></rPr><t xml:space="preserve">Rich </t></r><r><t>text &amp; more</t></r></si><si><t>010-1234-5678</t></si></sst>`;
const XLSX_SHEET = `${XML_DECL}<worksheet ${SST_NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>인라인 문자열</t></is></c></row><row r="2"><c r="A2" t="s"><v>3</v></c></row></sheetData></worksheet>`;

const P_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const PPTX_SLIDE_1 = `${XML_DECL}<p:sld ${P_NS}><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="ko-KR"/><a:t>오디션 프로필</a:t></a:r></a:p><a:p><a:r><a:t>무용, 영어 가능</a:t></a:r><a:br/><a:r><a:t>Tom &amp; Jerry</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const PPTX_SLIDE_2 = `${XML_DECL}<p:sld ${P_NS}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>오디션 프로필</a:t></a:r></a:p><a:p><a:r><a:t>  2026-10-14 일정  </a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
/** No text runs: exercises the extractXmlText tag-strip fallback. */
const PPTX_FALLBACK_SLIDE = `${XML_DECL}<p:sld ${P_NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/></p:nvSpPr>plain words &amp; more</p:sp></p:spTree></p:cSld></p:sld>`;

const HWPX_SECTION = `${XML_DECL}<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p id="0"><hp:run charPrIDRef="0"><hp:t>이지윤</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>키 165cm<hp:tab width="4000"/>특기 현대무용</hp:t><hp:t>첫째<hp:lineBreak/>둘째</hp:t></hp:run></hp:p><hp:tbl><hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>셀1 &amp; 셀2</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hs:sec>`;
/** No <hp:t> runs: exercises the hwpx tag-strip fallback and its line split. */
const HWPX_FALLBACK_SECTION = `${XML_DECL}<hs:sec><hp:p><hp:run><hp:ctrl>머리말 텍스트</hp:ctrl></hp:run></hp:p><hp:p><hp:run><hp:ctrl>둘째 문단<hp:br/>셋째</hp:ctrl></hp:run></hp:p></hs:sec>`;

function pdfFixture(): Buffer {
  const content = [
    "BT /F1 12 Tf 72 712 Td (Actor profile for the autumn casting call) Tj ET",
    "BT 72 690 Td (Contact: actor\\(at\\)example.com \\\\ line\\nbreak and\\ttab\\b\\f end) Tj ET",
    "BT 72 670 Td [(Kerned) -250 (array text inside a TJ operator)] TJ ET",
    "BT 72 650 Td (short) Tj ET",
  ].join("\n");
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1"),
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    Buffer.from(
      `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    ),
    Buffer.from("5 0 obj\n<< /Length 600 /Filter /DCTDecode >>\nstream\n"),
    lcgBytes(600, 20261014),
    Buffer.from("\nendstream\nendobj\n"),
    Buffer.from(
      "6 0 obj\n<< /Title (Autumn Casting Profile 2026) /Author (Klorn Test Fixture Author) /Producer (Skia/PDF m120) >>\nendobj\n",
    ),
    Buffer.from(
      "<x:xmpmeta><dc:description>Profile summary for the casting team review</dc:description></x:xmpmeta>\n",
    ),
    Buffer.from("trailer\n<< /Root 1 0 R /Info 6 0 R >>\n%%EOF\n"),
  ]);
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export function characterisationFixtures(): AttachmentFixture[] {
  return [
    {
      name: "docx",
      buffer: makeZip({
        "word/document.xml": DOCX_DOCUMENT,
        "word/header1.xml": DOCX_HEADER,
        "word/footer1.xml": DOCX_FOOTER,
      }),
      filename: "actor-profile.docx",
      mimeType: DOCX_MIME,
    },
    {
      name: "docx tag-strip fallback",
      buffer: makeZip({ "word/document.xml": DOCX_FALLBACK_DOCUMENT }),
      filename: "links.docx",
      mimeType: DOCX_MIME,
    },
    {
      name: "xlsx",
      buffer: makeZip({
        "xl/sharedStrings.xml": XLSX_SHARED_STRINGS,
        "xl/worksheets/sheet1.xml": XLSX_SHEET,
      }),
      filename: "candidate-list.xlsx",
      mimeType: XLSX_MIME,
    },
    {
      name: "pptx",
      buffer: makeZip({
        "ppt/slides/slide1.xml": PPTX_SLIDE_1,
        "ppt/slides/slide2.xml": PPTX_SLIDE_2,
        "ppt/slides/slide3.xml": PPTX_FALLBACK_SLIDE,
      }),
      filename: "audition.pptx",
      mimeType: PPTX_MIME,
    },
    {
      name: "hwpx",
      buffer: makeZip({ "Contents/section0.xml": HWPX_SECTION }),
      filename: "actor-profile.hwpx",
      mimeType: "application/haansofthwpx",
    },
    {
      name: "hwpx tag-strip fallback",
      buffer: makeZip({ "Contents/section0.xml": HWPX_FALLBACK_SECTION }),
      filename: "header-only.hwpx",
      mimeType: "application/haansofthwpx",
    },
    {
      name: "pdf",
      buffer: pdfFixture(),
      filename: "profile.pdf",
      mimeType: "application/pdf",
    },
    {
      name: "html",
      buffer: Buffer.from(
        "<html><body>\r\n<p>Hello &amp; welcome, <b>배우</b> 님</p>\r\n<script>if (a < b) {}</script>\r\n</body></html>\r\n",
      ),
      filename: "invite.html",
      mimeType: "text/html",
    },
    {
      name: "text",
      buffer: Buffer.from("  홍길동\r\n이메일: actor@example.com\u0000\r\n키: 178cm  \r\n"),
      filename: "profile.txt",
      mimeType: "text/plain",
    },
  ];
}
