/**
 * Korean deadline wording. `(?<![가-힣])` keeps short tokens from matching
 * inside longer words (안내일정, 지금일, 설명일); `(?![가-힣])` does the same
 * on the right (3일 내용, 반드시).
 */

import {
  dayInMonth,
  dayOfWeek,
  endOfMonth,
  endOfNamedMonth,
  endOfWeek,
  plusDays,
  upcomingDayOfMonth,
  upcomingWeekday,
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

const DOW: Record<string, number> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };

/**
 * The clock hours each time-of-day word allows, and the offset to 24h.
 * 저녁 / 밤 take evening hours only: "밤 12시", "밤 1시" straddle midnight.
 */
const MERIDIEM: Record<string, { min: number; max: number; add: number }> = {
  오전: { min: 1, max: 11, add: 0 },
  아침: { min: 1, max: 11, add: 0 },
  새벽: { min: 1, max: 11, add: 0 },
  오후: { min: 1, max: 11, add: 12 },
  저녁: { min: 5, max: 11, add: 12 },
  밤: { min: 5, max: 11, add: 12 },
};

/**
 * Hour → 24h. A bare 1–12 hour ("8시") is AM or PM and is never guessed —
 * the autonomous agent prompt's "default to 20:00" is exactly the mistake
 * this refuses. 13–23 is unambiguous 24h time; "오후 12시" is noon.
 */
function hour24(meridiem: string | undefined, hour: number): number | null {
  if (!meridiem) return hour >= 13 && hour <= 23 ? hour : null;
  if (meridiem === "오후" && hour === 12) return 12;
  const range = MERIDIEM[meridiem];
  return range && hour >= range.min && hour <= range.max ? hour + range.add : null;
}

/** "이내", "내로", "안에" … — the "within" suffix of a span. */
const WITHIN = "(?:이내(?:로|에)?|내(?:로|에)?|안에|안으로)(?![가-힣])";

export const KO_RULES: DueRule[] = [
  {
    // Past and recurring days are never a deadline: 지난주 월요일, 어제, 매주 월요일.
    kind: "day",
    re: /(?<![가-힣])(?:지난|저번)\s*(?:주|달|번)?\s*(?:[월화수목금토일]\s*요일)?|(?<![가-힣])(?:어제|그제|그저께|엊그제)|매주\s*(?:[월화수목금토일]\s*요일)?|매일|매달|매월/g,
    standalone: false,
    resolve: never,
  },
  {
    kind: "day",
    re: /(?:(이번|다음)\s*주|(?<![가-힣])(금|차)주)\s*([월화수목금토일])\s*요일/g,
    resolve: (m, now) => {
      const weeksAhead = m[1] === "다음" || m[2] === "차" ? 1 : 0;
      const day = dayOfWeek(now, DOW[m[3]], weeksAhead);
      return day >= now.dateKey ? day : null;
    },
  },
  {
    // 차주에게 / 차주분 is a vehicle owner, not next week.
    kind: "day",
    re: /(?:(이번|다음)\s*주|(?<![가-힣])(금|차)주)(?!에게|께|분)/g,
    resolve: (m, now) => endOfWeek(now, m[1] === "다음" || m[2] === "차" ? 1 : 0),
  },
  { kind: "day", re: /주말/g, resolve: (_m, now) => endOfWeek(now, 0) },
  {
    kind: "day",
    re: /([월화수목금토일])\s*요일/g,
    resolve: (m, now) => upcomingWeekday(now, DOW[m[1]]),
  },
  { kind: "day", re: /(?<![가-힣])(?:오늘|금일)/g, resolve: (_m, now) => plusDays(now, 0) },
  { kind: "day", re: /(?<![가-힣])(?:내일|명일|익일)/g, resolve: (_m, now) => plusDays(now, 1) },
  {
    // 내일모레 is the day after tomorrow, not tomorrow.
    kind: "day",
    re: /(?<![가-힣])(?:내일\s*)?(모레|글피)/g,
    resolve: (m, now) => plusDays(now, m[1] === "모레" ? 2 : 3),
  },
  {
    kind: "day",
    re: /(?:(이번|다음)\s*달|(?<![가-힣])(이달|내달))\s*(\d{1,2})\s*일/g,
    resolve: (m, now) => dayInMonth(now, m[1] === "다음" || m[2] === "내달" ? 1 : 0, int(m[3])),
  },
  {
    kind: "day",
    re: /이번\s*달|(?<![가-힣])(?:이달|금월)|월말/g,
    resolve: (_m, now) => endOfMonth(now, 0),
  },
  {
    kind: "day",
    re: /다음\s*달|(?<![가-힣])(?:내달|익월)/g,
    resolve: (_m, now) => endOfMonth(now, 1),
  },
  {
    kind: "day",
    re: /(?<!\d)(\d{1,2})\s*월\s*말/g,
    resolve: (m, now) => endOfNamedMonth(now, int(m[1])),
  },
  {
    kind: "day",
    re: /(?:(?<!\d)(\d{4})\s*년\s*)?(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일/g,
    resolve: (m, now) => monthDay(now, int(m[2]), int(m[3]), m[1]),
  },
  {
    // "15일까지", "15일에", "15일(금) 오후 3시" — the 15th. Not "3일에 걸쳐" (a span).
    kind: "day",
    re: /(?<!\d)(\d{1,2})\s*일\s*(?:\(\s*[월화수목금토일]\s*\)\s*)?(?:까지|에(?!\s*걸)|(?=\s*(?:오전|오후|아침|저녁|밤|새벽|\d{1,2}\s*시)))/g,
    resolve: (m, now) => upcomingDayOfMonth(now, int(m[1])),
  },
  {
    kind: "time",
    re: /(?:(오전|오후|아침|저녁|밤|새벽)\s*)?(?<!\d)(\d{1,2})\s*시(?!간)(?:\s*(\d{1,2})\s*분|\s*(반)(?![가-힣]))?/g,
    resolve: (m) => hhmm(hour24(m[1], int(m[2])), m[4] ? 30 : m[3] ? int(m[3]) : 0),
  },
  {
    kind: "time",
    re: /오전|오후|아침|저녁|(?<![가-힣])밤|새벽|정오/g,
    resolve: (m) =>
      m[0] === "새벽" ? null : /오전|아침|정오/.test(m[0]) ? END_OF_MORNING : END_OF_DAY,
  },
  {
    kind: "span",
    re: new RegExp(`(?<!\\d)(\\d{1,3})\\s*(시간|일|주)\\s*${WITHIN}`, "g"),
    resolve: (m, now) => spanMs(int(m[1]), m[2], now),
  },
  {
    kind: "span",
    re: new RegExp(`일주일\\s*${WITHIN}`, "g"),
    resolve: (_m, now) => spanMs(7, "일", now),
  },
];
