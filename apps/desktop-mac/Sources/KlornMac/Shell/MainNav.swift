import Foundation

/// The main window's primary navigation (productization plan §1, macOS M4b).
/// Files joins this list only once a drive source exists (FD-7); there is
/// none yet, so it has no case.
enum NavSection: String, CaseIterable, Identifiable, Sendable {
    case today, mail, calendar, assistant

    var id: String { rawValue }

    var title: String { L("nav.\(rawValue)") }

    var icon: String {
        switch self {
        case .today: "sun.max"
        case .mail: "envelope"
        case .calendar: "calendar"
        // A conversation, not a sparkle (FeatureIcon's rule).
        case .assistant: "bubble.left"
        }
    }
}

/// What Assistant's list column shows next to the thread.
enum AssistantPane: String, CaseIterable, Identifiable, Sendable {
    case approvals, commitments, briefing

    var id: String { rawValue }

    var title: String { L("assistant.pane.\(rawValue)") }
}

/// Mail's primary filter: the lanes, plus the unfiltered list. SILENT is not
/// a segment; it is reached through "Show silenced".
enum LaneFilter: String, CaseIterable, Identifiable, Sendable {
    case push, meeting, queue, info, all

    var id: String { rawValue }

    var tier: Tier? {
        switch self {
        case .push: .push
        case .meeting: .meeting
        case .queue: .queue
        case .info: .info
        case .all: nil
        }
    }

    var title: String { tier?.label ?? L("mail.lane.all") }
}

/// Where the main window is. `ListMode` stays the source of truth for what
/// a list column shows (every existing deep link writes it); this adds the
/// part ListMode cannot say: Today, and Assistant's pane.
struct MainNav: Equatable, Sendable {
    var section: NavSection = .today
    var assistantPane: AssistantPane = .approvals
    /// The mail facet to return to when Mail is entered from another section.
    var lastMailMode: ListMode = NavRules.defaultMailMode
}

/// Pure navigation rules for the main window, pinned by the self-check.
enum NavRules {
    /// QUEUE is Mail's default lane (productization plan §1).
    static let defaultMailMode: ListMode = .tier(.queue)
    static let sidebarWidth: CGFloat = 220
    static let listColumnWidth: CGFloat = 420
    /// One height for every section's top row, so the hairline under it
    /// runs straight across the columns.
    static let topBarHeight: CGFloat = 52

    /// The section that owns an existing list mode: lanes, labels and
    /// folders are Mail facets; proposals and commitments live under
    /// Assistant; teams lives in Calendar.
    static func section(for mode: ListMode) -> NavSection {
        switch mode {
        case .inbox, .label, .tier, .mailbox, .waitingOn: .mail
        case .calendar, .teams: .calendar
        case .proposals, .commitments: .assistant
        }
    }

    /// The navigation after `mode` was written (a click, the Go menu, a
    /// deep link from the pill or a card): the window follows it.
    static func following(_ mode: ListMode, from nav: MainNav) -> MainNav {
        var next = nav
        next.section = section(for: mode)
        if mode.isMailFamily { next.lastMailMode = mode }
        if mode == .proposals { next.assistantPane = .approvals }
        if mode == .commitments { next.assistantPane = .commitments }
        return next
    }

    /// The list mode to write when the user picks `section`, or nil when
    /// the section has none of its own (Today, Assistant's briefing).
    static func listMode(entering section: NavSection, nav: MainNav, current: ListMode) -> ListMode? {
        switch section {
        case .today:
            return nil
        case .mail:
            return current.isMailFamily ? current : nav.lastMailMode
        case .calendar:
            return self.section(for: current) == .calendar ? current : .calendar
        case .assistant:
            return listMode(for: nav.assistantPane)
        }
    }

    static func listMode(for pane: AssistantPane) -> ListMode? {
        switch pane {
        case .approvals: .proposals
        case .commitments: .commitments
        case .briefing: nil
        }
    }

    static func listMode(for filter: LaneFilter) -> ListMode {
        filter.tier.map { .tier($0) } ?? .inbox
    }

    /// The segment a mail mode lights, or nil for a folder, a label or the
    /// silenced lane (none of which is a segment).
    static func laneFilter(for mode: ListMode) -> LaneFilter? {
        switch mode {
        case .inbox: .all
        case .tier(let tier): LaneFilter.allCases.first { $0.tier == tier }
        default: nil
        }
    }

    static func showsSilenced(_ mode: ListMode) -> Bool { mode == .tier(.silent) }

    /// The mail mode that shows an item opened from outside Mail (Today, a
    /// PUSH card): stay put when the current facet already lists it,
    /// otherwise go to the item's lane.
    static func mailMode(showing tier: Tier, current: ListMode) -> ListMode {
        current == .inbox || current == .tier(tier) ? current : .tier(tier)
    }

    /// First open of the main window. An untouched model (the bar's default
    /// `.inbox`, still on Today) lands on Today with QUEUE waiting in Mail;
    /// anything a deep link already chose is kept.
    static func initial(listMode: ListMode, nav: MainNav) -> (mode: ListMode, nav: MainNav) {
        guard listMode == .inbox, nav == MainNav() else { return (listMode, nav) }
        return (defaultMailMode, nav)
    }

