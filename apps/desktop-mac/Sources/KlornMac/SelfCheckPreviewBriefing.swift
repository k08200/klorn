import Foundation

// Self-check that the English and Korean demo days are the same day. The
// landing shows both, and its HTML briefing card (`.brief`) mirrors them, so a
// translation must never change a segment's hours, a count, the curve or the
// ranked priorities. Pure data checks — nothing renders.

@MainActor
func previewBriefingPairSelfChecks() -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ ok: Bool) { results.append((name, ok)) }

    let en = decodeBriefing(PreviewRender.navBriefingJSONEn)
    let ko = decodeBriefing(PreviewRender.navBriefingJSONKo)
    check("preview briefings (en, ko) decode", en != nil && ko != nil)
    guard let en, let ko else { return results }

    check("en and ko briefings: same segments (start, end, kind)",
          en.segments.count == ko.segments.count
              && zip(en.segments, ko.segments).allSatisfy { e, k in
                  clockTimes(in: e.label) == clockTimes(in: k.label) && e.kind == k.kind
              })
    check("en and ko briefings: same counts in each segment",
          zip(en.segments, ko.segments).allSatisfy { e, k in numbers(in: e.summary) == numbers(in: k.summary) })
    check("en and ko briefings: same day-shape curve and start hour",
          en.curve == ko.curve && en.dayStartHour == ko.dayStartHour)
    check("en and ko briefings: same ranked priorities and deadlines",
          en.attention.map(\.rank) == ko.attention.map(\.rank)
              && zip(en.attention, ko.attention).allSatisfy { e, k in
                  clockTimes(in: e.action) == clockTimes(in: k.action)
              })
    check("en and ko briefings: headline names the same hour",
          clockTimes(in: en.headline) == clockTimes(in: ko.headline))

    let enRows = decodedRows(PreviewRender.navFirewallJSONEn)
    let koRows = decodedRows(PreviewRender.navFirewallJSONKo)
    check("en and ko mail rows: subjects name the same times",
          !enRows.isEmpty && enRows.count == koRows.count
              && zip(enRows, koRows).allSatisfy { e, k in
                  clockTimes(in: e.email?.subject ?? "") == clockTimes(in: k.email?.subject ?? "")
              })
    return results
}

private func decodeBriefing(_ json: String) -> BriefingStructure? {
    try? JSONDecoder().decode(BriefingStructure.self, from: Data(json.utf8))
}

private func decodedRows(_ json: String) -> [FirewallItem] {
    guard let firewall = try? JSONDecoder().decode(FirewallResponse.self, from: Data(json.utf8)) else { return [] }
    return Tier.allCases.flatMap { firewall.items(for: $0) }
}

/// Every "HH:MM" in `text`, in order. Digit lookarounds, not `\b`: Hangul
/// is a word character, so "17:00부터" has no word boundary after the time.
private func clockTimes(in text: String) -> [String] {
    matches(of: #"(?<!\d)\d{1,2}:\d{2}(?!\d)"#, in: text)
}

/// Every whole number in `text` that is not part of a clock time, in order.
private func numbers(in text: String) -> [String] {
    let withoutTimes = text.replacingOccurrences(of: #"\d{1,2}:\d{2}"#, with: " ", options: .regularExpression)
    return matches(of: #"\d+"#, in: withoutTimes)
}

private func matches(of pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap {
        Range($0.range, in: text).map { String(text[$0]) }
    }
}
