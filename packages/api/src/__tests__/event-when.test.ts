/**
 * "Add to calendar" reads the date and the clock time out of a mail with the
 * Commitment Ledger's deterministic rules (commitment-due.ts, #1717). Wording
 * that cannot be read without guessing becomes a question for the user — never
 * a guessed value. A bare 1–12 hour ("3시", "8:00") asks AM or PM.
 */

import { describe, expect, it } from "vitest";
import { findDueSpans } from "../pim/commitment-due.js";
import {
  eventTitleFromSubject,
  quoteAround,
  readEventWhen,
  withClockContext,
} from "../pim/event-when.js";

// Thursday 2026-11-12, 10:00 in Seoul.
const CTX = { referenceDate: new Date("2026-11-12T01:00:00Z"), timeZone: "Asia/Seoul" };

describe("readEventWhen", () => {
  it("reads an explicit day and a clock time with its meridiem", () => {
    expect(readEventWhen("내일 오후 3시", CTX)).toEqual({
      date: "2026-11-13",
      time: "15:00",
      question: null,
    });
    expect(readEventWhen("tomorrow at 3pm", CTX)).toEqual({
      date: "2026-11-13",
      time: "15:00",
      question: null,
    });
  });

  it("reads a 24-hour clock without asking", () => {
    expect(readEventWhen("Friday 15:00", CTX)).toEqual({
      date: "2026-11-13",
      time: "15:00",
      question: null,
    });
  });

  it("asks AM or PM for a bare Korean hour instead of guessing", () => {
    expect(readEventWhen("내일 3시", CTX)).toEqual({
      date: "2026-11-13",
      time: null,
      question: { kind: "meridiem", am: "03:00", pm: "15:00" },
    });
    expect(readEventWhen("내일 3시 반", CTX)).toEqual({
      date: "2026-11-13",
      time: null,
      question: { kind: "meridiem", am: "03:30", pm: "15:30" },
    });
  });

  it("asks AM or PM for a bare English h:mm", () => {
    expect(readEventWhen("tomorrow at 8:00", CTX)).toEqual({
      date: "2026-11-13",
      time: null,
      question: { kind: "meridiem", am: "08:00", pm: "20:00" },
    });
  });

  it("maps twelve o'clock to midnight or noon", () => {
    expect(readEventWhen("내일 12시", CTX).question).toEqual({
      kind: "meridiem",
      am: "00:00",
      pm: "12:00",
    });
  });

  it("asks for the time when the mail names only a day or a part of the day", () => {
    expect(readEventWhen("다음 주 월요일", CTX)).toEqual({
      date: "2026-11-16",
      time: null,
      question: { kind: "time" },
    });
    expect(readEventWhen("tomorrow afternoon", CTX)).toEqual({
      date: "2026-11-13",
      time: null,
      question: { kind: "time" },
    });
  });

  it("asks for the day when the mail names only a time", () => {
    expect(readEventWhen("오후 3시", CTX)).toEqual({
      date: null,
      time: "15:00",
      question: { kind: "date" },
    });
  });

  it("reads noon as 12:00", () => {
    expect(readEventWhen("tomorrow at noon", CTX)).toEqual({
      date: "2026-11-13",
      time: "12:00",
      question: null,
    });
  });

  it("asks when for a deadline span, an unreadable phrase, or no phrase", () => {
    const when = { date: null, time: null, question: { kind: "when" } };
    expect(readEventWhen("3일 이내", CTX)).toEqual(when);
    expect(readEventWhen(null, CTX)).toEqual(when);
    expect(readEventWhen("   ", CTX)).toEqual(when);
  });

  it("drops a day whose reading is itself ambiguous (5/6)", () => {
    expect(readEventWhen("5/6 at 3pm", CTX)).toEqual({
      date: null,
      time: "15:00",
      question: { kind: "date" },
    });
  });
});

describe("readEventWhen — more ambiguity", () => {
  it("asks AM or PM even when the day is missing too", () => {
    expect(readEventWhen("3시", CTX)).toEqual({
      date: null,
      time: null,
      question: { kind: "meridiem", am: "03:00", pm: "15:00" },
    });
  });

  it("maps a bare 12:30 to 00:30 or 12:30", () => {
    expect(readEventWhen("tomorrow 12:30", CTX).question).toEqual({
      kind: "meridiem",
      am: "00:30",
      pm: "12:30",
    });
  });

  it("does not pick one end of a joined range", () => {
    expect(readEventWhen("tomorrow 3pm-4pm", CTX)).toEqual({
      date: "2026-11-13",
      time: null,
      question: { kind: "time" },
    });
  });
});

