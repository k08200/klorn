import Foundation

// MARK: - Dock badge (N4, 2026-11-11)

/// The number on Klorn's Dock icon: Today's "Needs you now" mail — PUSH mail
/// from the last 72 hours still open (founder decision, LOCKED 2026-10-23) —
/// that is still unread (2026-11-12: reading a mail clears it from the badge;
/// `TodayRules.dockBadgeCount`). A badge is neither a sound nor a banner, so
/// quiet hours do not hide it; only the Settings ▸ Notifications switch
/// "Show count on Dock icon" does.
enum DockBadge {
    /// The largest number shown; anything above reads "99+".
    static let maxShown = 99

    /// The Dock tile's label: nil (no badge) for nothing waiting or the
    /// switch off, else the count capped at "99+". Pure.
    nonisolated static func label(count: Int, enabled: Bool = true) -> String? {
        guard enabled, count > 0 else { return nil }
        return count > maxShown ? "\(maxShown)+" : String(count)
    }
}
