import AppKit
import Foundation
import SwiftUI
import UserNotifications

// MARK: - Which PUSH mail gets a banner

/// What has already been announced, for one account, across launches.
///
/// Founder decision 2026-10-15: PUSH mail is announced with standard macOS
/// notification banners (the pill and its cards are gone). The ledger is what
/// keeps that honest:
/// - the first sync for an account is a silent baseline, so signing in never
///   fires a banner per message already sitting in the inbox;
/// - an id is announced at most once, and the record survives relaunch, so a
///   restart neither repeats banners nor (unlike the old per-launch baseline)
///   silently swallows PUSH mail that arrived while Klorn was quit.
struct PushLedger: Codable, Equatable, Sendable {
    /// The account (JWT subject) the ids belong to. A ledger written for
    /// another account is never reused — that account starts a new baseline.
    var owner: String?
    var baselineEstablished: Bool
    /// Announced (or baselined) item ids, oldest first, capped at `cap`.
    var notified: [String]

    /// Ids kept. Far above any PUSH lane's size, so trimming only ever drops
    /// ids that left the lane long ago.
    static let cap = 2000
    /// Banners posted for one sync at most. More than this at once (a long
    /// time offline) is recorded as seen without a banner each — the lane
    /// count in the main window covers the rest, and a wall of banners is
    /// noise, not an interrupt.
    static let maxBannersPerSync = 5

    static func fresh(owner: String?) -> PushLedger {
        PushLedger(owner: owner, baselineEstablished: false, notified: [])
    }

    /// The ledger to use for `owner`: the stored one if it is theirs, else a
    /// new baseline. Pure.
    static func resolve(stored: PushLedger?, owner: String?) -> PushLedger {
        guard let stored, stored.owner == owner else { return fresh(owner: owner) }
        return stored
    }

    /// This ledger with `id` recorded (newest last, capped). Pure.
    func recording(_ id: String) -> PushLedger {
        var next = self
        next.notified = Array((notified.filter { $0 != id } + [id]).suffix(Self.cap))
        next.baselineEstablished = true
        return next
    }

    struct Plan: Equatable {
        let toNotify: [FirewallItem]
        let next: PushLedger
    }

    /// Plan the banners for the PUSH lane as it is now. Pure.
    func plan(pushItems: [FirewallItem]) -> Plan {
        let known = Set(notified)
        var seenNow = Set<String>()
        let unseen = pushItems.filter { !known.contains($0.id) && seenNow.insert($0.id).inserted }
        var next = self
        next.notified = Array((notified + unseen.map(\.id)).suffix(Self.cap))
        next.baselineEstablished = true
        guard baselineEstablished else { return Plan(toNotify: [], next: next) }
        return Plan(toNotify: Array(unseen.prefix(Self.maxBannersPerSync)), next: next)
    }
}

/// Where the ledger persists. A seam: the shipped app uses UserDefaults, the
/// self-check an in-memory store.
@MainActor
protocol PushLedgerStoring: AnyObject {
    func load() -> PushLedger?
    func save(_ ledger: PushLedger)
    func clear()
}

@MainActor
final class UserDefaultsPushLedgerStore: PushLedgerStoring {
    static let key = "klorn.push.ledger"
    /// The meeting-banner ledger: same shape, its own record.
    static let meetingKey = "klorn.meeting.ledger"
    private let defaults: UserDefaults
    private let key: String

    init(defaults: UserDefaults = .standard, key: String = UserDefaultsPushLedgerStore.key) {
        self.defaults = defaults
        self.key = key
    }

    func load() -> PushLedger? {
        guard let data = defaults.data(forKey: key) else { return nil }
        do {
            return try JSONDecoder().decode(PushLedger.self, from: data)
        } catch {
            // A corrupt record must not block banners forever: start a new
            // baseline (silent), which is the safe direction.
            Log.app.error("push ledger unreadable, starting a new baseline")
            return nil
        }
    }

    func save(_ ledger: PushLedger) {
        do {
            defaults.set(try JSONEncoder().encode(ledger), forKey: key)
        } catch {
            Log.app.error("push ledger not saved: \(String(describing: error), privacy: .private)")
        }
    }

    func clear() { defaults.removeObject(forKey: key) }
}

@MainActor
final class InMemoryPushLedgerStore: PushLedgerStoring {
    private(set) var stored: PushLedger?
    init(_ stored: PushLedger? = nil) { self.stored = stored }
    func load() -> PushLedger? { stored }
    func save(_ ledger: PushLedger) { stored = ledger }
    func clear() { stored = nil }
}

// MARK: - Posting banners

/// What one banner says. Sender and subject only: no body text, so a
/// banner on a shared screen never shows the mail's contents. Pure.
struct PushBanner: Equatable, Sendable {
    let identifier: String
    let title: String
    let body: String