describe("withClockContext", () => {
  /** The reading of the first phrase that names a clock, as the proposal does. */
  function readIn(text: string) {
    const spans = findDueSpans(text);
    const read = spans.map((span) => withClockContext(readEventWhen(span.phrase, CTX), text, span));
    return read;
  }

  it("asks for the time when the clock read is a range's end ('3-4pm')", () => {
    expect(readIn("Friday 3-4pm works")).toEqual([
      { date: "2026-11-13", time: null, question: { kind: "time" } },
      { date: null, time: null, question: { kind: "when" } },
    ]);
  });

  it("asks for the time when the clock is in another zone", () => {
    expect(readIn("tomorrow at 3pm PST")).toEqual([
      { date: "2026-11-13", time: null, question: { kind: "time" } },
    ]);
    expect(readIn("tomorrow at 3pm pst")).toEqual([
      { date: "2026-11-13", time: null, question: { kind: "time" } },
    ]);
    expect(readIn("tomorrow at 15:00 (UTC+1)")).toEqual([
      { date: "2026-11-13", time: null, question: { kind: "time" } },
    ]);
  });

  it("asks for the time when a Korean range ends in a bare hour ('3-4시')", () => {
    expect(readIn("내일 오후 3-4시 회의")[0]).toEqual({
      date: "2026-11-13",
      time: null,
      question: { kind: "time" },
    });
  });

  it("keeps a plain clock time", () => {
    expect(readIn("tomorrow at 3pm, see you")).toEqual([
      { date: "2026-11-13", time: "15:00", question: null },
    ]);
    // A word after the time is not a zone just for ending in "t".
    expect(readIn("tomorrow at 3pm next to the cafe")[0]).toEqual({
      date: "2026-11-13",
      time: "15:00",
      question: null,
    });
  });
});

describe("quoteAround", () => {
  it("quotes the sentence at the given offset when the phrase repeats", () => {
    const text = "Not tomorrow. Meet tomorrow at the cafe.";
    expect(quoteAround(text, "tomorrow", text.lastIndexOf("tomorrow"))).toBe(
      "Meet tomorrow at the cafe.",
    );
    expect(quoteAround(text, "tomorrow")).toBe("Not tomorrow.");
  });

  it("quotes the sentence that holds the phrase", () => {
    const text = "Hi Kim.\nCan we meet tomorrow at 3pm at the office? Thanks";
    expect(quoteAround(text, "tomorrow at 3pm")).toBe("Can we meet tomorrow at 3pm at the office?");
  });

  it("quotes a Korean sentence", () => {
    const text = "안녕하세요. 내일 오후 3시에 회의 가능하실까요? 감사합니다.";
    expect(quoteAround(text, "내일 오후 3시")).toBe("내일 오후 3시에 회의 가능하실까요?");
  });

  it("caps a long sentence to a window that still holds the phrase", () => {
    const text = `${"a ".repeat(400)}meet tomorrow at 3pm ${"b ".repeat(400)}`;
    const quote = quoteAround(text, "tomorrow at 3pm");
    expect(quote.length).toBeLessThanOrEqual(300);
    expect(quote).toContain("tomorrow at 3pm");
  });

  it("collapses whitespace", () => {
    expect(quoteAround("Lunch   tomorrow\n\nat noon", "tomorrow")).toBe("Lunch tomorrow");
  });
});

describe("eventTitleFromSubject", () => {
  it("strips reply and forward prefixes", () => {
    expect(eventTitleFromSubject("Re: Fwd: Q4 sync")).toBe("Q4 sync");
    expect(eventTitleFromSubject("RE: 회의 일정")).toBe("회의 일정");
    expect(eventTitleFromSubject("  FW:  Budget review ")).toBe("Budget review");
  });

  it("caps the title length", () => {
    expect(eventTitleFromSubject("x".repeat(500)).length).toBe(120);
  });
});
