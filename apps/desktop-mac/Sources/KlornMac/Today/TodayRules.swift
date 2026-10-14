import Foundation

/// One lane as Today shows it.
struct TodayLane: Equatable, Sendable {
    enum Style: Equatable, Sendable {
        /// Rows are listed (PUSH, MEETING, and QUEUE's top rows).
        case rows
        /// A count only; the rows are one click away in Mail (INFO).
        case collapsed
    }

    let tier: Tier
    let style: Style
    /// The lane's open count from the server summary.
    let count: Int
    let rows: [FirewallItem]

    /// Open items the lane holds beyond the rows listed here.
    var remaining: Int { max(count - rows.count, 0) }
}

/// What the Today screen can be: the states every mail surface shares (M6).
typealias TodayState = SurfaceState

/// Pure composition rules for Today (productization plan §1), pinned by the
/// self-check.
enum TodayRules {
    /// QUEUE shows its count and this many rows.
    static let queueRowLimit = 5
    /// PUSH and MEETING are expanded. The cap only stops a runaway lane
    /// from pushing the rest of the day off screen; the remainder is a link.
    static let expandedRowLimit = 12

    static func state(
        phase: AppModel.Phase, hasQueue: Bool, loadError: String?, offline: Bool = false
    ) -> TodayState {
        SurfaceStateRules.state(
            phase: phase, hasQueue: hasQueue, loadError: loadError, offline: offline)
    }

    /// The lanes Today lists, loudest first. SILENT is never part of it, and
    /// a lane with nothing open is left out.
    static func lanes(_ queue: FirewallResponse) -> [TodayLane] {
        let plan: [(Tier, TodayLane.Style, Int)] = [
            (.push, .rows, expandedRowLimit),
            (.meeting, .rows, expandedRowLimit),
            (.queue, .rows, queueRowLimit),
            (.info, .collapsed, 0),
        ]
        return plan.compactMap { tier, style, limit in
            let items = queue.items(for: tier)
            // The summary is the lane's true size; the fetched window can be
            // shorter, never trust it to be longer than what is listed.
            let count = max(queue.summary.count(for: tier), items.count)
            guard count > 0 else { return nil }
            return TodayLane(tier: tier, style: style, count: count, rows: Array(items.prefix(limit)))
        }
    }

    /// The assistant strip's one line: the structured headline, else the
    /// first line of the plain briefing.
    static func briefingLine(structure: BriefingStructure?, briefing: String?) -> String? {
        if let headline = structure?.headline, !headline.isEmpty { return headline }
        let first = briefing?
            .split(whereSeparator: \.isNewline).first
            .map { $0.trimmingCharacters(in: .whitespaces) }
        return first.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// Today's events in reading order: the one happening now, then the rest.
    static func events(_ today: TodaySummary?) -> [(event: CalendarEventWire, isNow: Bool)] {
        guard let today else { return [] }
        let current = today.current.map { [(event: $0, isNow: true)] } ?? []
        let upcoming = today.upcoming
            .filter { $0.id != today.current?.id }
            .map { (event: $0, isNow: false) }
        return current + upcoming
    }
}
