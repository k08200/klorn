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

    private let defaults: UserDefaults

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

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.notificationsEnabled = Self.resolveNotifications(defaults.object(forKey: Self.notificationsKey))
        self.pillVisible = Self.resolvePillVisible(defaults.object(forKey: Self.pillVisibleKey))
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
