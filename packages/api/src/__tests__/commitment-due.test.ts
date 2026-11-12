import { describe, expect, it } from "vitest";
import {
  type DueContext,
  findDuePhrase,
  pickDueAt,
  resolveDueText,
} from "../pim/commitment-due.js";
import { extractCommitmentCandidates } from "../pim/commitment-extractor.js";

// 2026-11-12 is a Thursday. 01:00Z = 10:00 in Seoul; 15:00Z = 10:00 in New York (EST).
const SEOUL: DueContext = {
  referenceDate: new Date("2026-11-12T01:00:00.000Z"),
  timeZone: "Asia/Seoul",
};
const NEW_YORK: DueContext = {
  referenceDate: new Date("2026-11-12T15:00:00.000Z"),
  timeZone: "America/New_York",
};

function dueIso(text: string, ctx: DueContext): string | null {
  const out = resolveDueText(text, ctx);
  return out.status === "resolved" ? out.dueAt.toISOString() : null;
}

function statusOf(text: string, ctx: DueContext): string {
  return resolveDueText(text, ctx).status;
}

describe("resolveDueText — Korean", () => {
  it.each([
    ["오늘", "2026-11-12T14:59:00.000Z"],
    ["금일 내", "2026-11-12T14:59:00.000Z"],
    ["내일", "2026-11-13T14:59:00.000Z"],
    ["내일까지", "2026-11-13T14:59:00.000Z"],
    ["모레", "2026-11-14T14:59:00.000Z"],
    ["금요일까지", "2026-11-13T14:59:00.000Z"],
    ["월요일", "2026-11-16T14:59:00.000Z"],
    ["이번 주", "2026-11-15T14:59:00.000Z"],
    ["금주 내", "2026-11-15T14:59:00.000Z"],
    ["다음 주", "2026-11-22T14:59:00.000Z"],
    ["차주", "2026-11-22T14:59:00.000Z"],
    ["이번 주 금요일", "2026-11-13T14:59:00.000Z"],
    ["다음 주 월요일", "2026-11-16T14:59:00.000Z"],
    ["다음 주 월요일 오전 10시", "2026-11-16T01:00:00.000Z"],
    ["내일 오전", "2026-11-13T03:00:00.000Z"],
    ["내일 오후", "2026-11-13T14:59:00.000Z"],
    ["내일 오후 3시", "2026-11-13T06:00:00.000Z"],
    ["내일 오후 3시 반", "2026-11-13T06:30:00.000Z"],
    ["내일 저녁 7시", "2026-11-13T10:00:00.000Z"],
    ["내일 15시", "2026-11-13T06:00:00.000Z"],
    ["오후 3시", "2026-11-12T06:00:00.000Z"],
    ["11월 20일", "2026-11-20T14:59:00.000Z"],
    ["1월 5일", "2027-01-05T14:59:00.000Z"],
    ["15일까지", "2026-11-15T14:59:00.000Z"],
    ["10일까지", "2026-12-10T14:59:00.000Z"],
    ["3일 이내", "2026-11-15T14:59:00.000Z"],
    ["일주일 내", "2026-11-19T14:59:00.000Z"],
    ["2시간 내", "2026-11-12T03:00:00.000Z"],
    ["월말", "2026-11-30T14:59:00.000Z"],
    ["이번 달", "2026-11-30T14:59:00.000Z"],
    ["다음 달", "2026-12-31T14:59:00.000Z"],
    ["12월 말", "2026-12-31T14:59:00.000Z"],
    ["주말", "2026-11-15T14:59:00.000Z"],
    ["내일모레", "2026-11-14T14:59:00.000Z"],
    ["다음 달 15일", "2026-12-15T14:59:00.000Z"],
    ["이번 달 20일", "2026-11-20T14:59:00.000Z"],
    ["15일 오후 3시", "2026-11-15T06:00:00.000Z"],
    ["11/20 오후 3시", "2026-11-20T06:00:00.000Z"],
    ["오후 3시 반", "2026-11-12T06:30:00.000Z"],
  ])("%s → %s", (text, expected) => {
    expect(dueIso(text, SEOUL)).toBe(expected);
  });

  it.each([
    ["8시", "a bare 1–12 hour has no AM/PM — never guessed as 20:00"],
    ["내일 8시", "the date is clear but the hour is not"],
    ["내일 12시", "12시 alone could be noon or midnight"],
    ["목요일", "the reference day's own weekday: today or a week out"],
    ["오전 9시", "a time-only deadline already past at the reference time"],
    ["오늘 오전 9시", "an explicit deadline before the message was sent"],
    ["11월 1일", "a date just past this year, and next year is too far to assume"],
    ["2월 30일", "a calendar date that does not exist"],
    ["내일이나 월요일", "two different dates"],
    ["지난 금요일", "a past day is never a deadline"],
    ["월요일부터 금요일", "a range: its end, not its start, would be the deadline"],
    ["이번 달 10일", "a day of this month that already passed"],
    ["12/1 오후 3시", "12/1 could be December 1 or 12 January"],
  ])("%s is ambiguous (%s)", (text) => {
    expect(statusOf(text, SEOUL)).toBe("ambiguous");
  });

  it.each(["가능한 빨리", "조만간", "평일", ""])("%s is unrecognized", (text) => {
    expect(statusOf(text, SEOUL)).toBe("unrecognized");
  });
});

