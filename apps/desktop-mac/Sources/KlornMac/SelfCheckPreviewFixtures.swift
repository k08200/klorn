import Foundation

// Self-check for the locale-native preview fixtures (landing captures): a
// `ko` render shows Korean demo mail, not Korean chrome around English mail,
// and no preview Today header carries the fixture's fixed date. Pure data
// checks — nothing renders, launches or touches the Keychain.

@MainActor
func previewFixtureSelfChecks(sourceDir: URL) -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ ok: Bool) { results.append((name, ok)) }

    check("fixture locale: ko resolves to the Korean set",
          PreviewFixtureLocale.resolve(code: "ko") == .korean)
    check("fixture locale: every other language keeps the English set",
          ["en", "ja", "zh", "es", "fr", "de"].allSatisfy { PreviewFixtureLocale.resolve(code: $0) == .english })

    let en = decodeFirewall(PreviewRender.navFirewallJSONEn)
    let ko = decodeFirewall(PreviewRender.navFirewallJSONKo)
    check("ko fixtures decode", en != nil && ko != nil)
    guard let en, let ko else { return results }

    check("ko fixtures keep the English lanes and counts",
          Tier.allCases.allSatisfy { ko.items(for: $0).count == en.items(for: $0).count
              && ko.summary.count(for: $0) == en.summary.count(for: $0) }
          && ko.summary.total == en.summary.total)
    check("ko fixtures keep each row's lane and account",
          Tier.allCases.allSatisfy { tier in
              zip(en.items(for: tier), ko.items(for: tier)).allSatisfy { e, k in
                  e.id == k.id && e.tier == k.tier
                      && e.email?.source?.provider == k.email?.source?.provider
              }
          })
    let all = Tier.allCases.flatMap { ko.items(for: $0) } + Tier.allCases.flatMap { en.items(for: $0) }
    check("fixture accounts are Gmail, Naver and iCloud only",
          Set(all.compactMap { $0.email?.source?.provider }).isSubset(of: ["GOOGLE", "NAVER", "ICLOUD"]))

    let koItems = Tier.allCases.flatMap { ko.items(for: $0) }
    check("ko subjects are Hangul",
          !koItems.isEmpty && koItems.allSatisfy { containsHangul($0.email?.subject ?? "") })
    check("ko lane reasons are Hangul",
          koItems.allSatisfy { containsHangul($0.tierReason ?? "") })
    check("the English set stays English",
          Tier.allCases.flatMap { en.items(for: $0) }.allSatisfy {
              !containsHangul($0.email?.subject ?? "") && !containsHangul($0.tierReason ?? "")
          })

    let koJSON = [
        PreviewRender.navFirewallJSONKo, PreviewRender.navEmailJSONKo, PreviewRender.navBriefingJSONKo,
        PreviewRender.navTodayJSONKo, PreviewRender.navActionsJSONKo, PreviewRender.navCommitmentsJSONKo,
        PreviewRender.navChatJSONKo,
    ]
    let latin = koJSON.flatMap { latinWords(inVisibleTextOf: $0) }
    check("ko fixtures: no Latin words beyond brands, lanes and addresses", latin.isEmpty)
    if !latin.isEmpty { print("      latin: \(Set(latin).sorted().prefix(12).joined(separator: ", "))") }
    let everything = (koJSON + [PreviewRender.navFirewallJSONEn]).joined().lowercased()
    check("fixtures name no Outlook or Microsoft account",
          !everything.contains("outlook") && !everything.contains("microsoft"))

    // MARK: undated header
    let now = ISO8601DateFormatter().date(from: "2026-07-29T08:30:00Z") ?? Date()
    check("preview Today header has no date",
          TodayRules.headerDetail(now: now, renderingOffscreen: true, locale: Locale(identifier: "ko")) == nil
          && TodayRules.headerDetail(now: now, renderingOffscreen: true, locale: Locale(identifier: "en")) == nil)
    check("the shipping Today header still shows the date",
          TodayRules.headerDetail(now: now, renderingOffscreen: false, locale: Locale(identifier: "en"))?
              .contains("29") == true)
    let briefings = [PreviewRender.navBriefingJSONEn, PreviewRender.navBriefingJSONKo]
        .compactMap { try? JSONDecoder().decode(BriefingStructure.self, from: Data($0.utf8)) }
    check("preview briefings carry no fixed date",
          briefings.count == 2 && briefings.allSatisfy { !$0.dateLabel.contains(where: \.isNumber) })
    let screen = swiftSources(under: sourceDir)
        .first { $0.lastPathComponent == "TodayScreen.swift" }
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    check("the Today screen gates its undated header on the offscreen renderer only",
          screen.contains("renderingOffscreen: Theme.isRenderingOffscreen"))
    results += previewMailClockSelfChecks(sourceDir: sourceDir)
    return results
}

