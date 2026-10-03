/**
 * C3 review fix (2026-10-02): the ical.js recurrence guard patches the library's
 * prototype process-wide. It used to do so at import, so the API process was
 * patched even with CALDAV_CALENDAR_ENABLED off. It now installs on the first
 * CalDAV listing, once. Its own file: vitest gives each file a fresh module
 * registry, so nothing else here has listed anything yet.
 */

import ICAL from "ical.js";
import { describe, expect, it, vi } from "vitest";
import { ICLOUD_TIMED } from "../__fixtures__/caldav/ics.js";
// The module main's process loads with the flag off: the CalDAV provider (which
// imports the listing, the expansion and the guard).
import "../pim/calendar-providers/caldav.js";
import { occurrencesInWindow } from "../pim/caldav/ical-events.js";
import { ensureRecurSpinGuard, isRecurSpinGuardInstalled } from "../pim/caldav/ical-recur-guard.js";

vi.mock("../db.js", () => ({ prisma: {}, db: {} }));

type Proto = Record<string, unknown>;
const proto = ICAL.RecurIterator.prototype as unknown as Proto;
const WINDOW = { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-10-31T00:00:00Z") };

describe("the recurrence guard installs lazily", () => {
  it("importing the CalDAV modules leaves ical.js untouched", () => {
    expect(isRecurSpinGuardInstalled()).toBe(false);
    expect((proto.next as { name: string }).name).not.toBe("guardedNext");
    expect((proto.check_contracting_rules as { name: string }).name).not.toBe("guardedCheck");
  });

  it("the first listing installs it, and installing again changes nothing", async () => {
    await occurrencesInWindow([ICLOUD_TIMED], WINDOW, "UTC", { now: () => 0 });
    expect(isRecurSpinGuardInstalled()).toBe(true);
    const next = proto.next;
    const check = proto.check_contracting_rules;
    expect((next as { name: string }).name).toBe("guardedNext");
    ensureRecurSpinGuard();
    ensureRecurSpinGuard();
    expect(proto.next).toBe(next);
    expect(proto.check_contracting_rules).toBe(check);
  });
});
