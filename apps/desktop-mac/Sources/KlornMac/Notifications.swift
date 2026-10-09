import Foundation
import UserNotifications

/// Plan which PUSH items deserve an OS notification. Pure + testable.
///
/// First load establishes a silent baseline (don't fire N notifications for the
/// inbox that already exists); after that, only genuinely new PUSH items notify.
/// This is the firewall's whole promise: interrupt only for what's new and loud.
struct PushNotifyPlan: Equatable {
    let toNotify: [FirewallItem]
    let seen: Set<String>
}

func planPushNotifications(
    seen: Set<String>,
    baselineEstablished: Bool,
    pushItems: [FirewallItem]
) -> PushNotifyPlan {
    let currentIDs = Set(pushItems.map(\.id))
    guard baselineEstablished else {
        // First observation — record everything, notify for nothing.
        return PushNotifyPlan(toNotify: [], seen: currentIDs)
    }
    let fresh = pushItems.filter { !seen.contains($0.id) }
    return PushNotifyPlan(toNotify: fresh, seen: seen.union(currentIDs))
}

/// OS notifications for PUSH items. Gated on a bundle identifier: an unbundled
/// `swift run` has none, and UNUserNotificationCenter is unusable there, so we
/// skip cleanly (the app still works) — a packaged `.app` gets real banners.
@MainActor
enum PushNotifier {
    /// Namespace for our request identifiers. The item id is appended verbatim,
    /// so a tap can recover it — see `itemID(fromNotificationIdentifier:)`.
    nonisolated static let identifierPrefix = "klorn-push-"

    static var isAvailable: Bool { Bundle.main.bundleIdentifier != nil }

    static func requestAuthorization() async {
        guard isAvailable else { return }
        _ = try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound])
    }

    /// Sign-out: take this account's banners out of Notification Center and
    /// drop any still pending. A tap on one that is already gone from the
    /// queue only expands the bar (`tapAction`), but the sender and subject
    /// on it are the previous account's and should not stay on screen.
    static func clearAll() {
        guard isAvailable else { return }
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
    }

    /// Pure, testable identity for a posted banner.
    nonisolated static func notificationIdentifier(for itemID: String) -> String {
        identifierPrefix + itemID
    }

    /// Recover the item id a banner was posted for. Returns nil for anything we
    /// did not post, so a foreign notification can never be mistaken for ours.
    /// Uses a single leading-prefix strip (not a replace) so an item id that
    /// itself contains the prefix survives the round trip.
    nonisolated static func itemID(fromNotificationIdentifier identifier: String) -> String? {
        guard identifier.hasPrefix(identifierPrefix) else { return nil }
        return String(identifier.dropFirst(identifierPrefix.count))
    }
}

/// What a tapped banner should do. Pure so the routing is verifiable without
/// a notification centre, a window server, or a running app.
enum NotificationTapAction: Equatable {
    /// Not our notification — leave it alone.
    case ignore
    /// Open this item in the reading pane.
    case open(itemID: String)
    /// Ours, but the item is no longer in the queue (handled elsewhere, or the
    /// queue refreshed). Show the bar anyway: a tap must never do nothing.
    case expand
}

extension PushNotifier {
    nonisolated static func tapAction(
        identifier: String,
        isKnownItem: (String) -> Bool
    ) -> NotificationTapAction {
        guard let id = itemID(fromNotificationIdentifier: identifier) else { return .ignore }
        return isKnownItem(id) ? .open(itemID: id) : .expand
    }

    static func post(_ item: FirewallItem) {
        guard isAvailable else {
            Log.app.debug("push notification skipped (unbundled run): \(item.id, privacy: .public)")
            return
        }
        let content = UNMutableNotificationContent()
        content.title = item.email?.from ?? "Klorn"
        content.subtitle = item.email?.subject ?? item.title
        if let snippet = item.email?.snippet, !snippet.isEmpty { content.body = snippet }
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: notificationIdentifier(for: item.id), content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
