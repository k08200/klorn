import Foundation
import ServiceManagement

/// Launch-at-login via SMAppService (macOS 13+). An always-on firewall that
/// dies on reboot isn't always-on — this makes the pill/card survive restarts.
/// Registration needs a real bundle identity, so the unbundled `swift run`
/// degrades to a visible "Packaged app only" state instead of a silent no-op.
@MainActor
enum LoginItem {
    enum Availability: Equatable, Sendable {
        case available
        case unavailable(reason: String)
    }

    /// Pure gate for the self-check harness: bundle identity decides it.
    nonisolated static func availability(hasBundleId: Bool) -> Availability {
        hasBundleId ? .available : .unavailable(reason: "Packaged app only")
    }

    static var isAvailable: Bool {
        availability(hasBundleId: Bundle.main.bundleIdentifier != nil) == .available
    }

    /// Current registration state as the OS reports it (not a stored pref —
    /// System Settings can change it behind our back, so always read live).
    static var isEnabled: Bool {
        guard isAvailable else { return false }
        return SMAppService.mainApp.status == .enabled
    }

    /// Register/unregister; returns a user-facing error message on failure
    /// (e.g. the user denied it in System Settings → Login Items).
    @discardableResult
    static func setEnabled(_ enabled: Bool) -> String? {
        guard isAvailable else { return "Launch at login needs the packaged Klorn.app." }
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            return nil
        } catch {
            Log.app.error("login item toggle failed: \(String(describing: error), privacy: .private)")
            return "macOS declined — check System Settings → General → Login Items."
        }
    }
}
