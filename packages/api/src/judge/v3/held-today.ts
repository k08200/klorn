/**
 * Today's "Held back" read (founder design N2, 2026-11-08): mail the daily
 * interrupt budget held today and that still shows the hold. Read through the
 * QUEUE lane page (`GET /api/email?tier=QUEUE&window=held`, users under the
 * policy only), so the rows, the `v3` blocks and the thread total are the
 * lane page's own. Read-only: nothing here sends or changes anything.
 */

import { Prisma } from "@prisma/client";
import { HELD_WINDOW_MS } from "./ranking.js";

/** The only `window` value for the held read; only Today sends it. */
export const HELD_WINDOW = "held";

const FALLBACK_ZONE = "UTC";
const SECOND_MS = 1000;

interface ZoneClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function isKnownZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch (err) {
    if (err instanceof RangeError) return false;
    throw err;
  }
}

function zoneClock(date: Date, timeZone: string): ZoneClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

/** The zone's offset from UTC at `date`, in milliseconds (east is positive). */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const c = zoneClock(date, timeZone);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return asUtc - Math.floor(date.getTime() / SECOND_MS) * SECOND_MS;
}

/**
 * The instant the user's current local day began. The offset is read twice
 * (near the answer, then at it) so a clock-change day lands right. An unknown
 * zone reads as UTC, like interrupt-budget.ts localDayKey.
 */
export function localDayStart(now: Date, timeZone: string): Date {
  const zone = isKnownZone(timeZone) ? timeZone : FALLBACK_ZONE;
  const { year, month, day } = zoneClock(now, zone);
  const wallClock = Date.UTC(year, month - 1, day);
  const first = wallClock - zoneOffsetMs(new Date(wallClock), zone);
  return new Date(wallClock - zoneOffsetMs(new Date(first), zone));
}

/**
 * The earliest hold Today lists: the start of the user's day, but never
 * further back than HELD_WINDOW_MS (past it a hold no longer shows held).
 */
export function heldTodayCutoff(now: Date, timeZone: string): Date {
  const windowStart = now.getTime() - HELD_WINDOW_MS;
  return new Date(Math.max(localDayStart(now, timeZone).getTime(), windowStart));
}

/** A timestamp parameter in the columns' form (TIMESTAMP(3) holding UTC). */
const utc = (at: Date) => Prisma.sql`(${at}::timestamptz AT TIME ZONE 'UTC')`;

/**
 * The QUEUE lane view's predicate for held-today mail: item-wire.ts
 * isShownHeld (still QUEUE and OPEN, no human or agent lane), held at or after
 * the cutoff. Unlike the ranked order's "held first" it does not ask for a
 * known sender: a stranger's held mail is still held, and Today lists it.
 */
export function heldTodaySql(cutoff: Date): Prisma.Sql {
  return Prisma.sql`AND a."heldAt" IS NOT NULL AND a."heldAt" >= ${utc(cutoff)} AND a."tier" = 'QUEUE' AND a."status" = 'OPEN' AND a."isManualOverride" = false AND a."agentTierSetAt" IS NULL`;
}
