import AppKit
import Foundation
import Observation

/// User preferences, persisted in UserDefaults so they survive relaunch. Kept
/// tiny and sensibly defaulted; the default-resolution logic is pure and
/// exercised by the `--self-check` harness.
@MainActor
@Observable
final class AppSettings {
    static let notificationsKey = "klorn.notificationsEnabled"
    static let pillVisibleKey = "klorn.pillVisible"
    static let shortcutKey = "klorn.toggleShortcut"
    static let showInDockKey = "klorn.showInDock"
    static let fullWindowSizeKey = "klorn.fullWindowSize"
    static let expandedWindowSizeKey = "klorn.expandedWindowSize"
    static let hasLaunchedKey = "klorn.hasLaunchedBefore"
    static let loadRemoteImagesKey = "klorn.mail.loadRemoteImages"
    static let readingBandExpandedKey = "klorn.reading.bandExpanded"
    static let appearanceKey = "klorn.appearance"
    static let inboxSectionHeightKey = "klorn.inboxSectionHeight"
    static let upcomingSectionHeightKey = "klorn.upcomingSectionHeight"
    static let todaySectionHeightKey = "klorn.todaySectionHeight"
    static let accountSectionHeightKey = "klorn.sidebar.accountHeight"
    /// Un-prefixed on purpose: it is the documented developer switch
    /// (`defaults write ai.klorn.desktop macMainWindow -bool YES`).
    static let macMainWindowKey = "macMainWindow"

    private let defaults: UserDefaults

    /// Fired when the user changes the toggle shortcut, so the app can
    /// re-register the Carbon hotkey. Not persisted (wired at launch).
    var onShortcutChanged: ((Shortcut) -> Void)?

    /// Fired when the Preferences recorder starts/stops capturing, so the app
    /// can suspend the Carbon hotkey for the duration — otherwise pressing the
    /// currently-bound chord is consumed by the hotkey (toggling the bar)
    /// before the recorder's local monitor ever sees it. Not persisted.
    var onShortcutRecordingChanged: ((Bool) -> Void)?

    /// Fired when show-in-Dock flips, so the app can re-apply the activation
    /// policy immediately instead of at the next panel state change. Not
    /// persisted (wired at launch).
    var onShowInDockChanged: ((Bool) -> Void)?

    /// Productization M2: the full view opens as a standard main window
    /// (title bar, Dock, Cmd+Tab while open) instead of the bar's panel
    /// morphing into it. OFF by default until M8 flips it.
    var macMainWindow: Bool {
        didSet { defaults.set(macMainWindow, forKey: Self.macMainWindowKey) }
    }

    /// A new PUSH posts a macOS banner unless the user turns it off. The top-bar
    /// count always updates regardless — this only gates the system banner.
    var notificationsEnabled: Bool {
        didSet { defaults.set(notificationsEnabled, forKey: Self.notificationsKey) }
    }

    /// Whether HTML mail may fetch remote resources (images, styles). ON by
    /// default — the founder call is real rendering first — but turning it
    /// off blocks every network load in the reading webview (tracking
    /// pixels, CSS beacons); data:-inline images keep working.
    var loadRemoteImages: Bool {
        didSet { defaults.set(loadRemoteImages, forKey: Self.loadRemoteImagesKey) }
    }

    /// Whether the reading pane's analysis band (왜 이 분류인지, AI 요약,
    /// 스레드 브리프…) is expanded. COLLAPSED by default (founder 2026-09-01:
    /// the band was eating the pane and the actual mail was barely visible) —
    /// the one-line reason stays visible either way, and the choice persists
    /// so a reader who wants the full analysis open keeps it open.
    var readingBandExpanded: Bool {
        didSet { defaults.set(readingBandExpanded, forKey: Self.readingBandExpandedKey) }
    }

    /// App appearance: follow the OS, or force light/dark. Applied via
    /// NSApp.appearance (nil = system) by the launch wiring and on change.
    var appearance: AppearanceChoice {
        didSet {
            defaults.set(appearance.rawValue, forKey: Self.appearanceKey)
            onAppearanceChanged?(appearance)
        }
    }

