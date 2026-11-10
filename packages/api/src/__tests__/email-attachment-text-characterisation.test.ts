import { describe, expect, it } from "vitest";
import { extractAttachmentContent } from "../mail/email-attachment-text.js";
import { characterisationFixtures } from "./helpers/attachment-fixtures.js";

/**
 * Output of the regex-based extractor on real-looking fixtures, pinned
 * 2026-10-14 BEFORE the linear-scan rewrite. The rewrite must be byte-identical
 * on these, quirks included: the xlsx text-run pattern treats any tag name that
 * ends in "t" (<sst>, <worksheet>) as a text run, and the PDF heuristic keeps
 * literal strings that come from binary stream bytes.
 */
const PINNED: Record<string, { text: string; status: string }> = {
  docx: {
    text: "배우 프로필이름: 김하나Tom & Jerry <tag> \"q\" 'a'첫 줄둘째 줄키178cm spaced out\nConfidential — casting\nPage",
    status: "readable",
  },
  "docx tag-strip fallback": {
    text: 'HYPERLINK "https://klorn.ai" \n \n<>plain body words 3 < 5',
    status: "readable",
  },
  xlsx: {
    text: '<si><t>김하나\n배우\nRich\ntext & more\n010-1234-5678\n<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>인라인 문자열',
    status: "readable",
  },
  pptx: {
    text: "오디션 프로필\n무용, 영어 가능\nTom & Jerry\n2026-10-14 일정\nplain words & more",
    status: "readable",
  },
  hwpx: {
    text: "이지윤\n키 165cm 특기 현대무용\n첫째 둘째\n셀1 & 셀2",
    status: "readable",
  },
  "hwpx tag-strip fallback": {
    text: "머리말 텍스트\n둘째 문단\n셋째",
    status: "readable",
  },
  pdf: {
    text: 'Actor profile for the autumn casting call\nContact: actor(at)example.com \\ line break and tab end\narray text inside a TJ operator\nßT\u0005Èß8FÂR±Ó\u0013¶óÔ:Å7G¸¡ |Ü{¢Ä·ÆÜß\u0019iªÀ |L}üEØ\u0014\u0002DD\u0019b¬þì\u0012\u0018ã"ä¨q\nAutumn Casting Profile 2026\nKlorn Test Fixture Author\n/Type /Catalog /Pages 2 0 R\nBT /F1 12 Tf 72 712 Td (Actor profile for the autumn casting call) Tj ET\nBT 72 690 Td (Contact: actor\nBT 72 670 Td [(Kerned) -250 (array text inside a TJ operator)] TJ ET\nBT 72 650 Td (short) Tj ET\n/Length 600 /Filter /DCTDecode\n/Title (Autumn Casting Profile 2026) /Author (Klorn Test Fixture Author) /Producer (Skia/PDF m120)\nProfile summary for the casting team review\n/Root 1 0 R /Info 6 0 R',
    status: "readable",
  },
  html: {
    text: "<html><body>\n<p>Hello &amp; welcome, <b>배우</b> 님</p>\n<script>if (a < b) {}</script>\n</body></html>",
    status: "readable",
  },
  text: {
    text: "홍길동\n이메일: actor@example.com\n키: 178cm",
    status: "readable",
  },
};

describe("attachment extraction characterisation (pinned pre-rewrite output)", () => {
  const fixtures = characterisationFixtures();

  it("pins exactly the fixture set", () => {
    expect(fixtures.map((fixture) => fixture.name).sort()).toEqual(Object.keys(PINNED).sort());
  });

  for (const fixture of fixtures) {
    it(`${fixture.name}: extracted text is byte-identical`, () => {
      const result = extractAttachmentContent(fixture.buffer, fixture.filename, fixture.mimeType);
      expect(result).toEqual(PINNED[fixture.name]);
    });
  }
});
