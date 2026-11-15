/**
 * CPU-time guards for the KakaoTalk export parser on hostile input
 * (#1414 / #1466 / #1534 class: superlinear work on untrusted text stalls the
 * event loop). CPU time via process.cpuUsage, best of several runs — never
 * wall time (helpers/linear-timing.ts).
 */

import { describe, expect, it } from "vitest";
import { KAKAO_MAX_FILE_BYTES, parseKakaoExport } from "../kakao-import/parse.js";
import { expectLinear, fastestCpuMs, repeatTo } from "./helpers/linear-timing.js";

const run = (input: string) => parseKakaoExport(Buffer.from(input, "utf8"));

/** A whole max-size file of the worst shape still parses within this. */
const FULL_FILE_BUDGET_MS = 1500;

const HEAD = "2026. 11. 10. 오후 3:00, 김지수 : 시작\n";

/** `prefix` then whole copies of `unit` up to the byte cap (no character cut in half). */
function maxSizeFile(unit: string, prefix = ""): Buffer {
  const room = KAKAO_MAX_FILE_BYTES - Buffer.byteLength(prefix, "utf8");
  return Buffer.from(prefix + unit.repeat(Math.floor(room / Buffer.byteLength(unit, "utf8"))));
}

const PC_HEAD =
  "--------------- 2026년 11월 10일 화요일 ---------------\n[김지수] [오전 9:05] 시작\n";

/**
 * Shapes that make a naive parser backtrack or rescan, each after a first
 * message that locks the format, so the whole body runs through the main loop.
 */
const HOSTILE_UNITS: ReadonlyArray<[string, string, string]> = [
  // Message heads with no ' : ' — every line probes the speaker window.
  [
    "near-miss heads",
    "2026. 11. 10. 오후 3:00, 가나다라마바사아자차카타파하가나다라마바사아자\n",
    HEAD,
  ],
  // Brackets that never close into a PC head.
  ["open brackets", "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[\n", PC_HEAD],
  // Bracketed speakers whose time never parses.
  ["bracket near-misses", "[김지수] [오전 9:0x] 내용\n", PC_HEAD],
  // Dash runs that look like the start of a PC date separator.
  ["dash runs", `${"- ".repeat(60)}\n`, PC_HEAD],
  // Korean date prefixes that never reach a time.
  ["date prefixes", "2026년 11월 10일 2026년 11월 10일 2026년 11월 10일\n", HEAD],
  // Continuation lines of one message, far past its cap.
  ["continuations", "계속되는 줄입니다 계속되는 줄입니다\n", HEAD],
];

describe("parseKakaoExport — linear on hostile input", () => {
  it.each(
    HOSTILE_UNITS,
  )("%s: doubling the input at most ~doubles the CPU time", (_, unit, prefix) => {
    expectLinear((bytes) => repeatTo(bytes, unit, prefix), run);
  });

  it("an unclosed CSV quote running to the end of the file", () => {
    const prefix = 'Date,User,Message\n2026-11-10 09:05:12,"a","';
    expectLinear((bytes) => repeatTo(bytes, '가나다,"" x\n', prefix), run);
  });

  it("near-miss heads before any message: refused once detection gives up", () => {
    const bytes = maxSizeFile(HOSTILE_UNITS[0][1]);
    expect(parseKakaoExport(bytes)).toEqual({ ok: false, code: "unknown-format" });
    expect(fastestCpuMs(() => parseKakaoExport(bytes), 3)).toBeLessThan(FULL_FILE_BUDGET_MS);
  });

  it("one line with no newline at all", () => {
    expectLinear((bytes) => repeatTo(bytes, "가나다라 ", HEAD), run);
  });

  it("a max-size file of near-miss heads parses within the CPU budget", () => {
    const [, unit, prefix] = HOSTILE_UNITS[0];
    const bytes = maxSizeFile(unit, prefix);
    const result = parseKakaoExport(bytes);
    expect(result.ok && result.messages.length).toBe(1);
    expect(fastestCpuMs(() => parseKakaoExport(bytes), 3)).toBeLessThan(FULL_FILE_BUDGET_MS);
  });

  it("a max-size file of real messages parses within the CPU budget", () => {
    const bytes = maxSizeFile("2026. 11. 10. 오후 3:00, 김지수 : 내일까지 자료 보내드릴게요\n");
    expect(parseKakaoExport(bytes).ok).toBe(true);
    expect(fastestCpuMs(() => parseKakaoExport(bytes), 3)).toBeLessThan(FULL_FILE_BUDGET_MS);
  });
});