    /// The main window shows the reader only in Mail; the bar's full view
    /// (flag off) always has it.
    static func readerVisible(macMainWindow: Bool, section: NavSection) -> Bool {
        !macMainWindow || section == .mail
    }

    /// Whether arriving at `section` drops the reading-pane selection: only
    /// in the main window, and only when the reader goes off screen.
    static func clearsSelection(macMainWindow: Bool, section: NavSection) -> Bool {
        !readerVisible(macMainWindow: macMainWindow, section: section)
    }

    /// Mail's sidebar count: everything a lane segment can show. SILENT is
    /// never counted (it is never shown unasked).
    static func mailCount(_ count: (Tier) -> Int) -> Int {
        LaneFilter.allCases.compactMap(\.tier).reduce(0) { $0 + count($1) }
    }

    /// Go-menu digit for a section. Assistant is 4 while Files does not
    /// exist; 5 goes to Approvals, the old menu's most-used numbered target.
    static func shortcutDigit(for section: NavSection) -> Int {
        (NavSection.allCases.firstIndex(of: section) ?? 0) + 1
    }

    /// Existing Go destinations kept reachable under the sections. Inbox and
    /// Calendar are the sections themselves now.
    static let secondaryDestinations: [ListMode] = [
        .proposals, .commitments, .waitingOn,
        .mailbox(.sent), .mailbox(.drafts), .mailbox(.archived), .teams,
    ]

    /// The one secondary destination that keeps a digit (⌘5).
    static let numberedSecondary: ListMode = .proposals
    static let numberedSecondaryDigit = 5
}

/// Neutral monochrome source glyph (productization plan §2): G, M, N, iC,
/// IMAP, K. No provider is Klorn's own; a provider this build does not know
/// is a generic mail source ("@"), never mislabeled as one it knows. Pure for
/// the harness.
func sourceMonogram(provider: String?) -> String {
    switch provider?.uppercased() {
    case "GOOGLE", "GMAIL": "G"
    case "MICROSOFT", "OUTLOOK": "M"
    case "NAVER": "N"
    case "ICLOUD", "APPLE": "iC"
    case "IMAP": "IMAP"
    case nil, "KLORN": "K"
    default: "@"
    }
}

/// The provider's name as VoiceOver says it, beside the monogram's letters.
/// Brand names are not translated; the generic one is. Pure for the harness.
func sourceName(provider: String?) -> String {
    switch provider?.uppercased() {
    case "GOOGLE", "GMAIL": "Google"
    case "MICROSOFT", "OUTLOOK": "Microsoft"
    case "NAVER": "Naver"
    case "ICLOUD", "APPLE": "iCloud"
    case "IMAP": "IMAP"
    case nil, "KLORN": "Klorn"
    default: L("source.generic")
    }
}

/// "Google account, you@company.example": the account as a row or the reader
/// header says it. The address is left out when there is none. Pure.
func sourceA11yLabel(provider: String?, label: String?) -> String {
    let account = L("source.account.a11y", sourceName(provider: provider))
    guard let label, !label.trimmingCharacters(in: .whitespaces).isEmpty else { return account }
    return account + ", " + label
}

extension AppModel {
    /// Sidebar / Go-menu navigation in the main window.
    func navigate(to section: NavSection) {
        if let mode = NavRules.listMode(entering: section, nav: mainNav, current: listMode),
           mode != listMode
        {
            go(to: mode)
        }
        // After go(): the list mode's own follow rule must not win over an
        // explicit section pick (Today and briefing write no list mode).
        mainNav.section = section
        // No list mode was written for Today or the briefing, so the
        // didSet rule did not run: drop the off-screen selection here.
        if section != .mail { clearSelection() }
    }

    func showAssistantPane(_ pane: AssistantPane) {
        if let mode = NavRules.listMode(for: pane), mode != listMode { go(to: mode) }
        mainNav.assistantPane = pane
        mainNav.section = .assistant
        clearSelection()  // the reader is not on screen in Assistant
    }

    func showLane(_ filter: LaneFilter) {
        go(to: NavRules.listMode(for: filter))
    }

    /// Put Mail on a facet that lists `item`, so selecting it shows the row
    /// and the reader together.
    func revealInMail(_ item: FirewallItem) {
        listMode = NavRules.mailMode(showing: item.tier, current: mainNav.lastMailMode)
        sidebarLevel = .mail
    }

    /// Called once when the main window is first built.
    func prepareMainNavigation() {
        let start = NavRules.initial(listMode: listMode, nav: mainNav)
        guard start.mode != listMode else { return }
        // Order matters: writing `listMode` runs its didSet, which moves
        // `mainNav.section` to Mail. `mainNav` is assigned AFTER it, so the
        // window still opens on Today with QUEUE waiting in Mail. Swapping
        // the two lines opens the window on Mail.
        listMode = start.mode
        mainNav = start.nav
    }
}
