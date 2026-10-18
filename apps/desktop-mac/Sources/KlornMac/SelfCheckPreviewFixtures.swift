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
    return results
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
