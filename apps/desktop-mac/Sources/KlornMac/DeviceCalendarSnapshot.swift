import CryptoKit
import Foundation

// Step C6 (docs/providers/unified-platform-plan.md): the snapshot of one device
// calendar the user turned on, as PUT /api/device-calendar/sources/:key/window
// takes it. Pure — no EventKit here — so the self-check can build every case;
// DeviceCalendarBridge maps EKEvents into `DeviceEventInput` and sends the result.

/// What the builder needs from one EventKit occurrence. EventKit already expands
/// recurring events inside a `predicateForEvents` range, so each occurrence of a
/// series arrives as its own input sharing the series' `identity`.
struct DeviceEventInput: Sendable, Equatable {
    enum Status: Sendable, Equatable { case none, confirmed, tentative, canceled }

    /// The event's id in its calendar: `calendarItemExternalIdentifier`, falling
    /// back to `calendarItemIdentifier`. Never sent raw (hashed into externalId).
    var identity: String
    /// The ORIGINAL start of a recurring occurrence (`occurrenceDate`), so a moved
    /// occurrence keeps its id; nil for a one-off event.
    var occurrence: Date?
    var title: String
    var start: Date
    var end: Date
    var isAllDay: Bool
    var location: String?
    var url: URL?
    var status: Status
    /// The user is an attendee and declined (EKParticipant.isCurrentUser + .declined).
    var declinedBySelf: Bool
}

struct DeviceEventWire: Encodable, Equatable, Sendable {
    let externalId: String
    let title: String
    let start: String
    let end: String
    let allDay: Bool
    let location: String?
    let meetingLink: String?
    let status: String
}

struct DeviceSnapshotWire: Encodable, Equatable, Sendable {
    let windowStart: String
    let windowEnd: String
    let calendarTitle: String
    let events: [DeviceEventWire]
}

enum DeviceCalendarSnapshot {
    /// The window uploaded: a week back (so today's earlier events and the last
    /// few days stay current) to a month ahead, from the start of today.
    static let windowPastDays = 7
    static let windowFutureDays = 31
    /// The server's caps (pim/device-calendar/device-snapshot.ts), mirrored so a
    /// snapshot is never refused for its size: strings are clamped here.
    static let maxEvents = 500
    static let titleMax = 500
    static let locationMax = 500
    static let calendarTitleMax = 200
    static let meetingLinkMax = 2048

    /// [start of today - 7 days, start of today + 31 days) in the given calendar's zone.
    static func window(now: Date, calendar: Calendar) -> DateInterval {
        let today = calendar.startOfDay(for: now)
        let start = calendar.date(byAdding: .day, value: -windowPastDays, to: today) ?? today
        let end = calendar.date(byAdding: .day, value: windowFutureDays, to: today) ?? today
        return DateInterval(start: start, end: end)
    }

    /// The range EventKit is asked for: one day wider than the window on each side.
    /// An all-day row is stored at UTC midnight of its dates, so east of UTC the
    /// day before the window still overlaps it on the server; asking EventKit for
    /// the local window alone would leave that event out and the server would read
    /// its row as deleted. `build` then keeps what overlaps the window as the
    /// server reads it (C3 widens its CalDAV query the same way).
    static func queryRange(for window: DateInterval) -> DateInterval {
        DateInterval(
            start: window.start.addingTimeInterval(-86_400),
            end: window.end.addingTimeInterval(86_400))
    }

    /// The device-scoped key of a calendar: sha256 of the device id and the EventKit
    /// calendar identifier, lowercase hex. The raw identifier never leaves the Mac,
    /// and the same calendar on two Macs is two sources.
    static func sourceKey(calendarIdentifier: String, deviceId: String) -> String {
        sha256Hex("klorn-device-calendar\n\(deviceId)\n\(calendarIdentifier)")
    }

    /// The row id of one occurrence, hashed: the event's identity, plus the
    /// occurrence's original start for a recurring one.
    static func externalId(identity: String, occurrence: Date?) -> String {
        guard let occurrence else { return sha256Hex(identity) }
        return sha256Hex("\(identity)#\(Int64(occurrence.timeIntervalSince1970.rounded()))")
    }

    /// The snapshot, or nil when no complete one can be made (see `capped`).
    static func build(
        events: [DeviceEventInput], calendarTitle: String, window: DateInterval, timeZone: TimeZone,
        untitled: String
    ) -> DeviceSnapshotWire? {
        var seen = Set<String>()
        let kept = events
            .filter { $0.status != .canceled && !$0.declinedBySelf && !$0.identity.isEmpty }
            .map { input in (input, serverInterval(input, timeZone: timeZone)) }
            .filter { overlaps($0.1, window) }
            .sorted { $0.1.start < $1.1.start }
            .compactMap { input, interval -> (Date, DeviceEventWire)? in
                let id = externalId(identity: input.identity, occurrence: input.occurrence)
                guard seen.insert(id).inserted else { return nil }
                return (interval.start, wire(input, id: id, timeZone: timeZone))
            }
        guard let (events, end) = capped(kept, window: window) else { return nil }
        let title = clamp(calendarTitle.trimmingCharacters(in: .whitespacesAndNewlines), calendarTitleMax)
        return DeviceSnapshotWire(
            windowStart: instant(window.start),
            windowEnd: instant(end),
            calendarTitle: title.isEmpty ? clamp(untitled, calendarTitleMax) : title,
            events: events)
    }

