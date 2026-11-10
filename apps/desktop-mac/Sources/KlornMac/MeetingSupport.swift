import Foundation

/// Pure meeting logic: the join-link gate and which meeting gets a
/// "starting soon" banner (AppKit-free, pinned by the self-check harness).

/// The one gate in front of every "join meeting" open. A calendar event's
/// meetingLink is invite data anyone can set (the server takes it from the
/// event's conference data or a regex over its description), so the client only
/// opens an absolute https URL with a host and no userinfo. Anything else gets
/// no join button and is never handed to NSWorkspace: no `http:`, `file:`,
/// `javascript:`, or app schemes such as `zoommtg:`. Mirror of
/// safeMeetingHref in packages/web/src/lib/meeting-link.ts.
enum MeetingLink {
    static func safeURL(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty,
              // Whitespace and control characters are refused, never trimmed.
              !raw.unicodeScalars.contains(where: { $0.value <= 0x20 || $0.value == 0x7F }),
              let parts = URLComponents(string: raw),
              parts.scheme?.lowercased() == "https",
              parts.user == nil, parts.password == nil,
              let host = parts.host, !host.isEmpty
        else { return nil }
        return parts.url
    }
}

/// Which upcoming meeting deserves a "starting soon" banner right now: the
/// EARLIEST timed event whose start is within `leadMinutes` and hasn't been
/// announced yet. Never an all-day event (no meaningful "10 minutes before"
/// for those), never one that already started.
func meetingAlertPlan(
    now: Date,
    events: [CalendarEventWire],
    leadMinutes: Int,
    shown: Set<String>
) -> CalendarEventWire? {
    let lead = TimeInterval(leadMinutes * 60)
    return
        events
        .filter { !$0.allDay && !shown.contains($0.id) }
        .compactMap { event -> (CalendarEventWire, Date)? in
            guard let start = meetingStart(event.startTime) else { return nil }
            return (event, start)
        }
        .filter { _, start in start > now && start.timeIntervalSince(now) <= lead }
        .min { $0.1 < $1.1 }?
        .0
}

/// An event's start as a Date, with or without fractional seconds. Pure.
func meetingStart(_ iso: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: iso) { return date }
    return ISO8601DateFormatter().date(from: iso)
}
