import Foundation

/// Where Today puts the day (founder, 2026-11-13, LOCKED: "see today at a
/// glance without scrolling"): a sticky right column beside the mail when
/// the card is wide, a compact strip under the headline when it is not —
/// never below the lanes. Pure, pinned by the self-check.
enum TodayLayoutRules {
    enum CalendarPlacement: Equatable { case column, strip }

    static let columnWidth: CGFloat = 280
    /// Below this much content width the column would squeeze the cards.
    static let columnBreakpoint: CGFloat = 1100

    static func calendarPlacement(contentWidth: CGFloat) -> CalendarPlacement {
        contentWidth >= columnBreakpoint ? .column : .strip
    }

    /// Today's width in a window: the window less the sidebar, the content
    /// card's trailing inset and, when it shows, the assistant panel with its
    /// own inset (`MainShell`). The view measures itself; this names the
    /// arithmetic for the self-check.
    static func contentWidth(windowWidth: CGFloat, sidebarWidth: CGFloat, panelVisible: Bool) -> CGFloat {
        let panel = panelVisible ? AssistantPanelRules.width + AssistantPanelRules.inset : 0
        return windowWidth - sidebarWidth - AssistantPanelRules.inset - panel
    }
}

/// Today's schedule as a timeline: the events in order, the one running
/// marked, the next one highlighted, and the free time between them. Read
/// from the existing today summary; nothing is fetched. Pure.
enum TodayTimelineRules {
    struct Entry: Equatable {
        let event: CalendarEventWire
        let isNow: Bool
        let isNext: Bool
    }

    /// A free stretch of today. `end` nil: free for the rest of the day.
    struct FreeSlot: Equatable {
        let start: Date
        let end: Date?
    }

    /// Gaps shorter than this are not worth naming.
    static let minimumFreeMinutes = 30
    /// The free list stays short: the column has to fit at a glance.
    static let freeSlotLimit = 4

    static func entries(_ today: TodaySummary?, now: Date) -> [Entry] {
        let events = TodayRules.events(today)
        let nextID = events.first { !$0.isNow && (start(of: $0.event).map { $0 >= now } ?? false) }?.event.id
        return events.map { Entry(event: $0.event, isNow: $0.isNow, isNext: $0.event.id == nextID) }
    }

    /// Where the "now" line goes: after every event that has started, so
    /// right after a running one and before the next. nil with no events.
    static func nowMarkerIndex(_ entries: [Entry], now: Date) -> Int? {
        guard !entries.isEmpty else { return nil }
        return entries.filter { entry in entry.isNow || (start(of: entry.event).map { $0 <= now } ?? false) }.count
    }

    /// Free stretches from now to the end of the day, between timed events.
    /// All-day events do not block time; events already over are ignored.
    static func freeSlots(
        events: [CalendarEventWire], now: Date, calendar: Calendar = DisplayTimeZone.calendar
    ) -> [FreeSlot] {
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) else {
            return []
        }
        let minimum = TimeInterval(minimumFreeMinutes * 60)
        let timed = events
            .filter { !$0.allDay }
            .compactMap { event -> (Date, Date)? in
                guard let start = start(of: event), let end = parseISO(event.endTime) else { return nil }
                return (start, end)
            }
            .filter { $0.1 > now }
            .sorted { $0.0 < $1.0 }
        var slots: [FreeSlot] = []
        var cursor = now
        for (start, end) in timed {
            if start.timeIntervalSince(cursor) >= minimum { slots.append(FreeSlot(start: cursor, end: start)) }
            cursor = max(cursor, end)
        }
        if dayEnd.timeIntervalSince(cursor) >= minimum { slots.append(FreeSlot(start: cursor, end: nil)) }
        return Array(slots.prefix(freeSlotLimit))
    }

    private static func start(of event: CalendarEventWire) -> Date? { parseISO(event.startTime) }

    /// Both ISO shapes the API sends (with and without milliseconds).
    static func parseISO(_ iso: String) -> Date? {
        let withMillis = ISO8601DateFormatter()
        withMillis.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withMillis.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    /// "09:30" in the display zone.
    static func clock(_ date: Date, calendar: Calendar = DisplayTimeZone.calendar) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }
}

/// A non-PUSH lane on Today (founder, 2026-11-13, LOCKED): three rows, then
/// "See all (N)" with the lane's true count.
enum TodayLaneRules {
    struct Compact: Equatable {
        let rows: [FirewallItem]
        let seeAllCount: Int
    }

    static func compact(_ lane: TodayLane) -> Compact {
        Compact(rows: Array(lane.rows.prefix(TodayRules.compactRowLimit)), seeAllCount: lane.count)
    }
}
