import Foundation

/// Pure rules for the editorial Today (M1/M2, founder decision 2026-11-13).
/// Which PUSH mail Today lists is still `TodayRules` (LOCKED: PUSH inside
/// the server's 72 h window); these only shape how it reads.
enum TodayBriefRules {
    /// PUSH cards shown before the rest folds into one "N more" link.
    static let cardCap = 6
    static let cardsPerRow = 3

    struct Cards: Equatable {
        let shown: [FirewallItem]
        /// Open PUSH mail beyond the cards: the lane's count, not just the
        /// rows it listed, so the lane's own row cap never hides any.
        let more: Int
    }

    struct CardText: Equatable {
        let title: String
        let body: String?
    }

    /// "Nothing is waiting" / one / many. Korean reads the same for one and
    /// many ("지금 N건이 기다려요"); English needs the singular.
    static func headlineKey(pushCount: Int) -> String {
        switch pushCount {
        case ..<1: "today.headline.none"
        case 1: "today.headline.one"
        default: "today.headline.many"
        }
    }

    static func headline(pushCount: Int) -> String {
        let key = headlineKey(pushCount: pushCount)
        return pushCount > 0 ? L(key, pushCount) : L(key)
    }

    static func cards(_ lane: TodayLane?) -> Cards {
        guard let lane else { return Cards(shown: [], more: 0) }
        let shown = Array(lane.rows.prefix(cardCap))
        return Cards(shown: shown, more: max(lane.count - shown.count, 0))
    }

    /// The card says why it is urgent: the judge's reason is the title and
    /// the subject the body. With no reason the subject moves up and the
    /// snippet (when there is one) takes the body, so nothing is said twice.
    static func cardText(reason: String?, subject: String, snippet: String?) -> CardText {
        if let reason, !reason.isEmpty { return CardText(title: reason, body: subject) }
        return CardText(title: subject, body: snippet)
    }

    /// Free hours in the day shape the server measured (pim/day-shape.ts:
    /// `freeHours = curve.filter(c => c === 0).length`). nil before a
    /// briefing exists.
    static func freeHours(_ structure: BriefingStructure?) -> Int? {
        guard let curve = structure?.curve, !curve.isEmpty else { return nil }
        return curve.filter { $0 == 0 }.count
    }

    /// Today's events from the calendar summary; nil before it loads.
    static func meetings(_ today: TodaySummary?) -> Int? { today?.total }

    /// The caps line over the headline: date · meetings · free time, each
    /// only when it is known.
    static func kickerParts(
        date: String?, meetings: Int?, freeHours: Int?, text: (String) -> String = L
    ) -> [String] {
        var parts: [String] = []
        if let date, !date.isEmpty { parts.append(date) }
        if let meetings { parts.append(String(format: text("today.kicker.meetings"), meetings)) }
        if let freeHours { parts.append(String(format: text("today.kicker.free"), freeHours)) }
        return parts
    }

    /// "Dana Whitfield" → "DW", "billing@vendor.io" → "B", "김서연" → "김".
    static func monogram(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.first else { return "?" }
        if trimmed.contains("@") { return String(first).uppercased() }
        let words = trimmed.split(whereSeparator: \.isWhitespace)
        guard first.isASCII, words.count > 1, let second = words[1].first, second.isASCII else {
            return String(first).uppercased()
        }
        return (String(first) + String(second)).uppercased()
    }

    /// A face's hue from its sender: FNV-1a, so it is the same on every run
    /// (Swift's `hashValue` is seeded per process).
    static func hue(for key: String) -> Double {
        var hash: UInt32 = 2_166_136_261
        for byte in key.lowercased().utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 16_777_619
        }
        return Double(hash % 360)
    }
}
