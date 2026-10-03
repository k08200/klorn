import EventKit
import Foundation

// Step C6: everything that touches EventKit, off the main thread. The bridge
// (DeviceCalendarBridge, @MainActor) owns UI state only; it awaits this reader for
// the calendar list and for each snapshot, which is read, built and JSON-encoded
// here, on the actor's own executor. Created only once the user turned uploading on.

/// The device calendar store the bridge talks to. EventKit in the app
/// (`DeviceCalendarReader`); a fake in the self-check.
protocol DeviceCalendarStore: Sendable {
    /// Ask macOS for full calendar access (the one prompt; macOS 14+).
    func requestAccess() async -> Bool
    func calendars() async -> [DeviceCalendarItem]
    /// The calendar's snapshot, ready to send; nil when this Mac does not list the
    /// calendar right now (its upload pauses; nothing is deleted for an absence) or
    /// no complete snapshot can be made this time.
    func snapshot(calendarId: String, now: Date, untitled: String) async -> PreparedSnapshot?
}

actor DeviceCalendarReader: DeviceCalendarStore {
    private let store = EKEventStore()

    func requestAccess() async -> Bool {
        await withCheckedContinuation { continuation in
            store.requestFullAccessToEvents { granted, _ in continuation.resume(returning: granted) }
        }
    }

    func calendars() -> [DeviceCalendarItem] {
        store.calendars(for: .event)
            .map { DeviceCalendarItem(id: $0.calendarIdentifier, title: $0.title, account: $0.source?.title ?? "") }
            .sorted { ($0.account, $0.title) < ($1.account, $1.title) }
    }

    func snapshot(calendarId: String, now: Date, untitled: String) -> PreparedSnapshot? {
        guard let calendar = store.calendar(withIdentifier: calendarId) else { return nil }
        // Autoupdating: a Mac that travels reads all-day dates in its new zone.
        let window = DeviceCalendarSnapshot.window(now: now, calendar: .autoupdatingCurrent)
        let range = DeviceCalendarSnapshot.queryRange(for: window)
        let predicate = store.predicateForEvents(withStart: range.start, end: range.end, calendars: [calendar])
        let inputs = store.events(matching: predicate).map(Self.input(from:))
        guard let wire = DeviceCalendarSnapshot.build(
            events: inputs, calendarTitle: calendar.title, window: window, timeZone: .autoupdatingCurrent,
            untitled: untitled, snapshotAt: now)
        else { return nil }
        return DeviceCalendarSnapshot.prepared(wire)
    }

    /// The EKEvent fields the snapshot needs, and nothing else (no notes; attendees
    /// are read only to skip an invitation the user declined).
    static func input(from event: EKEvent) -> DeviceEventInput {
        let recurring = event.hasRecurrenceRules || event.isDetached
        let declined = event.attendees?.contains {
            $0.isCurrentUser && $0.participantStatus == .declined
        } ?? false
        let status: DeviceEventInput.Status = switch event.status {
        case .canceled: .canceled
        case .tentative: .tentative
        case .confirmed: .confirmed
        default: .none
        }
        return DeviceEventInput(
            identity: event.calendarItemExternalIdentifier ?? event.calendarItemIdentifier,
            occurrence: recurring ? event.occurrenceDate : nil,
            title: event.title ?? "",
            start: event.startDate,
            end: event.endDate ?? event.startDate,
            isAllDay: event.isAllDay,
            location: event.location,
            url: event.url,
            status: status,
            declinedBySelf: declined)
    }
}
