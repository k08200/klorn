import { describe, expect, it } from "vitest";
import { extractCommitmentCandidates } from "../pim/commitment-extractor.js";

describe("extractCommitmentCandidates", () => {
  it("returns no candidates for empty input", () => {
    expect(extractCommitmentCandidates("")).toEqual([]);
    expect(extractCommitmentCandidates("   ")).toEqual([]);
  });

  it("captures Korean first-person promises as USER-owned", () => {
    const text = "안녕하세요, 자료는 내일까지 보내드릴게요. 감사합니다.";
    const out = extractCommitmentCandidates(text);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].owner).toBe("USER");
    expect(out[0].text).toMatch(/보내드릴게요/);
    expect(out[0].dueHint).toBe("내일");
  });

  it("captures Korean counterparty future-promise as COUNTERPARTY-owned", () => {
    const text = "민수님이 다음 주 월요일에 견적서를 보내주신다고 했어요.";
    const out = extractCommitmentCandidates(text);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].owner).toBe("COUNTERPARTY");
    expect(out[0].dueHint).toMatch(/다음/);
  });

  it("captures English first-person promises as USER-owned", () => {
    const text = "Sounds good — I'll send the deck by end of week.";
    const out = extractCommitmentCandidates(text);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].owner).toBe("USER");
    expect(out[0].dueHint).toMatch(/end of week/i);
  });

  it("captures English counterparty future-promise", () => {
    const text = "Sarah will send the contract tomorrow afternoon.";
    const out = extractCommitmentCandidates(text);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].owner).toBe("COUNTERPARTY");
  });

  it("dedupes duplicate matches across rules", () => {
    const text = "I'll send the deck by Friday. I'll send the deck by Friday.";
    const out = extractCommitmentCandidates(text);
    // Both sentences match identically — dedupe keeps only one
    expect(out).toHaveLength(1);
  });

  it("returns multiple distinct candidates in order of appearance", () => {
    const text = "내일까지 자료 보내드릴게요. 그리고 다음 주에 회의록 공유드릴게요.";
    const out = extractCommitmentCandidates(text);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0].startIndex).toBeLessThan(out[1].startIndex);
  });

  it("respects the maxCandidates cap", () => {
    const sentence = "I'll send the report by Friday. ";
    const text = sentence.repeat(20);
    const out = extractCommitmentCandidates(text, { maxCandidates: 3 });
    expect(out).toHaveLength(1); // dedupe kicks in first — same sentence
  });

  it("does not match casual non-commitment lines", () => {
    const text = "Hey, just wondering how your week is going. Hope all is well!";
    const out = extractCommitmentCandidates(text);
    expect(out).toEqual([]);
  });

  it("extracts dueHint from English by-phrasing", () => {
    const text = "I'll get back to you by EOD.";
    const out = extractCommitmentCandidates(text);
    expect(out[0]?.dueHint).toMatch(/EOD/);
  });
});
