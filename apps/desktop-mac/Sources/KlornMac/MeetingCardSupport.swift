import Foundation

/// Pure meeting-card logic (AppKit-free, pinned by the self-check harness).

/// Wire shape of GET /api/calendar/:id/prep-pack (subset the card renders;
/// JSONDecoder ignores the richer fields).
struct MeetingPrepPack: Codable, Sendable {
    struct Event: Codable, Sendable {
        let id: String
        let title: String
        let description: String?
        let startTime: String
        let endTime: String
        let location: String?
        let meetingLink: String?
    }

    let generatedAt: String
    let event: Event
    /// "ready" | "watch" | "needs_review" (server enum; render defensively).
    let readiness: String
    let checklist: [String]
}

/// Display label for the readiness enum; unknown values fall back to a
/// neutral "Prep" so a server-side addition can't render a raw slug.
func readinessLabel(_ readiness: String) -> String {
    switch readiness {
    case "ready": return "Ready"
    case "watch": return "Watch"
    case "needs_review": return "Needs review"
    default: return "Prep"
    }
}

/// Which upcoming meeting deserves a prep card right now: the EARLIEST timed
/// event whose start is within `leadMinutes` and hasn't been surfaced yet.
/// Never an all-day event (no meaningful "10 minutes before" for those),
/// never one that already started (the TODAY column's NOW badge covers it).
func meetingCardPlan(
    now: Date,
    events: [CalendarEventWire],
    leadMinutes: Int,
    shown: Set<String>
) -> CalendarEventWire? {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let lead = TimeInterval(leadMinutes * 60)
    return
        events
        .filter { !$0.allDay && !shown.contains($0.id) }
        .compactMap { event -> (CalendarEventWire, Date)? in
            guard let start = parser.date(from: event.startTime) else { return nil }
            return (event, start)
        }
        .filter { _, start in start > now && start.timeIntervalSince(now) <= lead }
        .min { $0.1 < $1.1 }?
        .0
}
