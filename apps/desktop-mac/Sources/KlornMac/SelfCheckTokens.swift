import AppKit
import Foundation

// Self-check for the main window's design tokens and the one-badge row rule
// (productization plan §1–§2, macOS M7), run by `KlornMac --self-check`.
//
// Three kinds of check: colour math on pure components (no NSColor, so the
// verdict never depends on the machine's appearance), pure rules, and a
// source guard that keeps the main window's own files on the tokens.

/// The files that draw only in the main window (`macMainWindow`). They are
/// held at zero raw style literals; the bar's files are not, until M8.
enum TokenGuard {
    static let scope = [
        "Shell/MainShell", "Shell/NavSidebar", "Shell/MainNav", "Shell/MainSheets", "Today/",
        "Mail/MailSection", "Mail/ComposeWindow", "Mail/WindowMailRow", "Mail/WindowLaneChip",
        "Calendar/CalendarSection", "Assistant/AssistantSection", "Onboarding/",
        "Shared/SurfaceState", "Shared/SegmentedBar",
    ]

    static func inScope(_ relativePath: String) -> Bool {
        scope.contains { relativePath.hasPrefix($0) }
    }

    private static func matches(_ pattern: String, in line: String) -> [[String]] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(line.startIndex..., in: line)
        return regex.matches(in: line, range: range).map { match in
            (0..<match.numberOfRanges).map { index in
                Range(match.range(at: index), in: line).map { String(line[$0]) } ?? ""
            }
        }
    }

    /// The argument list of every `.padding(` on the line, parentheses matched.
    private static func paddingArguments(in line: String) -> [String] {
        var found: [String] = []
        var rest = Substring(line)
        while let open = rest.range(of: ".padding(") {
            var depth = 1
            var index = open.upperBound
            while index < rest.endIndex, depth > 0 {
                if rest[index] == "(" { depth += 1 }
                if rest[index] == ")" { depth -= 1 }
                if depth > 0 { index = rest.index(after: index) }
            }
            found.append(String(rest[open.upperBound..<index]))
            rest = rest[index...]
        }
        return found
    }

    private static let colorNames =
        "orange|green|red|blue|yellow|pink|purple|gray|white|black|mint|teal|cyan|indigo|brown"
            + "|primary|secondary|tertiary"

    /// What one line of a main-window file does wrong; empty when clean.
    /// Pure, so the self-check can pin the rules themselves.
    static func offenses(in rawLine: String) -> [String] {
        let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("//") { return [] }
        let line = rawLine.components(separatedBy: " //").first ?? rawLine
        var found: [String] = []
        // Type: only the six roles. A system text style (`.caption` is 10pt)
        // or a sized system font is a raw literal.
        if line.contains(".font(.") || line.contains("Font.system(") || line.contains("Font.custom(") {
            found.append("font outside Theme.Typo")
        }
        if line.contains("Typo.micro") { found.append("the retired 10pt micro step") }
        // Radius: 6 / 10 / 16 by name; pills are a Capsule shape.
        for match in matches("cornerRadius:\\s*([^,)\\s]+)", in: line)
        where !match[1].hasPrefix("Theme.Radius.") {
            found.append("cornerRadius not from Theme.Radius")
        }
        // Colour: Theme only.
        if !matches("(Color\\.|[(:?,]\\s*\\.)(\(colorNames))\\b", in: line).isEmpty
            || !matches("Color\\((red|white|hue|nsColor|\\.sRGB|\\.displayP3)", in: line).isEmpty
            || line.contains("NSColor.")
        {
            found.append("colour outside Theme")
        }
        // Spacing: the 4pt grid by name. Zero is not a size.
        for arguments in paddingArguments(in: line) {
            let withoutNames = arguments.replacingOccurrences(
                of: "\\.?[A-Za-z_][A-Za-z0-9_]*", with: "", options: .regularExpression)
            let numbers = matches("[0-9]+(\\.[0-9]+)?", in: withoutNames).map { $0[0] }
            if numbers.contains(where: { Double($0) != 0 }) {
                found.append("padding not from Theme.s*")
            }
        }
        return found
    }

    /// Every offense in the scoped files, as "path:line: what".
    static func offenders(sourceDir: URL) -> (files: Int, offenses: [String]) {
        var files = 0
        var offenses: [String] = []
        for url in swiftSources(under: sourceDir) {
            let path = String(url.path.dropFirst(sourceDir.path.count + 1))
            guard inScope(path), let text = try? String(contentsOf: url, encoding: .utf8) else {
                continue
            }
            files += 1
            for (index, line) in text.components(separatedBy: "\n").enumerated() {
                for offense in Self.offenses(in: line) {
                    offenses.append("\(path):\(index + 1): \(offense)")
                }
            }
        }
        return (files, offenses.sorted())
    }
}

