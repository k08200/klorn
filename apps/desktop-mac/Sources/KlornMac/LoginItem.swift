import Foundation
import ServiceManagement

/// Launch-at-login via SMAppService (macOS 13+). An always-on firewall that
/// dies on reboot isn't always-on — this keeps the PUSH banners working after
/// a restart. A login launch opens no window (see `AppRules.launchAction`).
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
        hasBundleId ? .available : .unavailable(reason: L("prefs.launchAtLogin.unavailable.value"))
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

// MARK: - First-run "Open at login" prompt (N5, 2026-11-11)

/// Asks once whether Klorn may open at login, so urgent-mail banners keep
/// working after a restart (the Windows shell asks the same, PR #1644). Shown
/// once notifications are first authorized after sign-in, or right after
/// sign-in when macOS already had an answer. Never enables anything by
/// itself: only the "Open at login" button registers the login item.
enum LoginItemPrompt {
    /// Set once the prompt was answered: it never shows again.
    static let askedKey = "klorn.loginItemPrompt.asked"

    /// Whether to show the prompt now. `before` is macOS's answer before
    /// this session's permission request, `after` the answer it returned.
    /// Pure.
    nonisolated static func shouldShow(
        asked: Bool, availability: LoginItem.Availability, enabled: Bool,
        before: NotificationPermission, after: NotificationPermission
    ) -> Bool {
        guard !asked, availability == .available, !enabled else { return false }
        let decidedBefore = before == .authorized || before == .denied
        return after == .authorized || decidedBefore
    }
}

/// What the prompt reads and does, behind a seam so the self-check never
/// touches the real login item or the app's preferences.
@MainActor
struct LoginItemPromptEnvironment {
    var asked: () -> Bool
    var markAsked: () -> Void
    var availability: () -> LoginItem.Availability
    var isEnabled: () -> Bool
    /// Registers the login item; a user-facing error, or nil on success.
    var register: () -> String?

    static let live = LoginItemPromptEnvironment(
        asked: { UserDefaults.standard.bool(forKey: LoginItemPrompt.askedKey) },
        markAsked: { UserDefaults.standard.set(true, forKey: LoginItemPrompt.askedKey) },
        availability: { LoginItem.availability(hasBundleId: Bundle.main.bundleIdentifier != nil) },
        isEnabled: { LoginItem.isEnabled },
        register: { LoginItem.setEnabled(true) })
}