    /// Fired when the appearance choice changes (wired at launch, not persisted).
    var onAppearanceChanged: ((AppearanceChoice) -> Void)?

    /// User-dragged height of the sidebar's ACCOUNT section. The TODAY/
    /// UPCOMING region flexes to absorb whatever this gives or takes.
    var accountSectionHeight: Double {
        didSet { defaults.set(accountSectionHeight, forKey: Self.accountSectionHeightKey) }
    }

    var todaySectionHeight: Double {
        didSet { defaults.set(todaySectionHeight, forKey: Self.todaySectionHeightKey) }
    }

    var inboxSectionHeight: Double {
        didSet { defaults.set(inboxSectionHeight, forKey: Self.inboxSectionHeightKey) }
    }

    var upcomingSectionHeight: Double {
        didSet { defaults.set(upcomingSectionHeight, forKey: Self.upcomingSectionHeightKey) }
    }

    /// Whether the collapsed pill stays on screen. OFF = ambient-invisible mode:
    /// nothing is drawn until ⌥⌘K summons the panel or a PUSH card appears —
    /// the card and the background engine are unaffected.
    /// Whether Klorn appears in the Dock and Cmd+Tab while resting.
    ///
    /// OFF by default, which is the ambient firewall Klorn is designed as: no
    /// Dock icon, no app switcher, never steals focus (founder decision,
    /// 2026-07-28). It is opt-in rather than removed because people who expect
    /// Cmd+Tab to reach every running app were left with no way to find Klorn
    /// except the ⌥⌘K hotkey.
    var showInDock: Bool {
        didSet {
            defaults.set(showInDock, forKey: Self.showInDockKey)
            onShowInDockChanged?(showInDock)
        }
    }

    /// The full view's user-chosen window size (drag-resize), persisted so it
    /// survives state changes and relaunch. nil until the user first resizes —
    /// the screen-fitted default applies.
    var fullWindowSize: NSSize? {
        didSet {
            guard let size = fullWindowSize else { return }
            defaults.set(
                ["width": Double(size.width), "height": Double(size.height)],
                forKey: Self.fullWindowSizeKey)
        }
    }

    /// The expanded panel's user-chosen size — same contract as
    /// `fullWindowSize`, one slot per resizable state.
    var expandedWindowSize: NSSize? {
        didSet {
            guard let size = expandedWindowSize else { return }
            defaults.set(
                ["width": Double(size.width), "height": Double(size.height)],
                forKey: Self.expandedWindowSizeKey)
        }
    }

    var pillVisible: Bool {
        didSet {
            defaults.set(pillVisible, forKey: Self.pillVisibleKey)
            // Breadcrumb: the pill has flipped hidden repeatedly in dogfood
            // with no obvious actor (2026-07-20). os.log turned out not to be
            // collectable on the dogfood Mac, so the trace ALSO goes to a file
            // in Application Support — the next occurrence names its caller.
            let stack = Thread.callStackSymbols.dropFirst().prefix(4).joined(separator: "\n    ")
            Log.app.notice("pillVisible → \(self.pillVisible, privacy: .public)")
            Self.appendPillTrace("pillVisible → \(pillVisible)\n    \(stack)")
        }
    }