    /// More than `maxEvents`: keep the earliest ones and end the window at the
    /// first start left out, so the snapshot is still COMPLETE for its (shorter)
    /// window and the server's removal of absent rows stays correct. Nil when even
    /// that window would be empty (500+ events all starting before it).
    static func capped(
        _ sorted: [(Date, DeviceEventWire)], window: DateInterval
    ) -> ([DeviceEventWire], Date)? {
        guard sorted.count > maxEvents else { return (sorted.map(\.1), window.end) }
        let cutoff = sorted[maxEvents].0
        guard cutoff > window.start else { return nil }
        return (sorted.filter { $0.0 < cutoff }.map(\.1), cutoff)
    }

    /// The instants the server will store: a timed event's own, an all-day event's
    /// dates at UTC midnight (end exclusive).
    static func serverInterval(_ input: DeviceEventInput, timeZone: TimeZone) -> (start: Date, end: Date) {
        guard input.isAllDay else { return (input.start, max(input.end, input.start)) }
        let (first, after) = allDayDates(start: input.start, end: input.end, timeZone: timeZone)
        let parse = ISO8601DateFormatter()
        parse.formatOptions = [.withFullDate]
        parse.timeZone = TimeZone(identifier: "UTC")
        return (parse.date(from: first) ?? input.start, parse.date(from: after) ?? input.end)
    }

    /// The server's rule (`overlapsDeviceWindow`): starts before the window ends and
    /// ends after it starts; a zero-length event counts when it lies inside.
    static func overlaps(_ interval: (start: Date, end: Date), _ window: DateInterval) -> Bool {
        if interval.start >= window.end { return false }
        if interval.end > window.start { return true }
        return interval.end == interval.start && interval.start >= window.start
    }

    private static func wire(_ input: DeviceEventInput, id: String, timeZone: TimeZone) -> DeviceEventWire {
        let (start, end) = input.isAllDay
            ? allDayDates(start: input.start, end: input.end, timeZone: timeZone)
            : (instant(input.start), instant(max(input.end, input.start)))
        let location = input.location.map { clamp($0.trimmingCharacters(in: .whitespacesAndNewlines), locationMax) }
        return DeviceEventWire(
            externalId: id,
            title: clamp(input.title, titleMax),
            start: start,
            end: end,
            allDay: input.isAllDay,
            location: location?.isEmpty == false ? location : nil,
            meetingLink: meetingLink(input),
            status: input.status == .tentative ? "tentative" : "confirmed")
    }

    /// An all-day event's dates in the zone EventKit reported it in: the first
    /// date, and the day AFTER the last one (end exclusive, as the server stores
    /// all-day rows). EventKit ends an all-day event at 23:59:59 of its last day,
    /// or at the next midnight; one second back lands on the last day either way.
    static func allDayDates(start: Date, end: Date, timeZone: TimeZone) -> (String, String) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let first = calendar.startOfDay(for: start)
        let lastInstant = max(end.addingTimeInterval(-1), start)
        let last = calendar.startOfDay(for: lastInstant)
        let after = calendar.date(byAdding: .day, value: 1, to: last) ?? last
        return (dateString(first, calendar), dateString(after, calendar))
    }

    /// The event's link when it is a join link a client may open: https, no
    /// userinfo, within the server's length (the server applies the same rule).
    /// Only the event's URL field, or a location that is itself such a link;
    /// links inside the notes are not read (the notes never leave the Mac).
    static func meetingLink(_ input: DeviceEventInput) -> String? {
        let candidates = [input.url, input.location.flatMap { URL(string: $0.trimmingCharacters(in: .whitespaces)) }]
        return candidates.compactMap { $0 }.first(where: isSafeLink)?.absoluteString
    }

    private static func isSafeLink(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host?.isEmpty == false
            && url.user == nil && url.password == nil
            && url.absoluteString.unicodeScalars.count <= meetingLinkMax
    }

    /// At most `max` Unicode scalars: the server counts code points, not grapheme
    /// clusters, so an emoji sequence cannot push a clamped title over its limit.
    static func clamp(_ text: String, _ max: Int) -> String {
        guard text.unicodeScalars.count > max else { return text }
        var scalars = String.UnicodeScalarView()
        scalars.append(contentsOf: text.unicodeScalars.prefix(max))
        return String(scalars)
    }

    static func instant(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }

    private static func dateString(_ date: Date, _ calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    private static func sha256Hex(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// GET /api/device-calendar/sources. Decoded only to learn the feature is on; the
/// Mac's own toggles stay the source of truth for what is enabled.
struct DeviceCalendarSourcesResponse: Decodable, Sendable {
    struct Source: Decodable, Sendable {
        let key: String
        let title: String?
        let uploadedAt: String
    }
    let sources: [Source]
}
