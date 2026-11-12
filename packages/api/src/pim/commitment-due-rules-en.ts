/** English deadline wording. */

import {
  dayOfWeek,
  endOfMonth,
  endOfWeek,
  type LocalNow,
  plusDays,
  upcomingDayOfMonth,
  upcomingWeekday,
  validDateKey,
} from "./commitment-due-calendar.js";
import {
  type DueRule,
  END_OF_DAY,
  END_OF_MORNING,
  hhmm,
  int,
  monthDay,
  never,
  spanMs,
} from "./commitment-due-rule-kit.js";

const WEEKDAY = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const DOW: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAME =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const COUNT_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3 };

/** 12h → 24h. "12am" could be either end of a day: null. */
function hour24(hour: number, meridiem: string): number | null {
  if (hour < 1 || hour > 12) return null;
  if (meridiem.toLowerCase() === "a") return hour === 12 ? null : hour;
  return hour === 12 ? 12 : hour + 12;
}

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

/** "may" is also a modal verb ("may 5 people join"): only a capitalized May is a month. */
function isMonthToken(token: string | undefined): boolean {
  return token !== undefined && (token.toLowerCase() !== "may" || /^M/.test(token));
}

/** "this <weekday>" must still be ahead; "next <weekday>" only when both readings agree. */
function weekday(now: LocalNow, modifier: string | undefined, dow: number): string | null {
  const mod = modifier?.toLowerCase();
  if (mod === "this") {
    const day = dayOfWeek(now, dow, 0);
    return day >= now.dateKey ? day : null;
  }
  if (mod === "next") {
    const coming = upcomingWeekday(now, dow) ?? plusDays(now, 7);
    return coming === dayOfWeek(now, dow, 1) ? coming : null;
  }
  return upcomingWeekday(now, dow);
}

export const EN_RULES: DueRule[] = [
  {
    // Past and recurring days are never a deadline: "last Friday", "every Monday".
    kind: "day",
    re: new RegExp(
      `\\b(?:yesterday|(?:last|past|previous)\\s+(?:week|month|night|${WEEKDAY})|every\\s+(?:day|week|month|${WEEKDAY})|(?:\\d{1,3}|an?|one|two|three)\\s+(?:hours?|days?|weeks?|months?)\\s+ago)\\b`,
      "gi",
    ),
    standalone: false,
    resolve: never,
  },
  { kind: "day", re: /\b(?:today|tonight)\b/gi, resolve: (_m, now) => plusDays(now, 0) },
  { kind: "day", re: /\b(?:tomorrow|tmrw)\b/gi, resolve: (_m, now) => plusDays(now, 1) },
  {
    kind: "day",
    re: /\b(?:the\s+)?day\s+after\s+tomorrow\b/gi,
    resolve: (_m, now) => plusDays(now, 2),
  },
  {
    kind: "day",
    re: new RegExp(`\\b(?:(this|next|coming)\\s+)?(${WEEKDAY})\\b`, "gi"),
    resolve: (m, now) => weekday(now, m[1], DOW[m[2].toLowerCase()]),
  },
  {
    kind: "day",
    re: /\b(?:(?:the\s+)?end\s+of\s+(?:the\s+|this\s+)?week|eow|this\s+week|(?:this\s+)?weekend)\b/gi,
    resolve: (_m, now) => endOfWeek(now, 0),
  },
  {
    kind: "day",
    re: /\b(?:(?:the\s+)?end\s+of\s+next\s+week|next\s+week(?:end)?)\b/gi,
    resolve: (_m, now) => endOfWeek(now, 1),
  },
  {
    kind: "day",
    re: /\b(?:(?:the\s+)?end\s+of\s+(?:the\s+|this\s+)?month|eom|this\s+month)\b/gi,
    resolve: (_m, now) => endOfMonth(now, 0),
  },
  {
    kind: "day",
    re: /\b(?:(?:the\s+)?end\s+of\s+next\s+month|next\s+month)\b/gi,
    resolve: (_m, now) => endOfMonth(now, 1),
  },
  {
    kind: "day",
    re: new RegExp(
      `\\b(${MONTH_NAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`,
      "gi",
    ),
    accept: (m) => isMonthToken(m[1]),
    resolve: (m, now) => monthDay(now, monthIndex(m[1]), int(m[2]), m[3]),
  },
  {
    kind: "day",
    re: new RegExp(
      `\\b(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAME})\\b(?:,?\\s+(\\d{4})\\b)?`,
      "gi",
    ),
    accept: (m) => isMonthToken(m[2]),
    resolve: (m, now) => monthDay(now, monthIndex(m[2]), int(m[1]), m[3]),
  },
  {
    kind: "day",
    re: /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi,
    resolve: (m, now) => upcomingDayOfMonth(now, int(m[1])),
  },
  {
    kind: "day",
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    resolve: (m) => validDateKey(int(m[1]), int(m[2]), int(m[3])),
  },
  {
    kind: "time",
    re: /\b(\d{1,2})(?::(\d{2}))?\s*([ap])(?:\.m\.?|m)(?![a-z])/gi,
    resolve: (m) => hhmm(hour24(int(m[1]), m[3]), m[2] ? int(m[2]) : 0),
  },
  {
    // 24h only from 13:00; "8:00" is AM or PM.
    kind: "time",
    re: /\b(\d{1,2}):(\d{2})\b(?!\s*[ap]\.?m)/gi,
    resolve: (m) => {
      const hour = int(m[1]);
      return hhmm(hour >= 13 && hour <= 23 ? hour : null, int(m[2]));
    },
  },
  { kind: "time", re: /\b(?:noon|midday)\b/gi, resolve: () => END_OF_MORNING },
  {
    kind: "time",
    re: /\b(?:eod|cob|eob|end\s+of\s+(?:the\s+)?(?:business\s+)?day|close\s+of\s+business)\b/gi,
    resolve: () => END_OF_DAY,
  },
  {
    kind: "time",
    re: /\b(?:this\s+)?(morning|afternoon|evening|night)\b/gi,
    resolve: (m) => (m[1].toLowerCase() === "morning" ? END_OF_MORNING : END_OF_DAY),
  },
  {
    kind: "span",
    re: /\b(?:within|in)\s+(?:the\s+next\s+)?(\d{1,3}|an?|one|two|three)\s+(hours?|hrs?|days?|weeks?)\b(?!\s+or\b)/gi,
    resolve: (m, now) => spanMs(COUNT_WORDS[m[1].toLowerCase()] ?? int(m[1]), m[2], now),
  },
];