describe("resolveDueText — English", () => {
  it.each([
    ["EOD", "2026-11-13T04:59:00.000Z"],
    ["end of day", "2026-11-13T04:59:00.000Z"],
    ["today", "2026-11-13T04:59:00.000Z"],
    ["tonight", "2026-11-13T04:59:00.000Z"],
    ["tomorrow", "2026-11-14T04:59:00.000Z"],
    ["EOD tomorrow", "2026-11-14T04:59:00.000Z"],
    ["tomorrow morning", "2026-11-13T17:00:00.000Z"],
    ["tomorrow afternoon", "2026-11-14T04:59:00.000Z"],
    ["tomorrow at 3pm", "2026-11-13T20:00:00.000Z"],
    ["3:30 p.m.", "2026-11-12T20:30:00.000Z"],
    ["17:00", "2026-11-12T22:00:00.000Z"],
    ["noon tomorrow", "2026-11-13T17:00:00.000Z"],
    ["day after tomorrow", "2026-11-15T04:59:00.000Z"],
    ["Friday", "2026-11-14T04:59:00.000Z"],
    ["this Friday", "2026-11-14T04:59:00.000Z"],
    ["Monday", "2026-11-17T04:59:00.000Z"],
    ["end of the week", "2026-11-16T04:59:00.000Z"],
    ["EOW", "2026-11-16T04:59:00.000Z"],
    ["next week", "2026-11-23T04:59:00.000Z"],
    ["end of next week", "2026-11-23T04:59:00.000Z"],
    ["end of the month", "2026-12-01T04:59:00.000Z"],
    ["next month", "2027-01-01T04:59:00.000Z"],
    ["Nov 20", "2026-11-21T04:59:00.000Z"],
    ["November 20th", "2026-11-21T04:59:00.000Z"],
    ["20 November", "2026-11-21T04:59:00.000Z"],
    ["Dec 3, 2026", "2026-12-04T04:59:00.000Z"],
    ["2026-12-03", "2026-12-04T04:59:00.000Z"],
    ["May 5", "2027-05-06T03:59:00.000Z"],
    ["the 15th", "2026-11-16T04:59:00.000Z"],
    ["within 2 days", "2026-11-15T04:59:00.000Z"],
    ["in a week", "2026-11-20T04:59:00.000Z"],
    ["in 3 hours", "2026-11-12T18:00:00.000Z"],
    ["11/15 at 3pm", "2026-11-15T20:00:00.000Z"],
  ])("%s → %s", (text, expected) => {
    expect(dueIso(text, NEW_YORK)).toBe(expected);
  });

  it.each([
    ["8:00", "a bare 1–12 hour has no AM/PM"],
    ["tomorrow at 8:30", "the date is clear but the hour is not"],
    ["12am Friday", "12am could be either end of the day"],
    ["Thursday", "the reference day's own weekday"],
    ["next Friday", "this coming Friday and next week's Friday differ"],
    ["Friday or Monday", "two different dates"],
    ["9am", "a time-only deadline already past"],
    ["12/1 EOD", "12/1 could be December 1 or 12 January"],
    ["24/7", "never a date: no day/month reading is unique"],
    ["last Friday", "a past day"],
    ["every Monday", "a recurring day"],
    ["x".repeat(121), "too long to be a deadline phrase"],
  ])("%s is ambiguous (%s)", (text) => {
    expect(statusOf(text, NEW_YORK)).toBe("ambiguous");
  });

  it.each([
    "ASAP",
    "soon",
    "at 8",
    "within a day or two",
    "may 5 people",
  ])("%s is unrecognized", (text) => {
    expect(statusOf(text, NEW_YORK)).toBe("unrecognized");
  });

  it("resolves 'next Friday' when both readings name the same day", () => {
    // Saturday 2026-11-14: the coming Friday IS next week's Friday.
    const saturday = { referenceDate: new Date("2026-11-14T15:00:00.000Z"), timeZone: "UTC" };
    expect(dueIso("next Friday", saturday)).toBe("2026-11-20T23:59:00.000Z");
  });
});

