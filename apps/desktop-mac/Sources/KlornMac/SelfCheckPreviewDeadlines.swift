import Foundation

// Self-check that the demo story keeps time with its own clock. The preview
// renders run at `MailClock.fixtureNow` (17:30 in Seoul, the capture zone), so
// every deadline the fixtures name ("before 18:00", "18:00 전", "by noon")
// must still be ahead of that clock, and the English and Korean sets must
// name the same hour. Pure data checks — nothing renders.

@MainActor
func previewDeadlineSelfChecks() -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ ok: Bool) { results.append((name, ok)) }

    let clock = seoulClockMinutes(MailClock.fixtureNow)
    let en = [PreviewRender.navFirewallJSONEn, PreviewRender.navActionsJSONEn, PreviewRender.navEmailJSONEn,
              PreviewRender.emailJSON, PreviewRender.navChatJSONEn, briefingDeadlineText(PreviewRender.navBriefingJSONEn)]
        .flatMap { deadlines(in: $0, patterns: englishDeadlinePatterns) }
    let ko = [PreviewRender.navFirewallJSONKo, PreviewRender.navActionsJSONKo, PreviewRender.navEmailJSONKo,
              PreviewRender.navChatJSONKo, briefingDeadlineText(PreviewRender.navBriefingJSONKo)]
        .flatMap { deadlines(in: $0, patterns: koreanDeadlinePatterns) }

    check("preview deadlines: the fixture clock reads 17:30 in Seoul", clock == 17 * 60 + 30)
    check("preview deadlines: en and ko fixtures each name a deadline", !en.isEmpty && !ko.isEmpty)
    check("preview deadlines: every en deadline is later than the fixture clock",
          en.allSatisfy { (minutes(of: $0) ?? 0) > clock })
    check("preview deadlines: every ko deadline is later than the fixture clock",
          ko.allSatisfy { (minutes(of: $0) ?? 0) > clock })
    check("preview deadlines: en and ko name the same deadline hours", Set(en) == Set(ko))
    check("preview deadlines: en and ko chat answers name the same deadline",
          deadlines(in: PreviewRender.navChatJSONEn, patterns: englishDeadlinePatterns)
              == deadlines(in: PreviewRender.navChatJSONKo, patterns: koreanDeadlinePatterns))
    return results
}

/// A pattern whose first capture group is the "HH:MM" deadline, or a fixed
/// time for a pattern that names it in words ("noon", "정오").
private typealias DeadlinePattern = (regex: String, fixed: String?)

private let englishDeadlinePatterns: [DeadlinePattern] = [
    (#"\b(?:before|by|until) (\d{1,2}:\d{2})(?!\d)"#, nil),
    (#"\b(?:before|by|until) noon\b"#, "12:00"),
]

private let koreanDeadlinePatterns: [DeadlinePattern] = [
    (#"(?<!\d)(\d{1,2}:\d{2}) ?(?:전|까지)"#, nil),
    (#"정오 ?(?:전|까지)"#, "12:00"),
]

/// The briefing's deadline-bearing text: headline and ranked priorities.
/// Segment labels ("Before 12:00", "12:00 이전") are the day's shape, not
/// deadlines, so they stay out.
private func briefingDeadlineText(_ json: String) -> String {
    guard let briefing = try? JSONDecoder().decode(BriefingStructure.self, from: Data(json.utf8)) else {
        return ""
    }
    return ([briefing.headline] + briefing.attention.flatMap { [$0.action, $0.reason] })
        .joined(separator: "\n")
}

private func deadlines(in text: String, patterns: [DeadlinePattern]) -> [String] {
    patterns.flatMap { pattern -> [String] in
        guard let regex = try? NSRegularExpression(pattern: pattern.regex) else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
            if let fixed = pattern.fixed { return fixed }
            return Range(match.range(at: 1), in: text).map { String(text[$0]) }
        }
    }
}

private func minutes(of clockTime: String) -> Int? {
    let parts = clockTime.split(separator: ":").compactMap { Int($0) }
    return parts.count == 2 ? parts[0] * 60 + parts[1] : nil
}

private func seoulClockMinutes(_ date: Date) -> Int {
    var seoul = Calendar(identifier: .gregorian)
    seoul.timeZone = TimeZone(identifier: "Asia/Seoul") ?? .current
    let parts = seoul.dateComponents([.hour, .minute], from: date)
    return (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
}
