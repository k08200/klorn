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

    private let defaults: UserDefaults

    /// Fired when the user changes the toggle shortcut, so the app can
    /// re-register the Carbon hotkey. Not persisted (wired at launch).
    var onShortcutChanged: ((Shortcut) -> Void)?

    /// Fired when the Preferences recorder starts/stops capturing, so the app
    /// can suspend the Carbon hotkey for the duration — otherwise pressing the
    /// currently-bound chord is consumed by the hotkey (toggling the bar)
    /// before the recorder's local monitor ever sees it. Not persisted.
    var onShortcutRecordingChanged: ((Bool) -> Void)?

    /// A new PUSH posts a macOS banner unless the user turns it off. The top-bar
    /// count always updates regardless — this only gates the system banner.
    var notificationsEnabled: Bool {
        didSet { defaults.set(notificationsEnabled, forKey: Self.notificationsKey) }
    }

    /// Whether the collapsed pill stays on screen. OFF = ambient-invisible mode:
    /// nothing is drawn until ⌥⌘K summons the panel or a PUSH card appears —
    /// the card and the background engine are unaffected.
    var pillVisible: Bool {
        didSet { defaults.set(pillVisible, forKey: Self.pillVisibleKey) }
    }

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
        self.pillVisible = Self.resolvePillVisible(defaults.object(forKey: Self.pillVisibleKey))
        self.shortcut = Self.resolveShortcut(defaults.object(forKey: Self.shortcutKey))
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

    /// Default ON (pill shown) when never set; otherwise honor the stored flag. Pure.
    nonisolated static func resolvePillVisible(_ stored: Any?) -> Bool {
        (stored as? Bool) ?? true
    }
}

/// Static app metadata for the About section. Reads the packaged `.app`'s
/// Info.plist; falls back to "dev" under `swift run` (no bundle version).
enum AppInfo {
    static var version: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "dev"
    }
}
