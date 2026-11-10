/**
 * Day shape — the deterministic skeleton of the briefing v2 (2026-08-22).
 * Turns today's timed calendar events into (a) at most three narrative
 * segments ("before 10", "10–13", "after 13") with a busy/free/off kind and
 * (b) an hourly intensity curve for the client sparkline. Pure math, no LLM:
 * the model only WORDS the segments later, it never decides the boundaries,
 * so the day structure can't be hallucinated.
 */

/** Local hours the briefing narrates. Before/after is nobody's workday. */
export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 20;

export interface DayShapeEvent {
  title: string;
  /** Local (user-timezone) fractional start/end hours, e.g. 9.5 = 09:30. */
  startHour: number;
  endHour: number;
}

export interface DaySegment {
  /** Local hour bounds, [startHour, endHour). */
  startHour: number;
  endHour: number;
  kind: "busy" | "free" | "off";
  /** Titles of the events inside a busy segment, in start order. */
  eventTitles: string[];
}

export interface DayShape {
  segments: DaySegment[];
  /** Overlapping-event count per hour, index 0 = DAY_START_HOUR. */
  curve: number[];
  meetingCount: number;
  /** Total free hours inside the day window. */
  freeHours: number;
}

/** Convert an instant to fractional local hours in the user's timezone. */
export function localHour(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return get("hour") + get("minute") / 60;
}

const HOURS = DAY_END_HOUR - DAY_START_HOUR;

/**
 * Build the day's shape from today's timed events. `isOffDay` marks a
 * weekend/holiday with no events at all as "off" rather than "free" — the
 * difference between "you could work" and "you shouldn't".
 */
export function buildDayShape(events: DayShapeEvent[], isOffDay = false): DayShape {
  const curve = new Array<number>(HOURS).fill(0);
  // Zero/negative-duration rows (calendar "notes", bad syncs) are not
  // narratable time and previously left the cluster math with nothing to
  // stand on — filter them with the window check.
  const sorted = [...events]
    .filter(
      (e) => e.endHour > e.startHour && e.endHour > DAY_START_HOUR && e.startHour < DAY_END_HOUR,
    )
    .sort((a, b) => a.startHour - b.startHour);

  for (const event of sorted) {
    const from = Math.max(DAY_START_HOUR, Math.floor(event.startHour));
    const to = Math.min(DAY_END_HOUR, Math.ceil(event.endHour));
    for (let h = from; h < to; h++) curve[h - DAY_START_HOUR]++;
  }

  const freeHours = curve.filter((c) => c === 0).length;

  if (sorted.length === 0) {
    return {
      segments: [
        {
          startHour: DAY_START_HOUR,
          endHour: DAY_END_HOUR,
          kind: isOffDay ? "off" : "free",
          eventTitles: [],
        },
      ],
      curve,
      meetingCount: 0,
      freeHours,
    };
  }

  // Defensive: if the curve somehow stayed all-zero despite events, degrade
  // to the no-events shape instead of indexing into an empty cluster list.
  if (!curve.some((c) => c > 0)) {
    return {
      segments: [
        { startHour: DAY_START_HOUR, endHour: DAY_END_HOUR, kind: "free", eventTitles: [] },
      ],
      curve,
      meetingCount: sorted.length,
      freeHours,
    };
  }

  // Busy clusters: contiguous runs of nonzero hours.
  const clusters: Array<{ start: number; end: number }> = [];
  for (let h = 0; h < HOURS; h++) {
    if (curve[h] === 0) continue;
    const last = clusters[clusters.length - 1];
    if (last && last.end === h + DAY_START_HOUR) {
      clusters[clusters.length - 1] = { ...last, end: h + DAY_START_HOUR + 1 };
    } else {
      clusters.push({ start: h + DAY_START_HOUR, end: h + DAY_START_HOUR + 1 });
    }
  }

  // Narrative boundaries: end of the first cluster, start of the last (when
  // distinct). Everything collapses to at most three segments.
  const first = clusters[0];
  const last = clusters[clusters.length - 1];
  const titlesIn = (from: number, to: number) =>
    sorted.filter((e) => e.startHour < to && e.endHour > from).map((e) => e.title);

  // One cluster: frame it ("free until X, busy X–Y, free after Y"). Two or
  // more: fold the edges into the outer busy segments ("before Y busy,
  // Y–Z open, after Z busy") — the three-column narrative in the briefing.
  const bounds = [
    ...new Set(
      (clusters.length === 1
        ? [DAY_START_HOUR, first.start, first.end, DAY_END_HOUR]
        : [DAY_START_HOUR, first.end, last.start, DAY_END_HOUR]
      ).sort((a, b) => a - b),
    ),
  ];

  const segments: DaySegment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const [from, to] = [bounds[i], bounds[i + 1]];
    if (to <= from) continue;
    const titles = titlesIn(from, to);
    segments.push({
      startHour: from,
      endHour: to,
      kind: titles.length > 0 ? "busy" : "free",
      eventTitles: titles,
    });
  }

  // Merge adjacent same-kind segments (e.g. a day that starts free).
  const merged: DaySegment[] = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === seg.kind) {
      merged[merged.length - 1] = {
        ...prev,
        endHour: seg.endHour,
        eventTitles: [...prev.eventTitles, ...seg.eventTitles],
      };
    } else {
      merged.push(seg);
    }
  }

  // Fold a ≤1h sliver of edge free time into the adjacent busy segment —
  // "before 10" should absorb an 8-9 gap, not narrate it as its own column.
  const foldable = (seg: DaySegment | undefined, neighbor: DaySegment | undefined) =>
    seg?.kind === "free" && seg.endHour - seg.startHour <= 1 && neighbor?.kind === "busy";
  let folded = merged;
  if (foldable(folded[0], folded[1])) {
    folded = [{ ...folded[1], startHour: folded[0].startHour }, ...folded.slice(2)];
  }
  const n = folded.length;
  if (n >= 2 && foldable(folded[n - 1], folded[n - 2])) {
    folded = [...folded.slice(0, n - 2), { ...folded[n - 2], endHour: folded[n - 1].endHour }];
  }

  return { segments: folded, curve, meetingCount: sorted.length, freeHours };
}
