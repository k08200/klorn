import Foundation
import UserNotifications

// MARK: - Banner action buttons (founder decision 2026-11-17, NT3)

/// The categories a banner can carry. A mail banner offers Reply / Later /
/// Done on hover; a meeting reminder offers Join only when its event already
/// has a safe https link. Summaries carry none.
enum BannerCategory: String, Sendable {
    case mail = "klorn-mail"
    case meetingJoin = "klorn-meeting-join"
}

/// The buttons. Reply is a foreground action: it brings Klorn forward on
/// that mail with the composer open, and the user sends from there after
/// seeing the whole draft — no button sends anything (no text-input action).
/// Later, Done and Join run in the background.
enum BannerAction: String, CaseIterable, Sendable {
    case reply = "klorn-reply"
    case later = "klorn-later"
    case done = "klorn-done"
    case join = "klorn-join"
}

enum BannerActions {
    /// userInfo keys. Plain strings only: the item id travels in the
    /// request identifier, these carry what a background button needs.
    nonisolated static let emailIDKey = "emailId"
    nonisolated static let meetingLinkKey = "meetingLink"
    /// The server's id columns are short (cuid / uuid); anything longer, or
    /// with characters outside this set, is not ours and is never put in a
    /// request path.
    nonisolated static let maxIDLength = 128

    /// The categories registered at launch (`SystemPushNotifier.registerCategories`).
    static func categories() -> Set<UNNotificationCategory> {
        let reply = UNNotificationAction(
            identifier: BannerAction.reply.rawValue, title: L("banner.action.reply"), options: [.foreground])
        let later = UNNotificationAction(
            identifier: BannerAction.later.rawValue, title: L("banner.action.later"), options: [])
        let done = UNNotificationAction(
            identifier: BannerAction.done.rawValue, title: L("banner.action.done"), options: [])
        let join = UNNotificationAction(
            identifier: BannerAction.join.rawValue, title: L("banner.action.join"), options: [])
        return [
            UNNotificationCategory(
                identifier: BannerCategory.mail.rawValue, actions: [reply, later, done],
                intentIdentifiers: [], options: []),
            UNNotificationCategory(
                identifier: BannerCategory.meetingJoin.rawValue, actions: [join],
                intentIdentifiers: [], options: []),
        ]
    }

    /// A notification's userInfo as strings: anything else is dropped. Pure.
    nonisolated static func stringInfo(_ userInfo: [AnyHashable: Any]) -> [String: String] {
        var out: [String: String] = [:]
        for (key, value) in userInfo {
            if let key = key as? String, let value = value as? String { out[key] = value }
        }
        return out
    }

    /// An id safe to put in a request path: 1...128 of [A-Za-z0-9_-]. Pure.
    nonisolated static func isSafeID(_ id: String?) -> Bool {
        guard let id, !id.isEmpty, id.utf8.count <= maxIDLength else { return false }
        return id.unicodeScalars.allSatisfy {
            ("a"..."z").contains($0) || ("A"..."Z").contains($0) || ("0"..."9").contains($0) || $0 == "-" || $0 == "_"
        }
    }
}

/// What a banner response should do. Pure so the routing is verifiable
/// without a notification center or a running app.
enum NotificationResponseAction: Equatable {
    /// The banner itself (or a button that does not apply): the tap routing.
    case tap(NotificationTapAction)
    /// Open this mail with the reply composer (nothing is sent).
    case reply(itemID: String)
    /// The web's "Later" for this mail: a later-today reminder.
    case later(itemID: String, emailID: String)
    /// Clear this mail from the queue (the app's own Dismiss).
    case done(itemID: String)
    /// Open the meeting's join link (already re-checked as safe https).
    case join(URL)
}

extension PushNotifier {
    /// One Notification Center group per mail. The Mac's mail model carries
    /// no thread id (the server does not send one), so the mail is the
    /// finest grouping available.
    nonisolated static func mailThreadIdentifier(for emailID: String) -> String {
        "klorn-mail-" + emailID
    }

    /// Meeting reminders share one group.
    nonisolated static let meetingThreadIdentifier = "klorn-meeting"

    /// Route a response: a button on its own kind of banner names what it
    /// acts on; anything else is a tap, so a press never does nothing. Pure.
    nonisolated static func responseAction(
        identifier: String, actionIdentifier: String, info: [String: String],
        isKnownItem: (String) -> Bool
    ) -> NotificationResponseAction {
        let tap = NotificationResponseAction.tap(tapAction(identifier: identifier, isKnownItem: isKnownItem))
        guard let action = BannerAction(rawValue: actionIdentifier) else { return tap }
        if action == .join {
            guard identifier.hasPrefix(meetingPrefix),
                  let url = MeetingLink.safeURL(info[BannerActions.meetingLinkKey]) else { return tap }
            return .join(url)
        }
        guard let itemID = itemID(fromNotificationIdentifier: identifier), BannerActions.isSafeID(itemID)
        else { return tap }
        switch action {
        case .reply: return .reply(itemID: itemID)
        case .done: return .done(itemID: itemID)
        case .later:
            let emailID = info[BannerActions.emailIDKey]
            guard let emailID, BannerActions.isSafeID(emailID) else { return tap }
            return .later(itemID: itemID, emailID: emailID)
        case .join: return tap
        }
    }
}

/// The video service a meeting link points at, named from its host only
/// (never the path, which anyone can write). nil when not recognised. Pure.
enum MeetingProvider {
    static func name(for url: URL) -> String? {
        guard let host = url.host?.lowercased() else { return nil }
        func on(_ domain: String) -> Bool { host == domain || host.hasSuffix("." + domain) }
        if on("meet.google.com") { return L("meeting.provider.meet") }
        if on("zoom.us") { return L("meeting.provider.zoom") }
        if on("teams.microsoft.com") || on("teams.live.com") { return L("meeting.provider.teams") }
        if on("webex.com") { return L("meeting.provider.webex") }
        return nil
    }
}