/// Every M7 check, as (name, passed). Prints its own section and tables.
func tokenSelfChecks(sourceDir: URL) -> [(String, Bool)] {
    print("Design tokens and the one-badge row (M7):")
    var results: [(String, Bool)] = []
    func text(_ relativePath: String) -> String {
        (try? String(contentsOf: sourceDir.appendingPathComponent(relativePath), encoding: .utf8))
            ?? ""
    }

    // Lane chip: text on its own 13% wash, on every surface it sits on.
    for dark in [false, true] {
        let mode = dark ? "dark" : "light"
        let surfaces = Theme.windowSurfaces(dark: dark)
        print("    \(mode) chip contrast — " + surfaces.map(\.name).joined(separator: " / "))
        for tier in Tier.allCases {
            let ratios = surfaces.map { Theme.chipContrast(tier, dark: dark, on: $0.color) }
            print("      \(tier.rawValue): "
                + ratios.map { String(format: "%.2f", $0) }.joined(separator: " / "))
            results.append((
                "\(mode): the \(tier.rawValue) chip clears 4.5:1 on every surface",
                ratios.allSatisfy { $0 >= 4.5 }))
        }
        let inks: [(String, Theme.RGBA)] = dark
            ? [("warning", Theme.warningInkDark), ("danger", Theme.dangerInkDark),
               ("success", Theme.successInkDark)]
            : [("warning", Theme.warningInkLight), ("danger", Theme.dangerInkLight),
               ("success", Theme.successInkLight)]
        results.append((
            "\(mode): the status inks clear 4.5:1 on every surface",
            inks.allSatisfy { ink in
                surfaces.allSatisfy { Theme.contrast(ink.1, $0.color) >= 4.5 }
            }))
    }
    results.append((
        "the bar's chip is the old one; the main window's is the measured one",
        text("Shared/LaneChip.swift").contains("var style: ShellStyle = .bar")
            && text("Mail/WindowLaneChip.swift").contains("Theme.chipInk(tier)")
            && text("Mail/WindowLaneChip.swift").contains(".font(Theme.Typo.label)")))

    // The scale itself.
    results.append((
        "three radii (6 / 10 / 16) and the spacing grid (4 … 48)",
        [Theme.Radius.sm, Theme.Radius.md, Theme.Radius.lg] == [6, 10, 16]
            && [Theme.s1, Theme.s2, Theme.s3, Theme.s4, Theme.s6, Theme.s8, Theme.s12]
                == [4, 8, 12, 16, 24, 32, 48]
            && Theme.rowHeight == 52))
    results.append((
        "elevation and motion carry the plan's numbers",
        Theme.Elevation.l2.opacity == 0.12 && Theme.Elevation.l2.y == 8
            && Theme.Elevation.l3.opacity == 0.18 && Theme.Elevation.l3.y == 24
            && Theme.Motion.state == 0.12 && Theme.Motion.enter == 0.20
            && Theme.Motion.exit == 0.16))

    // The guard's own rules, then the files.
    let bad = [
        ".font(.caption)", ".font(.system(size: 10))", ".font(Theme.Typo.micro)",
        "RoundedRectangle(cornerRadius: 8)", ".foregroundStyle(.orange)", "Color.white",
        "x ? .red : .green", "Color(red: 1, green: 0, blue: 0)", ".padding(22)",
        ".padding(.horizontal, 10)", ".padding(.top, Theme.s6 * 2)",
    ]
    let good = [
        ".font(Theme.Typo.caption.monospacedDigit())", ".padding(.horizontal, Theme.s3)",
        "RoundedRectangle(cornerRadius: Theme.Radius.md)", ".padding(compact ? 0 : Theme.s6)",
        "// .font(.caption) in a comment", ".foregroundStyle(hovering ? Theme.text : .clear)",
        ".frame(maxWidth: .infinity, alignment: .top)", ".padding(.top, Theme.s12)",
    ]
    results.append((
        "the guard flags every raw literal and passes the tokens",
        bad.allSatisfy { !TokenGuard.offenses(in: $0).isEmpty }
            && good.allSatisfy { TokenGuard.offenses(in: $0).isEmpty }))
    let scan = TokenGuard.offenders(sourceDir: sourceDir)
    print("    token guard: \(scan.files) main-window files, \(scan.offenses.count) offenses")
    for offense in scan.offenses { print("      \(offense)") }
    results.append(("the guard reads the main window's files", scan.files >= 14))
    results.append(("the main window's files hold zero raw style literals", scan.offenses.isEmpty))

    // One-badge rule.
    let row = text("Mail/WindowMailRow.swift")
    let today = text("Today/TodayScreen.swift")
    let banned = ["SignalChip(", "ReplyStateChip(", "AddLabelChip(", "rowTierReason("]
    results.append((
        "a main-window row carries no category, relationship, reply-state or reason",
        !row.isEmpty && !today.isEmpty
            && banned.allSatisfy { !row.contains($0) && !today.contains($0) }))
    results.append((
        "the lane chip shows on mixed-lane lists only",
        tokenFixtureItem().map {
            WindowRowRules.lane(for: $0, mixedLanes: true) == .queue
                && WindowRowRules.lane(for: $0, mixedLanes: false) == nil
        } ?? false))
    results.append((
        "a firewall row claims no read state and no account; the snippet is its second line",
        tokenFixtureItem().map {
            let content = WindowRowRules.content(for: $0, mixedLanes: false, now: Date())
            return content.unread == nil && !content.showsAccount
                && content.sender == "dana@vendor.example" && content.subject == "renewal"
                && content.snippet == "quote is attached"
        } ?? false))
    let inboxes = tokenFixtureInboxes()
    let hit = EmailSearchItem(
        id: "s1", from: "Dana <dana@vendor.example>", subject: "Renewal", snippet: "Renewal",
        date: nil, isRead: false, linkedInboxAccountId: "linked-1")
    let hitContent = WindowRowRules.content(for: hit, inboxes: inboxes, now: Date())
    let single = WindowRowRules.content(for: hit, inboxes: Array(inboxes.prefix(1)), now: Date())
    results.append((
        "a search row shows unread and its account, and never echoes the subject as a snippet",
        inboxes.count == 2 && hitContent.unread == true && hitContent.showsAccount
            && hitContent.provider == "NAVER" && hitContent.snippet == nil
            && !single.showsAccount))
    results.append((
        "the reader header says what the row no longer does, in words",
        ReaderMetaRules.parts(signal: .category("customer"), replyState: "needsReply", draftReady: false)
            == [L("chip.customer"), L("chip.needsReply")]
            && ReaderMetaRules.parts(signal: .first, replyState: "needsReply", draftReady: true)
                == [L("chip.first"), L("chip.draftReady")]
            && ReaderMetaRules.parts(signal: .replied(3), replyState: nil, draftReady: false)
                == [L("chip.replied", 3)]
            && ReaderMetaRules.parts(signal: nil, replyState: "unknown", draftReady: false).isEmpty))
    results.append((
        "only the main window asks for the new look; every shared view defaults to the bar's",
        text("Mail/MailSection.swift").contains("rowStyle: .window")
            && text("Mail/MailSection.swift").contains("style: .window")
            && text("Calendar/CalendarSection.swift").contains("style: .window")
            && !text("Shell/FullView.swift").contains(".window")
            && text("Mail/MailRow.swift").components(separatedBy: "var style: MailRowStyle = .legacy").count == 3
            && text("Mail/FullList.swift").contains("var rowStyle: MailRowStyle = .legacy")
            && text("Mail/ReadingPane.swift").contains("var style: ShellStyle = .bar")
            && text("Calendar/CalendarScreen.swift").contains("style: ShellStyle = .bar")
            && text("Theme.swift").contains("var style: ShellStyle = .bar")))

    // Calendar month grid.
    let tall = CalendarMetrics.monthRowHeight(available: 1000, weeks: 5)
    results.append((
        "the month's weeks share the height; never under the floor, never past it",
        tall == 199 && tall * 5 + 4 <= 1000
            && CalendarMetrics.monthRowHeight(available: 1000, weeks: 6) == 165
            && CalendarMetrics.monthRowHeight(available: 300, weeks: 6) == CalendarMetrics.minMonthRow
            && CalendarMetrics.monthRowHeight(available: 0, weeks: 0) == CalendarMetrics.minMonthRow))

    // Title bar.
    let window = text("MainWindow.swift")
    let usable = NSSize(width: 900, height: 600)
    results.append((
        "the main window's title bar is transparent over full-size content, sizes unchanged",
        MainWindowRules.styleMask.isSuperset(
            of: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView])
            && window.contains("titlebarAppearsTransparent = true")
            && MainWindowRules.titlebarInset(frameHeight: 668, layoutHeight: 640) == 28
            && MainWindowRules.titlebarInset(frameHeight: 600, layoutHeight: 640) == 0
            && MainWindowRules.contentSize(usable: usable, titlebarInset: 28)
                == NSSize(width: 900, height: 628)
            && text("Shell/MainShell.swift").contains("Theme.bg.ignoresSafeArea()")))
    results.append(("the new string is localized", L("mail.unread") != "mail.unread"))
    return results
}

private func tokenFixtureItem() -> FirewallItem? {
    let json = """
        {"id":"i1","source":"EMAIL","sourceId":"m1","type":"EMAIL","title":"renewal",
         "tier":"QUEUE","tierReason":"vendor","priority":1,
         "surfacedAt":"2026-07-29T05:00:00.000Z",
         "email":{"emailDbId":"e1","subject":"renewal",
                  "from":"dana@vendor.example",
                  "snippet":"quote\\n is  attached","receivedAt":"2026-07-29T05:00:00.000Z",
                  "signal":{"kind":"replied","count":3},"replyState":"needsReply"}}
        """
    return try? JSONDecoder().decode(FirewallItem.self, from: Data(json.utf8))
}

private func tokenFixtureInboxes() -> [InboxOption] {
    let json = """
        [{"id":null,"email":"you@company.example","kind":"primary","needsReconnect":false,
          "provider":"GOOGLE"},
         {"id":"linked-1","email":"you@naver.example","kind":"linked","needsReconnect":false,
          "provider":"NAVER"}]
        """
    return (try? JSONDecoder().decode([InboxOption].self, from: Data(json.utf8))) ?? []
}
