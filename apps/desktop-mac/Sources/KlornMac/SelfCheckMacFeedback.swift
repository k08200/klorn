import AppKit
import Foundation

// Self-check for the founder's DMG feedback (2026-11-13, LOCKED), run by
// `KlornMac --self-check`:
// 1. the assistant panel sits inside the content card, below the title bar,
//    its close button whole at every window width;
// 2. Today keeps the day in a sticky right column (a strip when narrow), and
//    each lane section shows three rows and "See all (N)";
// 3. an update button in the sidebar footer, on the existing self-update;
// 4. a light/dark toggle in the toolbar, on the existing appearance setting.
// Pure rules and source pins only: nothing opens a window, sends a key or
// touches the Keychain.

/// Every DMG-feedback check, as (name, passed).
@MainActor
func macFeedbackSelfChecks(sourceDir: URL) -> [(String, Bool)] {
    print("Mac DMG feedback (panel, Today column, sidebar update, theme toggle):")
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let files = swiftSources(under: sourceDir)
    func text(_ name: String) -> String {
        files.first { $0.lastPathComponent == name }
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
    func symbolExists(_ name: String) -> Bool {
        NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil
    }

    panelChecks(check, text: text, symbolExists: symbolExists)
    todayLayoutChecks(check, text: text)
    laneCapChecks(check, text: text)
    updateButtonChecks(check, text: text, symbolExists: symbolExists)
    themeToggleChecks(check, text: text, symbolExists: symbolExists)
    return results
}

// MARK: 1. assistant panel

@MainActor
private func panelChecks(
    _ check: (String, Bool) -> Void, text: (String) -> String, symbolExists: (String) -> Bool
) {
    // The unified compact title bar is ~38pt; 52 is the tall unified one.
    let titlebars: [CGFloat] = [28, 38, 52]
    let widths: [CGFloat] = [
        AssistantPanelRules.minContentWidth(panelVisible: true), 1280, 1440, 1728, 2560,
    ]
    let whole = widths.allSatisfy { width in
        titlebars.allSatisfy { bar in
            let panel = AssistantPanelRules.frame(windowWidth: width, windowHeight: 900, titlebarHeight: bar)
            let close = AssistantPanelRules.closeButtonFrame(panel: panel)
            return AssistantPanelRules.isWhollyVisible(close, windowWidth: width, titlebarHeight: bar)
                && panel.minY >= bar && panel.maxX < width
        }
    }
    check("panel: the close button sits whole inside the window, below the title bar, at every width",
          whole)
    let panel1440 = AssistantPanelRules.frame(windowWidth: 1440, windowHeight: 900, titlebarHeight: 38)
    let close1440 = AssistantPanelRules.closeButtonFrame(panel: panel1440)
    check("panel: the close target is ≥28pt and inside the panel",
          AssistantPanelRules.closeTarget >= 28 && close1440.width >= 28 && close1440.height >= 28
              && panel1440.contains(close1440))
    check("panel: a frame under the title bar (the old full-height column) fails the rule",
          !AssistantPanelRules.isWhollyVisible(
              CGRect(x: 1400, y: 6, width: 28, height: 28), windowWidth: 1440, titlebarHeight: 38)
              && !AssistantPanelRules.isWhollyVisible(
                  CGRect(x: 1420, y: 60, width: 28, height: 28), windowWidth: 1440, titlebarHeight: 38))
    let shell = text("MainShell.swift")
    let panel = text("AssistantPanel.swift")
    check("panel: the shell no longer lets the panel under the title bar",
          shell.contains("AssistantPanel()") && !shell.contains("AssistantPanel()\n                        .ignoresSafeArea")
              && !panel.contains("ignoresSafeArea"))
    check("panel: its own rounded container (contentCard radius), xmark close with a label",
          panel.contains("RoundedRectangle(cornerRadius: Theme.Radius.contentCard)")
              && panel.contains("Image(systemName: \"xmark\")")
              && panel.contains(".accessibilityLabel(L(\"assistant.dock.close.a11y\"))")
              && panel.contains("AssistantPanelRules.closeTarget")
              && symbolExists("xmark"))
    check("panel: the header title is the Assistant section's name",
          panel.contains("Text(L(\"section.assistant\"))") && L("section.assistant") != "section.assistant")
    let window = text("MainWindow.swift")
    check("toolbar: theme, then Assistant, then a trailing space so the trigger is off the edge",
          MainWindowRules.toolbarItems
              == [.flexibleSpace, ThemeToolbar.itemIdentifier, AssistantToolbar.itemIdentifier, .space]
              && window.contains("MainWindowRules.toolbarItems"))
}

// MARK: 2. Today layout

@MainActor
private func todayLayoutChecks(_ check: (String, Bool) -> Void, text: (String) -> String) {
    check("today: the calendar column is ~280pt",
          TodayLayoutRules.columnWidth == 280)
    check("today: a sticky column at ≥1100pt of content, a strip below",
          TodayLayoutRules.calendarPlacement(contentWidth: 1212) == .column
              && TodayLayoutRules.calendarPlacement(contentWidth: 1100) == .column
              && TodayLayoutRules.calendarPlacement(contentWidth: 1099) == .strip
              && TodayLayoutRules.calendarPlacement(contentWidth: 844) == .strip)
    // A 1440pt window: sidebar 220, card inset 8 → 1212 of content.
    let full = TodayLayoutRules.contentWidth(
        windowWidth: 1440, sidebarWidth: NavRules.sidebarWidth, panelVisible: false)
    let withPanel = TodayLayoutRules.contentWidth(
        windowWidth: 1440, sidebarWidth: NavRules.sidebarWidth, panelVisible: true)
    let narrow = TodayLayoutRules.contentWidth(
        windowWidth: 1100, sidebarWidth: NavRules.sidebarWidth, panelVisible: false)
    check("today: 1440 → column; 1440 with the assistant panel → strip; 1100 → strip",
          TodayLayoutRules.calendarPlacement(contentWidth: full) == .column
              && TodayLayoutRules.calendarPlacement(contentWidth: withPanel) == .strip
              && TodayLayoutRules.calendarPlacement(contentWidth: narrow) == .strip)
    let screen = text("TodayScreen.swift")
    check("today: the bottom schedule is gone; the strip sits under the headline, above the cards",
          !screen.contains("TodaySchedule()")
              && screen.contains("TodayCalendarColumn(")
              && screen.contains("TodayCalendarStrip(")
              && (screen.range(of: "TodayCalendarStrip(")?.lowerBound ?? screen.endIndex)
                  < (screen.range(of: "TodayPushCards(")?.lowerBound ?? screen.startIndex))
    check("today: the column keeps the P12 blocks (team free time, recent files)",
          text("TodayCalendarColumn.swift").contains("TodayExtras(")
              && text("TodayPanels.swift").contains("TodayFreeTimePanel(")
              && text("TodayPanels.swift").contains("TodayRecentFilesPanel()"))

    // Timeline: now marker and the next event.
    let iso = ISO8601DateFormatter()
    func event(_ id: String, _ start: String, _ end: String, allDay: Bool = false) -> CalendarEventWire {
        CalendarEventWire(
            id: id, title: id, startTime: start, endTime: end, location: nil, meetingLink: nil, allDay: allDay)
    }
    let now = iso.date(from: "2026-07-29T08:30:00Z") ?? Date()
    let current = event("t1", "2026-07-29T08:00:00Z", "2026-07-29T09:00:00Z")
    let standup = event("t2", "2026-07-29T09:30:00Z", "2026-07-29T09:45:00Z")
    let review = event("t3", "2026-07-29T10:00:00Z", "2026-07-29T11:00:00Z")
    let call = event("t4", "2026-07-29T11:30:00Z", "2026-07-29T12:00:00Z")
    let summary = TodaySummary(total: 4, current: current, upcoming: [standup, review, call], nextEvent: nil)
    let entries = TodayTimelineRules.entries(summary, now: now)
    check("timeline: events in order, the current one marked, the next one highlighted",
          entries.map(\.event.id) == ["t1", "t2", "t3", "t4"]
              && entries.map(\.isNow) == [true, false, false, false]
              && entries.map(\.isNext) == [false, true, false, false])
    check("timeline: the now marker goes after the running event, before the next",
          TodayTimelineRules.nowMarkerIndex(entries, now: now) == 1
              && TodayTimelineRules.nowMarkerIndex([], now: now) == nil)
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC") ?? .current
    let slots = TodayTimelineRules.freeSlots(
        events: [current, standup, review, call], now: now, calendar: utc)
    // 08:30 now: 09:00–09:30 (30 min), not 09:45–10:00 (15), 11:00–11:30, then after 12:00.
    check("free time: gaps of 30 min or more from now, then the rest of the day",
          slots.map { $0.start } == [
              iso.date(from: "2026-07-29T09:00:00Z"), iso.date(from: "2026-07-29T11:00:00Z"),
              iso.date(from: "2026-07-29T12:00:00Z"),
          ].compactMap { $0 }
              && slots.first?.end == iso.date(from: "2026-07-29T09:30:00Z")
              && slots.last?.end == nil)
    let allDayOnly = TodayTimelineRules.freeSlots(
        events: [event("a", "2026-07-29T00:00:00Z", "2026-07-30T00:00:00Z", allDay: true)],
        now: now, calendar: utc)
    check("free time: an all-day event does not eat the day; past events are ignored",
          allDayOnly.count == 1 && allDayOnly.first?.start == now && allDayOnly.first?.end == nil
              && TodayTimelineRules.freeSlots(
                  events: [event("p", "2026-07-29T06:00:00Z", "2026-07-29T07:00:00Z")],
                  now: now, calendar: utc).first?.start == now)
}

// MARK: 2b. lane sections

@MainActor
private func laneCapChecks(_ check: (String, Bool) -> Void, text: (String) -> String) {
    check("lanes: MEETING / QUEUE / INFO show at most 3 rows on Today",
          TodayRules.compactRowLimit == 3)
    let rows = (1...7).map { index in
        fbItem("q\(index)")
    }
    let lane = TodayLane(tier: .queue, count: 20, rows: rows)
    let compact = TodayLaneRules.compact(lane)
    check("lanes: a 20-item lane lists 3 rows and \"See all (20)\"",
          compact.rows.map(\.id) == ["q1", "q2", "q3"] && compact.seeAllCount == 20)
    let small = TodayLaneRules.compact(TodayLane(tier: .info, count: 2, rows: Array(rows.prefix(2))))
    check("lanes: a short lane lists what it has and counts it",
          small.rows.count == 2 && small.seeAllCount == 2)
    check("lanes: the link reads \"모두 보기 (N)\" / \"See all (N)\" with %d",
          fbText("today.seeAllCount", language: "ko") == "모두 보기 (%d)"
              && fbText("today.seeAllCount", language: "en") == "See all (%d)"
              && text("TodayLaneSections.swift").contains("L(\"today.seeAllCount\", compact.seeAllCount)"))
}

// MARK: 3. sidebar update button

@MainActor
private func updateButtonChecks(
    _ check: (String, Bool) -> Void, text: (String) -> String, symbolExists: (String) -> Bool
) {
    typealias R = SidebarUpdateRules
    check("update: idle, or straight to \"install\" when a newer build is already known",
          R.initial(available: nil) == .idle && R.initial(available: "0.4.9") == .available("0.4.9"))
    check("update: tap from idle checks; a result lands on available / up to date / failed",
          R.reduce(.idle, .tapped) == .checking
              && R.reduce(.checking, .checkFinished(.updateAvailable("0.4.9"))) == .available("0.4.9")
              && R.reduce(.checking, .checkFinished(.upToDate)) == .upToDate
              && R.reduce(.checking, .checkFinished(.unknown)) == .failed(retryVersion: nil))
    check("update: tap on available installs; a fallback is an error that retries the install",
          R.reduce(.available("0.4.9"), .tapped) == .installing("0.4.9")
              && R.reduce(.installing("0.4.9"), .installFellBack) == .failed(retryVersion: "0.4.9")
              && R.reduce(.failed(retryVersion: "0.4.9"), .tapped) == .installing("0.4.9")
              && R.reduce(.failed(retryVersion: nil), .tapped) == .checking)
    check("update: taps while busy do nothing; up to date returns to idle after a few seconds",
          R.reduce(.checking, .tapped) == .checking
              && R.reduce(.installing("0.4.9"), .tapped) == .installing("0.4.9")
              && R.reduce(.upToDate, .upToDateExpired) == .idle
              && R.reduce(.available("0.4.9"), .upToDateExpired) == .available("0.4.9")
              && R.upToDateSeconds >= 2 && R.upToDateSeconds <= 5)
    check("update: idle uses arrow.down.circle; busy states spin; available is emphasized",
          R.symbol(.idle) == "arrow.down.circle" && symbolExists("arrow.down.circle")
              && R.showsSpinner(.checking) && R.showsSpinner(.installing("1"))
              && !R.showsSpinner(.idle) && R.isEmphasized(.available("1")) && !R.isEmphasized(.idle))
    check("update: the labels (ko)",
          R.title(.idle, text: { fbText($0, language: "ko") }) == "업데이트 확인"
              && R.title(.available("0.4.9"), text: { fbText($0, language: "ko") })
                  == "새 버전 설치 · v0.4.9"
              && R.title(.upToDate, text: { fbText($0, language: "ko") }) == "최신 버전")
    let sidebar = text("NavSidebar.swift")
    let button = text("SidebarUpdateButton.swift")
    check("update: the button sits above Settings in the sidebar footer",
          (sidebar.range(of: "SidebarUpdateButton()")?.lowerBound ?? sidebar.endIndex)
              < (sidebar.range(of: "Text(L(\"prefs.title\"))")?.lowerBound ?? sidebar.startIndex))
    check("update: it runs the existing pipeline (check seam, SelfUpdate.run), never its own",
          button.contains("await model.checkForUpdateNow()")
              && button.contains("await SelfUpdate.run(version: version)")
              && !button.contains("URLSession") && !button.contains("releaseZipURL"))
    check("update: Settings ▸ General keeps its own update row",
          text("PreferencesView.swift").contains("private var updatesRow: some View"))
}

// MARK: 4. theme toggle

@MainActor
private func themeToggleChecks(
    _ check: (String, Bool) -> Void, text: (String) -> String, symbolExists: (String) -> Bool
) {
    typealias R = ThemeToggleRules
    check("theme: System + effective dark → Light; System + effective light → Dark",
          R.next(effectiveDark: true) == .light && R.next(effectiveDark: false) == .dark)
    check("theme: explicit choices resolve their own appearance; System follows the OS",
          R.isEffectivelyDark(choice: .dark, systemDark: false)
              && !R.isEffectivelyDark(choice: .light, systemDark: true)
              && R.isEffectivelyDark(choice: .system, systemDark: true)
              && !R.isEffectivelyDark(choice: .system, systemDark: false))
    check("theme: the symbol shows the current appearance (sun.max light, moon dark), both exist",
          R.symbol(effectiveDark: false) == "sun.max" && R.symbol(effectiveDark: true) == "moon"
              && symbolExists("sun.max") && symbolExists("moon"))
    check("theme: the label names the action (ko)",
          fbText(R.actionKey(effectiveDark: false), language: "ko") == "다크 모드로 전환"
              && fbText(R.actionKey(effectiveDark: true), language: "ko") == "라이트 모드로 전환")
    let toggle = text("ThemeToggle.swift")
    check("theme: the toolbar writes the shared appearance setting (Settings stays in sync)",
          toggle.contains("appearance = ThemeToggleRules.next(")
              && text("MainWindow.swift").contains("ThemeToolbar.makeItem("))
    check("theme: the button follows the effective appearance live (KVO on NSApp)",
          text("MainWindow.swift").contains("observe(\\.effectiveAppearance")
              && text("MainShell.swift").contains("Theme.chromeGradient(identity: chromeIdentity)"))
}

/// One key in one shipped language; the key itself when missing, so a
/// missing string fails the comparison instead of passing as nil.
@MainActor
private func fbText(_ key: String, language: String) -> String {
    L10n.value(key, language: language) ?? key
}

private func fbItem(_ id: String) -> FirewallItem {
    let json = """
    {"id":"\(id)","source":"email","sourceId":"s\(id)","type":"email","title":"t","tier":"QUEUE",
     "priority":5,"surfacedAt":"2026-11-13T01:00:00Z"}
    """
    // A fixture that cannot decode is a broken check, not a skipped one.
    return try! JSONDecoder().decode(FirewallItem.self, from: Data(json.utf8))
}