/// Mail rows and the reader in a preview render tell time by the fixture
/// clock: today's fixture mail as a time, the past week as "Yesterday" or a
/// weekday — never the absolute "Jul 29" a wall clock made of fixture dates.
/// The shipping grains stay pinned by the mail-time checks in SelfCheck.swift.
@MainActor
private func previewMailClockSelfChecks(sourceDir: URL) -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ ok: Bool) { results.append((name, ok)) }
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC") ?? .current
    var seoul = Calendar(identifier: .gregorian)
    seoul.timeZone = TimeZone(identifier: "Asia/Seoul") ?? .current
    let now = MailClock.fixtureNow
    let en = Locale(identifier: "en_US"), ko = Locale(identifier: "ko_KR")

    check("mail clock: a preview render reads the fixture clock, shipping the wall clock",
          MailClock.now(renderingOffscreen: true) == now
          && abs(MailClock.now(renderingOffscreen: false).timeIntervalSinceNow) < 60)
    let stamps = (fixtureTimestamps(PreviewRender.navFirewallJSONEn)
        + fixtureTimestamps(PreviewRender.navFirewallJSONKo))
    check("mail clock: every fixture mail is today in both UTC and Seoul",
          !stamps.isEmpty && stamps.allSatisfy { stamp in
              [utc, seoul].allSatisfy { cal in
                  mailTimeLabel(iso: stamp, now: now, calendar: cal, locale: ko, relativeDays: true)
                      .allSatisfy { $0.isNumber || $0 == ":" }
              }
          })
    check("mail clock: preview rows show today's mail as a time",
          mailTimeLabel(iso: "2026-07-29T06:20:00Z", now: now, calendar: utc, locale: en, relativeDays: true)
          == "06:20")
    check("mail clock: preview rows say Yesterday / 어제 for the day before",
          mailTimeLabel(iso: "2026-07-28T06:20:00Z", now: now, calendar: utc, locale: en, relativeDays: true)
          == "Yesterday"
          && mailTimeLabel(iso: "2026-07-28T06:20:00Z", now: now, calendar: utc, locale: ko, relativeDays: true)
          == "어제")
    check("mail clock: preview rows name the weekday within the week",
          mailTimeLabel(iso: "2026-07-24T02:10:00Z", now: now, calendar: utc, locale: en, relativeDays: true)
          == "Friday"
          && mailTimeLabel(iso: "2026-07-24T02:10:00Z", now: now, calendar: utc, locale: ko, relativeDays: true)
          == "금요일")
    check("mail clock: preview rows keep month + day past a week",
          mailTimeLabel(iso: "2026-07-20T02:10:00Z", now: now, calendar: utc, locale: en, relativeDays: true)
          == "Jul 20")
    check("mail clock: shipping rows keep the absolute day (no relative words)",
          mailTimeLabel(iso: "2026-07-28T06:20:00Z", now: now, calendar: utc, locale: en) == "Jul 28"
          && mailTimeLabel(iso: "2026-07-24T02:10:00Z", now: now, calendar: utc, locale: en) == "Jul 24")

    check("reader date: shipping keeps month, day and time",
          readerDateLabel(iso: "2026-07-29T06:20:00Z", locale: en, calendar: utc) == "Jul 29 · 6:20 AM")
    check("reader date: preview shows today's mail as the time alone",
          spaced(readerDateLabel(iso: "2026-07-29T06:20:00Z", locale: en, calendar: utc, relativeTo: now))
              == "6:20 AM"
          && spaced(readerDateLabel(iso: "2026-07-29T06:20:00Z", locale: ko, calendar: seoul, relativeTo: now))
              == "오후 3:20")
    check("reader date: preview says Yesterday / weekday before today",
          spaced(readerDateLabel(iso: "2026-07-28T06:20:00.000Z", locale: en, calendar: utc, relativeTo: now))
              == "Yesterday · 6:20 AM"
          && spaced(readerDateLabel(iso: "2026-07-24T06:20:00Z", locale: ko, calendar: utc, relativeTo: now))
              == "금요일 · 오전 6:20")
    check("reader date: malformed ISO degrades to empty",
          readerDateLabel(iso: "nope", locale: en, relativeTo: now) == ""
          && readerDateLabel(iso: nil, locale: en) == "")

    let mailSources = swiftSources(under: sourceDir)
        .filter { ["WindowMailRow.swift", "MailboxList.swift", "WaitingOnList.swift", "ReadingPane.swift"]
            .contains($0.lastPathComponent) }
        .compactMap { try? String(contentsOf: $0, encoding: .utf8) }
    check("mail rows and reader gate the fixture clock on the offscreen renderer only",
          mailSources.count == 4
          && mailSources.allSatisfy { !$0.contains("now: Date()") && $0.contains("Theme.isRenderingOffscreen") })
    return results
}

