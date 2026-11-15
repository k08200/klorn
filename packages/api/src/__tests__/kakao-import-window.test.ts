import { describe, expect, it } from "vitest";
import type { KakaoMessage } from "../kakao-import/parse.js";
import {
  KAKAO_MAX_WINDOW_MESSAGES,
  KAKAO_WINDOW_DAYS,
  kakaoWindow,
  previewKakaoExport,
  selectWindowMessages,
} from "../kakao-import/window.js";
import { fastestCpuMs } from "./helpers/linear-timing.js";

const NOW = new Date("2026-11-15T03:00:00.000Z"); // 12:00 in Seoul
/** Windowing a max-size export (after parsing) stays well under this. */
const WINDOW_BUDGET_MS = 600;
const DAY_MS = 86_400_000;

function message(
  localMs: number,
  speaker: string,
  text = "내일까지 보내드릴게요",
  kind: KakaoMessage["kind"] = "text",
): KakaoMessage {
  return { localMs, speaker, kind, text };
}

/** The Seoul wall clock (as Date.UTC writes it) `msAgo` before NOW. */
const seoulWall = (msAgo: number) => NOW.getTime() + 9 * 3_600_000 - msAgo;

describe("kakaoWindow", () => {
  it(`spans the last ${KAKAO_WINDOW_DAYS} days, plus a day for a phone clock running ahead`, () => {
    const window = kakaoWindow(NOW);
    expect(window.start.getTime()).toBe(NOW.getTime() - KAKAO_WINDOW_DAYS * DAY_MS);
    expect(window.end.getTime()).toBe(NOW.getTime() + DAY_MS);
  });
});

describe("selectWindowMessages", () => {
  const window = kakaoWindow(NOW);

  it("reads the printed wall clock in the user's zone", () => {
    const [kept] = selectWindowMessages(
      [message(Date.UTC(2026, 10, 14, 9, 0), "김지수")],
      "Asia/Seoul",
      window,
    );
    expect(kept.sentAt.toISOString()).toBe("2026-11-14T00:00:00.000Z");
  });

  it("keeps only text messages inside the window, oldest first", () => {
    const messages = [
      message(seoulWall(1000), "b", "kept 2"),
      message(seoulWall(40 * DAY_MS), "a", "too old"),
      message(seoulWall(2 * DAY_MS), "a", "kept 1"),
      message(seoulWall(DAY_MS), "b", "사진", "media"),
      message(seoulWall(DAY_MS), "b", "삭제된 메시지입니다.", "deleted"),
      message(seoulWall(-2 * DAY_MS), "b", "future"),
    ];
    expect(selectWindowMessages(messages, "Asia/Seoul", window).map((m) => m.text)).toEqual([
      "kept 1",
      "kept 2",
    ]);
  });

  it(`keeps the most recent ${KAKAO_MAX_WINDOW_MESSAGES} when the window holds more`, () => {
    const messages = Array.from({ length: KAKAO_MAX_WINDOW_MESSAGES + 5 }, (_, i) =>
      message(seoulWall(DAY_MS - i * 1000), "a", `m${i}`),
    );
    const kept = selectWindowMessages(messages, "Asia/Seoul", window);
    expect(kept).toHaveLength(KAKAO_MAX_WINDOW_MESSAGES);
    expect(kept[0].text).toBe("m5");
    expect(kept.at(-1)?.text).toBe(`m${KAKAO_MAX_WINDOW_MESSAGES + 4}`);
  });
});

describe("previewKakaoExport", () => {
  it("counts each speaker's messages overall and in the processed window, busiest first", () => {
    const messages = [
      message(seoulWall(60 * DAY_MS), "이민호"),
      message(seoulWall(60 * DAY_MS), "김지수"),
      message(seoulWall(3 * DAY_MS), "김지수"),
      message(seoulWall(2 * DAY_MS), "김지수", "사진", "media"),
      message(seoulWall(DAY_MS), "박서연"),
      message(seoulWall(DAY_MS), "김지수"),
    ];
    const preview = previewKakaoExport("mobile-dotted", messages, "Asia/Seoul", kakaoWindow(NOW));
    expect(preview).toEqual({
      format: "mobile-dotted",
      totalMessages: 6,
      windowMessages: 3,
      windowTruncated: false,
      speakers: [
        { name: "김지수", total: 4, inWindow: 2 },
        { name: "박서연", total: 1, inWindow: 1 },
        { name: "이민호", total: 1, inWindow: 0 },
      ],
      firstAt: new Date(NOW.getTime() - 60 * DAY_MS).toISOString(),
      lastAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
      windowStart: kakaoWindow(NOW).start.toISOString(),
      windowEnd: kakaoWindow(NOW).end.toISOString(),
      windowDays: KAKAO_WINDOW_DAYS,
    });
  });
});

describe("windowing cost (no per-message zone conversion)", () => {
  const SEOUL_OFFSET_MS = 9 * 3_600_000;
  const MESSAGES = 180_000;

  function messagesEvery(stepMs: number, endWallMs: number): KakaoMessage[] {
    return Array.from({ length: MESSAGES }, (_, i) =>
      message(endWallMs - (MESSAGES - i) * stepMs, i % 2 === 0 ? "김지수" : "이민호"),
    );
  }

  const nowWall = NOW.getTime() + SEOUL_OFFSET_MS;
  const cases: Array<[string, KakaoMessage[]]> = [
    ["all inside the window", messagesEvery(10_000, nowWall)],
    ["spread over five years", messagesEvery(15 * 60_000, nowWall)],
  ];

  it.each(cases)("previews and selects %s within the CPU budget", (_, messages) => {
    const window = kakaoWindow(NOW);
    const run = () => {
      previewKakaoExport("mobile-dotted", messages, "Asia/Seoul", window);
      selectWindowMessages(messages, "Asia/Seoul", window);
    };
    expect(fastestCpuMs(run, 3)).toBeLessThan(WINDOW_BUDGET_MS);
  });

  it("converts across a daylight-saving change exactly", () => {
    // America/New_York fell back at 2026-11-01 02:00 local (06:00Z → 01:00 EST).
    const before = message(Date.UTC(2026, 10, 1, 0, 30), "a");
    const after = message(Date.UTC(2026, 10, 1, 3, 30), "a");
    const at = new Date("2026-11-02T00:00:00.000Z");
    const [first, second] = selectWindowMessages(
      [before, after],
      "America/New_York",
      kakaoWindow(at),
    );
    expect(first.sentAt.toISOString()).toBe("2026-11-01T04:30:00.000Z");
    expect(second.sentAt.toISOString()).toBe("2026-11-01T08:30:00.000Z");
  });
});