    static func make(for item: FirewallItem) -> PushBanner {
        let sender = senderDisplayName(item.email?.from.map(decodeHTMLEntities))
        let subject = decodeHTMLEntities(item.email?.subject ?? item.title)
        return PushBanner(
            identifier: PushNotifier.notificationIdentifier(for: item.id),
            title: sender.isEmpty ? "Klorn" : sender,
            body: subject)
    }
}

/// The "starting soon" banner for a meeting: the title and start time, and
/// a short line with the minutes left. No description, attendees or mail
/// content. Pure (`now` and the time formatter are inputs).
enum MeetingBanner {
    /// "3:20 PM" in the display zone (`Date.formatted` reads this Mac's).
    static func shortTime(_ date: Date) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        style.timeZone = DisplayTimeZone.current
        return date.formatted(style)
    }

    static func make(
        for event: CalendarEventWire, now: Date,
        time: (Date) -> String = { MeetingBanner.shortTime($0) }
    ) -> PushBanner {
        let start = meetingStart(event.startTime)
        let title = event.title.isEmpty ? "Klorn" : event.title
        let minutes = start.map { max(1, Int(($0.timeIntervalSince(now) / 60).rounded())) } ?? 1
        return PushBanner(
            identifier: PushNotifier.meetingIdentifier(for: event.id),
            title: start.map { "\(title) · \(time($0))" } ?? title,
            body: L("meeting.banner.body", minutes))
    }
}

/// When Klorn may ask macOS for banner permission: signed in, not yet asked
/// this session, and only after the user has been shown a window they opened
/// (the main window activated, or onboarding finished into it). Never on a
/// launch at login, where a system dialog would appear unasked. Pure.
enum NotificationPermissionRules {
    static func shouldRequest(signedIn: Bool, alreadyRequested: Bool, shownByUser: Bool) -> Bool {
        signedIn && !alreadyRequested && shownByUser
    }
}

/// Banners cover every inbox, whatever the list is scoped to. With a scoped
/// selection the queue holds one inbox only, so a sync also reads the
/// unscoped lane for banners (the firewall endpoint has no lane filter; the
/// response is cached as the "all" snapshot, which a switch to All paints).
enum PushBannerSource {
    static func needsUnscopedFetch(selection: String) -> Bool {
        inboxQueryParam(selected: selection) != nil
    }
}

/// Whether macOS lets Klorn post banners.
enum NotificationPermission: Equatable, Sendable {
    case notDetermined, authorized, denied
    /// Unbundled `swift run`: there is no notification center to ask.
    case unavailable
}

/// The notification center, behind a seam so the self-check never posts a
/// real banner or raises a real permission prompt.
@MainActor
protocol PushNotifying: AnyObject {
    func requestAuthorization() async -> NotificationPermission
    func permission() async -> NotificationPermission
    func post(_ banner: PushBanner)
    func clearAll()
}

/// The real notification center. Gated on a bundle identifier: an unbundled
/// `swift run` has none and UNUserNotificationCenter is unusable there.
@MainActor
final class SystemPushNotifier: PushNotifying {
    private var isAvailable: Bool { PushNotifier.isAvailable }

    func requestAuthorization() async -> NotificationPermission {
        guard isAvailable else { return .unavailable }
        do {
            _ = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound])
        } catch {
            Log.app.error("notification permission request failed: \(String(describing: error), privacy: .private)")
        }
        return await permission()
    }

    func permission() async -> NotificationPermission {
        guard isAvailable else { return .unavailable }
        return PushNotifier.permission(for: await NotificationCenterCalls.authorizationStatus())
    }

    func post(_ banner: PushBanner) {
        guard isAvailable else {
            Log.app.debug("push banner skipped (unbundled run): \(banner.identifier, privacy: .public)")
            return
        }
        let content = UNMutableNotificationContent()
        content.title = banner.title
        content.body = banner.body
        content.sound = .default
        content.threadIdentifier = PushNotifier.threadIdentifier
        let request = UNNotificationRequest(identifier: banner.identifier, content: content, trigger: nil)
        NotificationCenterCalls.add(request)
    }

    /// Sign-out: take this account's banners out of Notification Center —
    /// the sender and subject on them belong to the account that left.
    func clearAll() {
        guard isAvailable else { return }
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
    }
}

/// UNUserNotificationCenter's callback APIs, called from outside any actor.
///
/// Their completion handlers run on the notification center's own queue. A
/// closure written inside a @MainActor type inherits main-actor isolation, and
/// Swift 6 checks that isolation when the closure runs: 0.4.80106 crashed at
/// every launch with EXC_BREAKPOINT in `closure #1 in
/// SystemPushNotifier.permission()` on the
/// `UNUserNotificationServiceConnection.call-out` thread. Closures created in
/// these nonisolated functions carry no isolation, so nothing is asserted when
/// the callback arrives. (The async `notificationSettings()` is no way out:
/// UNNotificationSettings is not Sendable on the Xcode 16 SDK CI builds with,
/// so it cannot cross the await. UNAuthorizationStatus, a plain enum, can.)
enum NotificationCenterCalls {
    nonisolated static func authorizationStatus() async -> UNAuthorizationStatus {
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                continuation.resume(returning: settings.authorizationStatus)
            }
        }
    }

    nonisolated static func add(_ request: UNNotificationRequest) {
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                Log.app.error("push banner not posted: \(String(describing: error), privacy: .private)")
            }
        }
    }
}

