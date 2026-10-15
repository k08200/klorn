import Foundation

/// Teams free-time (productization plan P12), the pure rules behind Today's
/// "When is everyone free?": when it is offered, how the saved team's
/// availability is asked for, and how a slot reads. Mirrors the web's
/// free-time-model.ts. The read creates nothing: scheduling stays in the
/// assistant's own approval flow.
enum FreeTimeRules {
    /// How far ahead to look. The server refuses a window over 14 days.
    static let windowDays = 7
    /// The length of a common slot.
    static let durationMinutes = 30
    /// A result older than this offers "Check again": calendars move.
    static let staleAfter: TimeInterval = 10 * 60
    /// How often a shown result re-reads the clock, so past slots drop off.
    static let clockTick: TimeInterval = 60

    private static let daySeconds: TimeInterval = 24 * 60 * 60

    enum Scope: Equatable, Sendable {
        case team
        /// No member was checked: the slots are only the user's own.
        case selfOnly
    }

    /// Offered only with team mode on and at least one saved team.
    static func visible(teamMode: Bool, teamCount: Int) -> Bool {
        teamMode && teamCount > 0
    }

    static func scope(_ result: TeamAvailabilityWire) -> Scope {
        result.checkedMembers.isEmpty ? .selfOnly : .team
    }

    /// The members listed above the slots: calendars unknown, never counted
    /// as free. With nobody checked the self-only note says it instead.
    static func unknownNotice(_ result: TeamAvailabilityWire) -> String? {
        guard scope(result) == .team, !result.unknownMembers.isEmpty else { return nil }
        return L("today.freeTime.unknown", result.unknownMembers.joined(separator: ", "))
    }

    private static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    /// GET /api/teams/:id/availability for the next `windowDays` days.
    static func availabilityPath(teamId: String, now: Date) -> String {
        let end = now.addingTimeInterval(TimeInterval(windowDays) * daySeconds)
        let params = [
            ("window_start", iso(now)),
            ("window_end", iso(end)),
            ("duration_minutes", String(durationMinutes)),
        ]
        let query = params.map { "\($0.0)=\(FilesRules.queryEscape($0.1))" }.joined(separator: "&")
        return "/api/teams/\(FilesRules.queryEscape(teamId))/availability?\(query)"
    }

    private static func start(_ slot: TeamAvailabilityWire.Slot) -> Date? {
        FilesRules.parseInstant(slot.startTime)
    }

    /// The slots that have not started yet, in order; an unreadable one is dropped.
    static func upcoming(_ slots: [TeamAvailabilityWire.Slot], now: Date) -> [TeamAvailabilityWire.Slot] {
        slots.filter { start($0).map { $0 >= now } ?? false }
    }

    /// Fetched more than `staleAfter` ago (or at an unknown time), or the
    /// first slot has already started.
    static func stale(fetchedAt: Date?, slots: [TeamAvailabilityWire.Slot], now: Date) -> Bool {
        guard let fetchedAt, now.timeIntervalSince(fetchedAt) <= staleAfter else { return true }
        guard let first = slots.first else { return false }
        return !(start(first).map { $0 >= now } ?? false)
    }

    /// The result's zone (the one the server cut the slots in), else this Mac's.
    static func timeZone(for result: TeamAvailabilityWire?) -> TimeZone {
        result.flatMap { TimeZone(identifier: $0.timeZone) } ?? .current
    }

    /// "Thu, Oct 15 10:00–10:30" in `timeZone`; empty for an unreadable slot.
    static func label(_ slot: TeamAvailabilityWire.Slot, locale: Locale, timeZone: TimeZone) -> String {
        guard let startDate = FilesRules.parseInstant(slot.startTime),
              let endDate = FilesRules.parseInstant(slot.endTime)
        else { return "" }
        let day = DateFormatter()
        day.locale = locale
        day.timeZone = timeZone
        day.setLocalizedDateFormatFromTemplate("EEEMMMd")
        let time = DateFormatter()
        time.locale = locale
        time.timeZone = timeZone
        time.setLocalizedDateFormatFromTemplate("HHmm")
        return "\(day.string(from: startDate)) \(time.string(from: startDate))–\(time.string(from: endDate))"
    }
}