/// ICU puts a narrow no-break space before "AM"; compare on plain spaces.
private func spaced(_ text: String) -> String {
    text.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
}

/// Every mail timestamp a fixture shows on a row.
private func fixtureTimestamps(_ json: String) -> [String] {
    let pattern = try? NSRegularExpression(pattern: #""(?:receivedAt|surfacedAt)":"([^"]+)""#)
    let range = NSRange(json.startIndex..., in: json)
    return (pattern?.matches(in: json, range: range) ?? [])
        .compactMap { Range($0.range(at: 1), in: json).map { String(json[$0]) } }
}

private func decodeFirewall(_ json: String) -> FirewallResponse? {
    try? JSONDecoder().decode(FirewallResponse.self, from: Data(json.utf8))
}

private func containsHangul(_ text: String) -> Bool {
    text.unicodeScalars.contains { (0xAC00...0xD7A3).contains($0.value) }
}

/// Words a Korean capture may still show in Latin script: lane names as the
/// product prints them, and brand names.
private let latinAllowed: Set<String> = [
    "Push", "Meeting", "Queue", "Info", "Silent", "Klorn", "Gmail", "Naver", "iCloud",
]

/// Keys whose values a viewer reads. Machine values (ids, timestamps, lane
/// codes, providers) are compared against, never shown.
private let visibleKeys: Set<String> = [
    "title", "tierReason", "subject", "from", "snippet", "summary", "text", "headline",
    "label", "action", "reason", "targetLabel", "reasoning", "counterpartyName", "dueText",
    "dateLabel",
]

private func latinWords(inVisibleTextOf json: String) -> [String] {
    guard let root = try? JSONSerialization.jsonObject(with: Data(json.utf8)) else { return ["<undecodable>"] }
    var texts: [String] = []
    func walk(_ node: Any, key: String?) {
        if let dict = node as? [String: Any] {
            for (k, v) in dict { walk(v, key: k) }
        } else if let list = node as? [Any] {
            for v in list { walk(v, key: key) }
        } else if let text = node as? String, key == nil || visibleKeys.contains(key ?? "") {
            texts.append(text)
        }
    }
    walk(root, key: nil)
    let address = try! NSRegularExpression(pattern: #"<[^>]*>|[\w.+-]+@[\w.-]+|https?://\S+"#)
    let word = try! NSRegularExpression(pattern: "[A-Za-z]+")
    return texts.flatMap { text -> [String] in
        let stripped = address.stringByReplacingMatches(
            in: text, range: NSRange(text.startIndex..., in: text), withTemplate: " ")
        return word.matches(in: stripped, range: NSRange(stripped.startIndex..., in: stripped))
            .compactMap { Range($0.range, in: stripped).map { String(stripped[$0]) } }
            .filter { !latinAllowed.contains($0) }
    }
}
