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
    static var isAvailable: Bool { Bundle.main.bundleIdentifier != nil }

    static func requestAuthorization() async {
        guard isAvailable else { return }
        _ = try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound])
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
            identifier: "klorn-push-\(item.id)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