describe("resolveDueText — timezone edges", () => {
  // 2026-11-13T15:30Z is Saturday 00:30 in Seoul but still Friday 07:30 in Los Angeles.
  const instant = new Date("2026-11-13T15:30:00.000Z");

  it("reads 'tomorrow' from the user's local day, not the server's", () => {
    expect(dueIso("내일", { referenceDate: instant, timeZone: "Asia/Seoul" })).toBe(
      "2026-11-15T14:59:00.000Z",
    );
    expect(dueIso("tomorrow", { referenceDate: instant, timeZone: "America/Los_Angeles" })).toBe(
      "2026-11-15T07:59:00.000Z",
    );
  });

  it("reads weekdays from the user's local day", () => {
    // Seoul is already on Saturday, so "Friday" is ambiguous there only if it is Friday —
    // it is not: the next Friday is 2026-11-20. Los Angeles is still on Friday → ambiguous.
    expect(dueIso("Friday", { referenceDate: instant, timeZone: "Asia/Seoul" })).toBe(
      "2026-11-20T14:59:00.000Z",
    );
    expect(statusOf("Friday", { referenceDate: instant, timeZone: "America/Los_Angeles" })).toBe(
      "ambiguous",
    );
  });

  it("lands end-of-day on the right side of a DST change", () => {
    // New York falls back on Sunday 2026-11-01: end of that day is 23:59 EST (UTC-5).
    const saturday = {
      referenceDate: new Date("2026-10-31T16:00:00.000Z"),
      timeZone: "America/New_York",
    };
    expect(dueIso("tomorrow", saturday)).toBe("2026-11-02T04:59:00.000Z");
    expect(dueIso("today", saturday)).toBe("2026-11-01T03:59:00.000Z");
  });

  it("falls back to the product default zone for an unknown zone", () => {
    expect(dueIso("내일", { referenceDate: SEOUL.referenceDate, timeZone: "Not/AZone" })).toBe(
      "2026-11-13T14:59:00.000Z",
    );
  });
});

describe("findDuePhrase", () => {
  it.each([
    ["안녕하세요, 자료는 내일까지 보내드릴게요.", "내일"],
    ["민수님이 다음 주 월요일에 견적서를 보내주신다고 했어요.", "다음 주 월요일"],
    ["다음 주 월요일 오전 10시까지 공유드릴게요", "다음 주 월요일 오전 10시"],
    ["8시까지 보내드릴게요", "8시"],
    ["I'll send the deck by end of week.", "end of week"],
    ["I'll get back to you by EOD.", "EOD"],
    ["Sarah will send the contract tomorrow afternoon.", "tomorrow afternoon"],
    ["I'll send it tomorrow at 3pm.", "tomorrow at 3pm"],
    ["I'll review it by Friday, November 20.", "Friday, November 20"],
    ["I'll send it by Friday or Monday", "Friday or Monday"],
    ["월요일부터 금요일까지 정리해드릴게요", "월요일부터 금요일"],
    ["11/15(일) 오후 3시까지 보내드릴게요", "11/15(일) 오후 3시"],
    ["As I said yesterday, I'll send it tomorrow", "tomorrow"],
    ["I'll send it within 2 days", "within 2 days"],
  ])("%s → %s", (text, expected) => {
    expect(findDuePhrase(text)).toBe(expected);
  });

  it.each([
    "I'll send it soon.",
    "I'll call you in a minute.",
    "We will review the 2시간짜리 회의록", // "2시간" is not "2시"
    "They may 5 people join.",
    "As I mentioned last Friday, I will send the doc",
    "지난주 월요일 회의에서 말씀드린 자료 보내드릴게요",
    "매주 월요일 보고서 공유드릴게요",
    "3일 내용 정리해서 보내드릴게요",
    "차주에게 연락드릴게요",
    "I'll send 3/4 of the files",
    "I'll be on call 24/7",
  ])("finds nothing in %s", (text) => {
    expect(findDuePhrase(text)).toBeNull();
  });
});

