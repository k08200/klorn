// Phase 0 Samsung-calendar probe (throwaway diagnostics, not a product surface).
//
// Samsung Calendar has no server-side API; the only path is the on-device
// calendar provider (Android CalendarContract / iOS EventKit) via the Capacitor
// plugin. Whether the Samsung-account calendar reliably surfaces through the
// STANDARD provider varies by One UI version, so we must confirm it on a real
// Galaxy BEFORE building any calendar UI on top. This logs every calendar the
// device exposes; check `adb logcat` / the JS console for the output.

import { isNativePlatform } from "./capacitor";

export async function probeDeviceCalendars(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const { CapacitorCalendar } = await import("@ebarooni/capacitor-calendar");

    const perm = await CapacitorCalendar.requestReadOnlyCalendarAccess();
    if (perm.result !== "granted") {
      console.warn(`[CALENDAR-PROBE] Read access not granted (${perm.result})`);
      return;
    }

    const { result: calendars } = await CapacitorCalendar.listCalendars();
    console.log(`[CALENDAR-PROBE] ${calendars.length} device calendar(s):`);
    for (const cal of calendars) {
      console.log(`[CALENDAR-PROBE] •`, JSON.stringify(cal));
    }
  } catch (err) {
    console.error("[CALENDAR-PROBE] Failed to enumerate device calendars:", err);
  }
}
