/**
 * "Later" (나중에) presets → the instant POST /api/inbox/firewall/:id/snooze
 * takes. Device-local wall-clock times; pure (now injected) so the presets are
 * pinned by tests. The server refuses a time that is not in the future, so a
 * preset that would land in the past rolls to the next day.
 */

export type SnoozePreset =
  | "laterToday"
  | "thisEvening"
  | "tomorrowMorning"
  | "weekend"
  | "nextWeek";

export const SNOOZE_PRESETS: readonly SnoozePreset[] = [
  "laterToday",
  "thisEvening",
  "tomorrowMorning",
  "weekend",
  "nextWeek",
];

const HOUR = 60 * 60 * 1000;

function at(base: Date, dayOffset: number, hour: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** When a preset fires, or null when it makes no sense now (e.g. "this evening" after 17:00). */
export function snoozeTime(preset: SnoozePreset, now: Date): Date | null {
  switch (preset) {
    case "laterToday": {
      // Three hours on, rounded up to the hour; only while it is still today.
      const d = new Date(now.getTime() + 3 * HOUR);
      if (d.getMinutes() || d.getSeconds() || d.getMilliseconds()) {
        d.setHours(d.getHours() + 1, 0, 0, 0);
      }
      return d.getDate() === now.getDate() && d.getHours() <= 21 ? d : null;
    }
    case "thisEvening":
      return now.getHours() < 17 ? at(now, 0, 18) : null;
    case "tomorrowMorning":
      return at(now, 1, 9);
    case "weekend": {
      // Saturday 09:00; on a Saturday morning before 9 that is today, else next Saturday.
      const day = now.getDay();
      const offset = (6 - day + 7) % 7;
      const candidate = at(now, offset, 9);
      return candidate.getTime() > now.getTime() ? candidate : at(now, offset + 7, 9);
    }
    case "nextWeek": {
      // Next Monday 09:00 (never today).
      const day = now.getDay();
      const offset = (1 - day + 7) % 7 || 7;
      return at(now, offset, 9);
    }
  }
}

/**
 * The presets that make sense now, with their times. Two presets that land on
 * the same instant (on a Friday, "tomorrow morning" is "this weekend") show once.
 */
export function snoozeOptions(now: Date): Array<{ preset: SnoozePreset; until: Date }> {
  const seen = new Set<number>();
  return SNOOZE_PRESETS.flatMap((preset) => {
    const until = snoozeTime(preset, now);
    if (!until || until.getTime() <= now.getTime() || seen.has(until.getTime())) return [];
    seen.add(until.getTime());
    return [{ preset, until }];
  });
}