    /// Append one pill-flip event to ~/Library/Application Support/Klorn/
    /// pill-trace.log. Best-effort; never throws into the UI path.
    private static func appendPillTrace(_ line: String) {
        let fm = FileManager.default
        guard let dir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Klorn", isDirectory: true) else { return }
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("pill-trace.log")
        let stamp = ISO8601DateFormatter().string(from: Date())
        let entry = "\(stamp) \(line)\n"
        if let handle = try? FileHandle(forWritingTo: file) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data(entry.utf8))
        } else {
            try? Data(entry.utf8).write(to: file)
        }
    }

    /// App language: follow macOS (default) or override. Stored via L10n so a
    /// string lookup doesn't have to hop to the main actor; bumping
    /// `languageRevision` is what makes the change visible without a relaunch —
    /// SwiftUI can't observe a global function's return value.
    var appLanguage: AppLanguage = L10n.override {
        didSet {
            guard appLanguage != oldValue else { return }
            L10n.override = appLanguage
            languageRevision &+= 1
        }
    }

    /// Incremented on every language change; the root view keys its identity on
    /// it so the whole tree re-renders with the new strings.
    private(set) var languageRevision = 0

    /// The user's global toggle shortcut (default ⌥⌘K). Persisted as a small
    /// dict; changing it re-registers the hotkey via `onShortcutChanged`.
    var shortcut: Shortcut {
        didSet {
            defaults.set(
                ["keyCode": shortcut.keyCode, "carbonModifiers": shortcut.carbonModifiers],
                forKey: Self.shortcutKey)
            onShortcutChanged?(shortcut)
        }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.notificationsEnabled = Self.resolveNotifications(defaults.object(forKey: Self.notificationsKey))
        self.loadRemoteImages = Self.resolveLoadRemoteImages(defaults.object(forKey: Self.loadRemoteImagesKey))
        self.readingBandExpanded = defaults.object(forKey: Self.readingBandExpandedKey) as? Bool ?? false
        self.appearance = Self.resolveAppearance(defaults.object(forKey: Self.appearanceKey))
        self.accountSectionHeight = Self.resolveAccountSectionHeight(
            defaults.object(forKey: Self.accountSectionHeightKey))
        self.todaySectionHeight = Self.resolveTodaySectionHeight(
            defaults.object(forKey: Self.todaySectionHeightKey))
        self.inboxSectionHeight = Self.resolveInboxSectionHeight(
            defaults.object(forKey: Self.inboxSectionHeightKey))
        self.upcomingSectionHeight = Self.resolveUpcomingSectionHeight(
            defaults.object(forKey: Self.upcomingSectionHeightKey))
        self.showInDock = Self.resolveShowInDock(defaults.object(forKey: Self.showInDockKey))
        self.macMainWindow = Self.resolveMacMainWindow(defaults.object(forKey: Self.macMainWindowKey))
        self.pillVisible = Self.resolvePillVisible(defaults.object(forKey: Self.pillVisibleKey))
        self.shortcut = Self.resolveShortcut(defaults.object(forKey: Self.shortcutKey))
        self.fullWindowSize = Self.resolveFullWindowSize(
            defaults.object(forKey: Self.fullWindowSizeKey), floor: TopBarMetrics.fullMin)
        self.expandedWindowSize = Self.resolveFullWindowSize(
            defaults.object(forKey: Self.expandedWindowSizeKey), floor: TopBarMetrics.expandedMin)
    }

    /// Restore a stored {width,height}; malformed → nil (the screen-fitted
    /// default applies). Values below `floor` are lifted to it — a too-small
    /// stored size would re-clip the fixed columns the floor protects. Pure.
    nonisolated static func resolveFullWindowSize(_ stored: Any?, floor: NSSize) -> NSSize? {
        guard let dict = stored as? [String: Any],
              let w = (dict["width"] as? NSNumber)?.doubleValue ?? (dict["width"] as? Double),
              let h = (dict["height"] as? NSNumber)?.doubleValue ?? (dict["height"] as? Double)
        else { return nil }
        return NSSize(width: max(w, floor.width), height: max(h, floor.height))
    }

    /// Whether this is the install's first run (no marker yet). Pure.
    nonisolated static func isFirstLaunch(_ stored: Any?) -> Bool {
        !((stored as? Bool) ?? false)
    }

    /// One-shot first-launch gate: true exactly once, then marked. The first
    /// launch opens the full app window — an accessory app whose only chrome
    /// is a top-edge pill is invisible to someone who just installed it
    /// (user report 2026-08-05).
    func consumeFirstLaunch() -> Bool {
        let first = Self.isFirstLaunch(defaults.object(forKey: Self.hasLaunchedKey))
        if first { defaults.set(true, forKey: Self.hasLaunchedKey) }
        return first
    }

    /// Default ⌥⌘K when unset; otherwise restore the stored {keyCode,modifiers}.
    /// A malformed value falls back to the default rather than crashing. Pure.
    nonisolated static func resolveShortcut(_ stored: Any?) -> Shortcut {
        guard let dict = stored as? [String: Any],
              let code = (dict["keyCode"] as? NSNumber)?.uint32Value
                  ?? (dict["keyCode"] as? UInt32),
              let mods = (dict["carbonModifiers"] as? NSNumber)?.uint32Value
                  ?? (dict["carbonModifiers"] as? UInt32)
        else { return .defaultToggle }
        return Shortcut(keyCode: code, carbonModifiers: mods)
    }

    /// Default ON when never set (`nil`); otherwise honor the stored flag. Pure.
    nonisolated static func resolveNotifications(_ stored: Any?) -> Bool {
        (stored as? Bool) ?? true
    }

    nonisolated static func resolveLoadRemoteImages(_ stored: Any?) -> Bool {
        (stored as? Bool) ?? true
    }

    nonisolated static func resolveAppearance(_ stored: Any?) -> AppearanceChoice {
        AppearanceChoice(rawValue: stored as? String ?? "") ?? .system
    }

    /// Clamp so a wild stored value can never crush the mail list or push the
    /// account actions off-screen. Pure.
    nonisolated static func resolveAccountSectionHeight(_ stored: Any?) -> Double {
        let raw = (stored as? NSNumber)?.doubleValue ?? (stored as? Double) ?? 260
        return min(max(raw, 140), 460)
    }
    /// TODAY(브리핑+오늘) section height — same clamp discipline as the
    /// account section: a stored junk value can't collapse or explode the
    /// sidebar. Pure.
    nonisolated static func resolveTodaySectionHeight(_ stored: Any?) -> Double {
        let raw = (stored as? NSNumber)?.doubleValue ?? (stored as? Double) ?? 240
        return min(max(raw, 120), 520)
    }
    /// 수신함 nav cap — default generous so nothing changes until dragged.
    nonisolated static func resolveInboxSectionHeight(_ stored: Any?) -> Double {
        let raw = (stored as? NSNumber)?.doubleValue ?? (stored as? Double) ?? 620
        return min(max(raw, 180), 800)
    }

    /// 예정(UPCOMING) cap — same clamp discipline.
    nonisolated static func resolveUpcomingSectionHeight(_ stored: Any?) -> Double {
        let raw = (stored as? NSNumber)?.doubleValue ?? (stored as? Double) ?? 300
        return min(max(raw, 100), 600)
    }



    /// Default ON (pill shown) when never set; otherwise honor the stored flag. Pure.
    nonisolated static func resolvePillVisible(_ stored: Any?) -> Bool {
        (stored as? Bool) ?? true
    }

    /// OFF unless explicitly stored true. Pure.
    nonisolated static func resolveMacMainWindow(_ stored: Any?) -> Bool {
        (stored as? Bool) ?? false
    }

    /// Default OFF when never set: the resting app stays ambient (no Dock icon,
    /// out of Cmd+Tab) unless the user opts in. Pure.
    nonisolated static func resolveShowInDock(_ stored: Any?) -> Bool {
        (stored as? Bool) ?? false
    }
}

/// Static app metadata for the About section. Reads the packaged `.app`'s
/// Info.plist; falls back to "dev" under `swift run` (no bundle version).
enum AppInfo {
    static var version: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "dev"
    }
}


/// The three appearance options. `nsAppearance` is what NSApp.appearance
/// takes: nil = inherit the system.
enum AppearanceChoice: String, CaseIterable, Sendable {
    case system
    case light
    case dark

    var nsAppearance: NSAppearance? {
        switch self {
        case .system: nil
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        }
    }

    var label: String {
        switch self {
        case .system: L("appearance.system")
        case .light: L("appearance.light")
        case .dark: L("appearance.dark")
        }
    }
}