/// Announces newly arrived PUSH mail: a VoiceOver announcement always, and a
/// banner per item while the Settings ▸ Notifications switch is on. The
/// banner is informational only — lanes classify, nothing here acts on mail.
@MainActor
final class PushAlerter {
    private let model: AppModel
    private let announce: @MainActor (String) -> Void

    init(model: AppModel, announce: @escaping @MainActor (String) -> Void = PushAlerter.voiceOver) {
        self.model = model
        self.announce = announce
    }

    /// Returns what was posted, for the harness.
    @discardableResult
    func handleNewPush(_ items: [FirewallItem]) -> [PushBanner] {
        guard !items.isEmpty else { return [] }
        // WCAG 4.1.3 Status Messages: fires whatever the banner switch says.
        announce(Self.pushAnnouncement(newCount: items.count))
        guard model.settings.notificationsEnabled else { return [] }
        let banners = items.map(PushBanner.make(for:))
        banners.forEach { model.pushNotifier.post($0) }
        return banners
    }

    /// A meeting enters its lead window: one banner while the banner switch
    /// is on. Always reports it handled, so each meeting is offered once —
    /// a muted switch must not queue the banner for later.
    @discardableResult
    func handleMeetingSoon(_ event: CalendarEventWire, now: Date = Date()) -> Bool {
        let banner = MeetingBanner.make(for: event, now: now)
        announce(banner.title)
        if model.settings.notificationsEnabled { model.pushNotifier.post(banner) }
        return true
    }

    /// VoiceOver announcement for newly arrived PUSH. Pure for testing.
    nonisolated static func pushAnnouncement(newCount n: Int) -> String {
        L("push.announce", n)
    }

    static func voiceOver(_ message: String) {
        AccessibilityNotification.Announcement(message).post()
    }
}

/// Identifiers and permission mapping for our banners (PUSH and meetings).
enum PushNotifier {
    /// Namespace for our request identifiers. The item id is appended verbatim,
    /// so a tap can recover it — see `itemID(fromNotificationIdentifier:)`.
    nonisolated static let identifierPrefix = "klorn-push-"
    /// Meeting banners: the event id appended verbatim, like PUSH.
    nonisolated static let meetingPrefix = "klorn-meeting-"
    /// Groups Klorn's banners into one stack in Notification Center.
    nonisolated static let threadIdentifier = "klorn-push"

    @MainActor static var isAvailable: Bool { Bundle.main.bundleIdentifier != nil }

    /// Pure, testable identity for a posted banner.
    nonisolated static func notificationIdentifier(for itemID: String) -> String {
        identifierPrefix + itemID
    }

    nonisolated static func meetingIdentifier(for eventID: String) -> String {
        meetingPrefix + eventID
    }

    /// Recover the item id a banner was posted for. Returns nil for anything we
    /// did not post, so a foreign notification can never be mistaken for ours.
    /// Uses a single leading-prefix strip (not a replace) so an item id that
    /// itself contains the prefix survives the round trip.
    nonisolated static func itemID(fromNotificationIdentifier identifier: String) -> String? {
        guard identifier.hasPrefix(identifierPrefix) else { return nil }
        return String(identifier.dropFirst(identifierPrefix.count))
    }

    nonisolated static func permission(for status: UNAuthorizationStatus) -> NotificationPermission {
        switch status {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .authorized, .provisional, .ephemeral: .authorized
        @unknown default: .notDetermined
        }
    }

    nonisolated static func tapAction(
        identifier: String,
        isKnownItem: (String) -> Bool
    ) -> NotificationTapAction {
        if identifier.hasPrefix(meetingPrefix) {
            return .openMeeting(eventID: String(identifier.dropFirst(meetingPrefix.count)))
        }
        guard let id = itemID(fromNotificationIdentifier: identifier) else { return .ignore }
        return isKnownItem(id) ? .open(itemID: id) : .openApp
    }
}

/// What a tapped banner should do. Pure so the routing is verifiable without
/// a notification centre, a window server, or a running app.
enum NotificationTapAction: Equatable {
    /// Not our notification — leave it alone.
    case ignore
    /// Open this item in the main window's reading pane.
    case open(itemID: String)
    /// Ours, but the item is no longer in the queue (handled elsewhere, or the
    /// queue refreshed). Open the main window anyway: a tap never does nothing.
    case openApp
    /// A meeting banner: open the main window on Calendar.
    case openMeeting(eventID: String)
}
