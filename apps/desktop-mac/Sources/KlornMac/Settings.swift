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
    static let shortcutKey = "klorn.toggleShortcut"
    static let mainWindowOpenAtQuitKey = "klorn.mainWindowOpenAtQuit"
    static let loadRemoteImagesKey = "klorn.mail.loadRemoteImages"
    static let readingBandExpandedKey = "klorn.reading.bandExpanded"
    static let appearanceKey = "klorn.appearance"
    /// Settings retired when the pill and the expanded panel were removed
    /// (founder decision 2026-10-15): the pill switch, show-in-Dock (Klorn is
    /// always in the Dock now), the panel's saved size, the first-launch
    /// marker (every normal launch opens a window now) and the `macMainWindow`
    /// switch (there is no other surface to fall back to). A stored value is
    /// ignored and removed at launch.
    static let retiredKeys = [
        "klorn.pillVisible", "klorn.showInDock", "klorn.expandedWindowSize",
        "klorn.hasLaunchedBefore", "macMainWindow",
    ]

    private let defaults: UserDefaults

    /// Fired when the user changes the toggle shortcut, so the app can
    /// re-register the Carbon hotkey. Not persisted (wired at launch).
    var onShortcutChanged: ((Shortcut) -> Void)?

    /// Fired when the Preferences recorder starts/stops capturing, so the app
    /// can suspend the Carbon hotkey for the duration — otherwise pressing the
    /// currently-bound chord is consumed by the hotkey (showing or hiding Klorn)
    /// before the recorder's local monitor ever sees it. Not persisted.
    var onShortcutRecordingChanged: ((Bool) -> Void)?

    /// A new PUSH posts a macOS banner unless the user turns it off (ON by
    /// default). The VoiceOver announcement and the lane counts in the main
    /// window are unaffected — this only gates the system banner.
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

    /// Whether the main window was open when Klorn last quit. A launch at
    /// login reopens it only then; otherwise a login launch stays out of the
    /// way (no window, no focus steal). Written at quit.
    var mainWindowOpenAtQuit: Bool {
        didSet { defaults.set(mainWindowOpenAtQuit, forKey: Self.mainWindowOpenAtQuitKey) }
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
        self.mainWindowOpenAtQuit = defaults.object(forKey: Self.mainWindowOpenAtQuitKey) as? Bool ?? false
        self.shortcut = Self.resolveShortcut(defaults.object(forKey: Self.shortcutKey))
        Self.retiredKeys.forEach(defaults.removeObject(forKey:))
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
}

/// Files left behind by removed features, deleted once at launch.
enum RetiredFiles {
    /// The pill's visibility trace (removed with the pill, 2026-10-15).
    static func pillTraceURL(appSupport: URL?) -> URL? {
        appSupport?.appendingPathComponent("Klorn", isDirectory: true)
            .appendingPathComponent("pill-trace.log")
    }

    /// Best effort: a missing file is the normal case, any other failure is
    /// logged and ignored — nothing depends on it.
    static func removePillTrace() {
        let fm = FileManager.default
        guard let url = pillTraceURL(
            appSupport: fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first),
            fm.fileExists(atPath: url.path)
        else { return }
        do {
            try fm.removeItem(at: url)
        } catch {
            Log.app.debug("pill trace not removed: \(String(describing: error), privacy: .private)")
        }
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