describe("pickDueAt", () => {
  const llmDate = new Date("2026-11-14T00:00:00.000Z");

  it("prefers the deterministic reading over the LLM's date", () => {
    expect(pickDueAt("내일", llmDate, SEOUL)?.toISOString()).toBe("2026-11-13T14:59:00.000Z");
  });

  it("lets ambiguous wording veto the LLM's guess", () => {
    expect(pickDueAt("8시", new Date("2026-11-12T11:00:00.000Z"), SEOUL)).toBeNull();
  });

  it("falls back to a plausible LLM date only for wording it does not recognize", () => {
    expect(pickDueAt("after the board meeting", llmDate, SEOUL)?.toISOString()).toBe(
      llmDate.toISOString(),
    );
    expect(pickDueAt("after the board meeting", new Date("2026-11-01T00:00:00.000Z"), SEOUL)).toBe(
      null,
    );
    expect(pickDueAt("after the board meeting", new Date("2030-01-01T00:00:00.000Z"), SEOUL)).toBe(
      null,
    );
  });

  it("returns null without wording", () => {
    expect(pickDueAt(null, llmDate, SEOUL)).toBeNull();
    expect(pickDueAt(null, null, SEOUL)).toBeNull();
  });
});

describe("extractor → resolver, end to end", () => {
  function dueOf(text: string, ctx: DueContext): string | null {
    const [candidate] = extractCommitmentCandidates(text);
    if (!candidate?.dueHint) return null;
    return dueIso(candidate.dueHint, ctx);
  }

  it.each([
    ["15일 오후 3시에 보내드릴게요", "2026-11-15T06:00:00.000Z"],
    ["11/15(일) 오후 3시까지 보내드릴게요", "2026-11-15T06:00:00.000Z"],
    ["오후 3시 반드시 보내드릴게요", "2026-11-12T06:00:00.000Z"],
    ["내일모레까지 보내드릴게요", "2026-11-14T14:59:00.000Z"],
  ])("%s → %s (Seoul)", (text, expected) => {
    expect(dueOf(text, SEOUL)).toBe(expected);
  });

  it.each([
    ["I'll send it by 11/15 at 3pm", "2026-11-15T20:00:00.000Z"],
    ["I'll send it by 12/1 EOD", null],
    ["I'll send the doc tomorrow — as I mentioned last Friday", "2026-11-14T04:59:00.000Z"],
  ])("%s → %s (New York)", (text, expected) => {
    expect(dueOf(text, NEW_YORK)).toBe(expected);
  });
});

describe("week boundaries", () => {
  // Sunday 2026-11-15, 10:00 in Seoul — the last day of the Monday-start week.
  const sunday = { referenceDate: new Date("2026-11-15T01:00:00.000Z"), timeZone: "Asia/Seoul" };

  it.each([
    ["이번 주", "2026-11-15T14:59:00.000Z"],
    ["다음 주", "2026-11-22T14:59:00.000Z"],
    ["다음 주 월요일", "2026-11-16T14:59:00.000Z"],
    ["월요일", "2026-11-16T14:59:00.000Z"],
  ])("%s on a Sunday → %s", (text, expected) => {
    expect(dueIso(text, sunday)).toBe(expected);
  });

  it("treats this week's already-past Monday as ambiguous", () => {
    expect(statusOf("이번 주 월요일", sunday)).toBe("ambiguous");
  });
});
