import Foundation

// Self-check for the editorial Today (M1/M2, founder decision 2026-11-13):
// the headline copy, the account-tinted chrome, the text tokens' contrast on
// the surfaces they sit on, the PUSH card cap and the card title fallback.
// Run by `KlornMac --self-check`. Pure values only: no NSColor, no view.

func todayBriefSelfChecks() -> [(String, Bool)] {
    print("Editorial Today (M1/M2):")
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    func text(_ key: String, _ code: String) -> String { L10n.value(key, language: code) ?? key }
    let korean = { (key: String) in text(key, "ko") }

    // MARK: headline plural strings
    let en = { (n: Int) in text(TodayBriefRules.headlineKey(pushCount: n), "en") }
    let ko = { (n: Int) in text(TodayBriefRules.headlineKey(pushCount: n), "ko") }
    check("headline: no PUSH reads as a calm sentence, with no number",
          TodayBriefRules.headlineKey(pushCount: 0) == "today.headline.none"
              && !en(0).contains("%") && !en(0).contains(where: \.isNumber)
              && ko(0) == "지금 기다리는 메일이 없어요")
    check("headline: exactly one uses the singular key",
          TodayBriefRules.headlineKey(pushCount: 1) == "today.headline.one"
              && String(format: en(1), 1).contains("1"))
    check("headline: many uses %d, never %@, in every locale",
          TodayBriefRules.headlineKey(pushCount: 3) == "today.headline.many"
              && L10n.shipped.allSatisfy { code in
                  let raw = text("today.headline.many", code)
                  return raw.contains("%d") && !raw.contains("%@")
              })
    check("headline: Korean reads 지금 N건이 기다려요",
          String(format: ko(3), 3) == "지금 3건이 기다려요"
              && String(format: ko(1), 1) == "지금 1건이 기다려요")

    // MARK: chrome tint derivation (account → dark / light tone)
    let amber = AccountIdentity.palette[0]
    let darkStops = Theme.chromeStops(identity: amber, dark: true)
    let lightStops = Theme.chromeStops(identity: amber, dark: false)
    check("chrome: deterministic — the same account gives the same stops",
          darkStops.map(hexString) == Theme.chromeStops(identity: amber, dark: true).map(hexString))
    let darkHSL = darkStops.map(Theme.hsl)
    let lightHSL = lightStops.map(Theme.hsl)
    let amberHue = Theme.hsl(amber).h
    check("chrome dark: the account hue, desaturated (S≈35%) and deep (L 13–17%)",
          darkStops.count == 3
              && darkHSL.allSatisfy { abs($0.h - amberHue) < 3 && abs($0.s - 0.35) < 0.03
                  && $0.l >= 0.13 && $0.l <= 0.17 })
    check("chrome light: the account hue, S≈30%, L 89–93%",
          lightStops.count == 3
              && lightHSL.allSatisfy { abs($0.h - amberHue) < 3 && abs($0.s - 0.30) < 0.03
                  && $0.l >= 0.89 && $0.l <= 0.93 })
    check("chrome: all accounts is espresso #2B211C → #261D18 → #2D221C (dark)",
          Theme.chromeStops(identity: nil, dark: true).map(hexString)
              == ["2B211C", "261D18", "2D221C"])
    check("chrome: all accounts is espresso #EDE5DE → #E8DFD7 (light)",
          Array(Theme.chromeStops(identity: nil, dark: false).map(hexString).prefix(2))
              == ["EDE5DE", "E8DFD7"])
    check("palette: amber, teal, coral first, six distinct hues, none purple",
          AccountIdentity.palette.prefix(3).map(hexString) == ["F5A524", "2DD4BF", "F87171"]
              && AccountIdentity.palette.count == 6
              && Set(AccountIdentity.palette.map(hexString)).count == 6
              && AccountIdentity.palette.allSatisfy { let h = Theme.hsl($0).h; return h < 250 || h > 320 })
    let inboxes = briefFixtureInboxes()
    check("identity: by stable account order, primary first; all accounts has none",
          AccountIdentity.color(accountId: nil, among: inboxes).map(hexString) == "F5A524"
              && AccountIdentity.color(accountId: "li-2", among: inboxes).map(hexString) == "2DD4BF"
              && AccountIdentity.color(selection: "all", among: inboxes) == nil
              && AccountIdentity.color(selection: "li-2", among: inboxes).map(hexString) == "2DD4BF"
              && AccountIdentity.color(accountId: "gone", among: inboxes) == nil)

    // MARK: contrast of the text tokens on their surfaces (≥4.5:1)
    for dark in [false, true] {
        let mode = dark ? "dark" : "light"
        let card = Theme.todayCardComponents(dark: dark)
        let raised = Theme.todayRaisedComponents(dark: dark)
        let chip = Theme.composite(Theme.todayChipComponents(dark: dark), over: raised)
        let inks: [(String, Theme.RGBA)] = [
            ("t1", Theme.todayInkComponents(1, dark: dark)),
            ("t2", Theme.todayInkComponents(2, dark: dark)),
            ("t3", Theme.todayInkComponents(3, dark: dark)),
            ("PUSH", Theme.todayPushInkComponents(dark: dark)),
        ]
        // Every ink sits on the card and on a raised card; only t2 (the
        // reason chip's text) also sits on a chip.
        for (name, ink) in inks {
            let surfaces = name == "t2" ? [card, raised, chip] : [card, raised]
            let ratios = surfaces.map { Theme.contrast(ink, $0) }
            print("    \(mode) \(name) on card / raised\(name == "t2" ? " / chip" : ""): "
                + ratios.map { String(format: "%.2f", $0) }.joined(separator: " / "))
            check("\(mode): \(name) clears 4.5:1 on every surface it sits on",
                  ratios.allSatisfy { $0 >= 4.5 })
        }
        var worstSidebar = Double.infinity
        for identity in [nil] + AccountIdentity.palette.map(Optional.some) {
            for stop in Theme.chromeStops(identity: identity, dark: dark) {
                let pill = Theme.composite(Theme.sidebarPillComponents(dark: dark), over: stop)
                for surface in [stop, pill] {
                    for level in [1, 2] {
                        let ink = Theme.composite(Theme.sidebarInkComponents(level, dark: dark), over: surface)
                        worstSidebar = min(worstSidebar, Theme.contrast(ink, surface))
                    }
                }
            }
        }
        print("    \(mode) sidebar ink, worst over every chrome tint and pill: "
            + String(format: "%.2f", worstSidebar))
        check("\(mode): sidebar text clears 4.5:1 on every account's chrome", worstSidebar >= 4.5)
        var worstMonogram = Double.infinity
        for step in 0..<36 {
            let fill = Theme.avatarFillComponents(hue: Double(step) * 10)
            worstMonogram = min(worstMonogram, Theme.contrast((1, 1, 1, 1), fill))
        }
        print("    monogram white on the worst hue: " + String(format: "%.2f", worstMonogram))
        check("\(mode): an avatar monogram clears 4.5:1 on every hashed hue", worstMonogram >= 4.5)
    }

    // MARK: the card count cap (6 + "N more")
    let eight = (1...8).map { briefFixtureItem("p\($0)") }
    let lane = TodayLane(tier: .push, style: .rows, count: 8, rows: eight)
    let capped = TodayBriefRules.cards(lane)
    check("cards: at most six, the rest is one \"N more\" link",
          capped.shown.map(\.id) == ["p1", "p2", "p3", "p4", "p5", "p6"] && capped.more == 2)
    // The lane's own row cap (12) never hides the true count.
    let truncated = TodayLane(tier: .push, style: .rows, count: 15, rows: Array(eight.prefix(4)))
    check("cards: the more count is the lane's count, not just the listed rows",
          TodayBriefRules.cards(truncated).shown.count == 4 && TodayBriefRules.cards(truncated).more == 11)
    check("cards: no lane, no cards", TodayBriefRules.cards(nil) == .init(shown: [], more: 0))
    check("cards: \"N more\" reads 외 N건 in Korean",
          String(format: text("today.cards.more", "ko"), 2) == "외 2건")
    check("cards: three per row", TodayBriefRules.cardsPerRow == 3)

    // MARK: the reason → title fallback
    let withReason = TodayBriefRules.cardText(reason: "payment due today", subject: "Invoice", snippet: "x")
    let noReason = TodayBriefRules.cardText(reason: nil, subject: "Invoice", snippet: "Due on 26 July")
    let bare = TodayBriefRules.cardText(reason: nil, subject: "Invoice", snippet: nil)
    check("card: the reason is the title, the subject the body",
          withReason == .init(title: "payment due today", body: "Invoice"))
    check("card: no reason → the subject is the title and the snippet the body",
          noReason == .init(title: "Invoice", body: "Due on 26 July")
              && bare == .init(title: "Invoice", body: nil))
    check("card: the queue placeholder reason never becomes a title",
          TodayBriefRules.cardText(
              reason: rowTierReason("Visible in queue for manual review"),  // wire-value
              subject: "S", snippet: nil).title == "S")

    // MARK: header kicker and faces
    let curve = BriefingStructure(
        dateLabel: "", headline: "", segments: [], curve: [1, 3, 0, 0, 0, 0, 0, 1, 0, 0, 2, 1],
        dayStartHour: 8, attention: [])
    check("kicker: free hours are the day shape's empty hours (server day-shape.ts)",
          TodayBriefRules.freeHours(curve) == 7 && TodayBriefRules.freeHours(nil) == nil)
    check("kicker: parts it cannot compute are left out",
          TodayBriefRules.kickerParts(date: nil, meetings: nil, freeHours: nil, text: korean).isEmpty
              && TodayBriefRules.kickerParts(date: "11월 13일 금요일", meetings: 2, freeHours: 5, text: korean)
              == ["11월 13일 금요일", "회의 2", "빈 시간 5시간"])
    check("monogram: two initials from a name, one from an address or a Korean name",
          TodayBriefRules.monogram("dana whitfield") == "DW" && TodayBriefRules.monogram("billing@vendor.io") == "B"
              && TodayBriefRules.monogram("김서연") == "김" && TodayBriefRules.monogram("") == "?")
    check("avatar hue: stable across runs (no per-process hashing)",
          TodayBriefRules.hue(for: "dana@datahost.example") == TodayBriefRules.hue(for: "dana@datahost.example")
              && TodayBriefRules.hue(for: "a") != TodayBriefRules.hue(for: "b")
              && (0..<360).contains(Int(TodayBriefRules.hue(for: "x"))))
    return results
}

private func hexString(_ c: Theme.RGBA) -> String {
    String(format: "%02X%02X%02X", Int((c.r * 255).rounded()), Int((c.g * 255).rounded()),
           Int((c.b * 255).rounded()))
}

private func briefFixtureInboxes() -> [InboxOption] {
    let json = """
    [{"id":null,"email":"you@gmail.example","kind":"primary","needsReconnect":false,"provider":"GOOGLE"},
     {"id":"li-2","email":"other@gmail.example","kind":"linked","needsReconnect":false,"provider":"GOOGLE"},
     {"id":"li-3","email":"you@icloud.example","kind":"linked","needsReconnect":false,"provider":"ICLOUD"}]
    """
    return (try? JSONDecoder().decode([InboxOption].self, from: Data(json.utf8))) ?? []
}

private func briefFixtureItem(_ id: String) -> FirewallItem {
    let json = """
    {"id":"\(id)","source":"email","sourceId":"s\(id)","type":"email","title":"t","tier":"PUSH",
     "priority":5,"surfacedAt":"2026-11-13T01:00:00Z"}
    """
    // A fixture that cannot decode is a broken check, not a skipped one.
    return try! JSONDecoder().decode(FirewallItem.self, from: Data(json.utf8))
}
