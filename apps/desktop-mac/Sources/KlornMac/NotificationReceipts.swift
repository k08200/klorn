import Foundation
import UserNotifications

// MARK: - Notification receipts (2026-11-12)
//
// What became of a banner this Mac posted, reported to
// POST /api/notifications/desktop/receipts (packages/api
// routes/desktop-receipts.ts, #1720), so "did it reach the person, and did
// they act?" has an answer on the desktop too:
//
// - `shown`   — UNUserNotificationCenter.add completed with no error
//               (`NotificationCenterCalls.add`);
// - `clicked` — the user opened the banner, the default action
//               (`AppDelegate.userNotificationCenter(_:didReceive:)`).
//               Klorn's banners carry no action buttons, so `actioned` has
//               no source on the Mac.
//
// A mail banner (`klorn-push-<id>`) reports as `attention_item`, a meeting-soon
// banner (`klorn-meeting-<id>`) as `calendar_event`. The summaries
// (`klorn-held-…`, `klorn-more-…`) stand for several mails and carry only the
// first one's id, so they report nothing: a receipt for that one id would
// claim a banner of its own that was never shown.
//
// Fire-and-forget: reporting never blocks or delays a banner and never throws.

/// One report, exactly the endpoint's body. Sendable: it is built on the
/// notification center's own queue and handed to the reporter actor.
struct NotificationReceipt: Encodable, Equatable, Sendable {
    enum Event: String, Encodable, Sendable { case shown, clicked }
    enum Kind: String, Encodable, Sendable {
        case attentionItem = "attention_item"
        case calendarEvent = "calendar_event"
    }

    let app = "mac"
    let event: Event
    let kind: Kind
    let id: String

    init(event: Event, kind: Kind, id: String) {
        self.event = event
        self.kind = kind
        self.id = id
    }
}

/// The rules, pure and nonisolated: callable from the notification center's
/// queue, the reporter actor and the self-check alike.
enum NotificationReceiptRules {
    static let path = "/api/notifications/desktop/receipts"
    /// Requests per window at most: half the server's 60 / minute per user,
    /// which the user's other devices share.
    static let rateMax = 30
    static let rateWindow: TimeInterval = 60
    /// Wait before each retry; one attempt more than there are delays, then drop.
    static let retryDelays: [TimeInterval] = [2, 10]
    /// Receipts waiting at most; more are dropped.
    static let queueMax = 100
    /// Per request: a stuck request must not hold the queue for URLSession's 60 s.
    static let requestTimeout: TimeInterval = 15
    /// The endpoint's id shape, `^[0-9a-fA-F-]{36}$`.
    static let idLength = 36

    enum Verdict: Equatable, Sendable { case done, retry, drop }

    nonisolated static func isReceiptID(_ id: String) -> Bool {
        id.utf8.count == idLength && id.utf8.allSatisfy { $0 == UInt8(ascii: "-") || $0.isHexDigit }
    }

    /// The receipt for the banner posted as `identifier`, or nil: a summary,
    /// another app's notification, or an id the endpoint would refuse.
    nonisolated static func receipt(
        forIdentifier identifier: String, event: NotificationReceipt.Event
    ) -> NotificationReceipt? {
        let kinds: [(prefix: String, kind: NotificationReceipt.Kind)] = [
            (PushNotifier.identifierPrefix, .attentionItem),
            (PushNotifier.meetingPrefix, .calendarEvent),
        ]
        guard let match = kinds.first(where: { identifier.hasPrefix($0.prefix) }) else { return nil }
        let id = String(identifier.dropFirst(match.prefix.count))
        return isReceiptID(id) ? NotificationReceipt(event: event, kind: match.kind, id: id) : nil
    }

    /// The event a banner response reports: the default action (the user
    /// opened the banner) is a click. Klorn registers no action buttons, and a
    /// dismissal is not delivered (no custom-dismiss category).
    nonisolated static func event(forAction actionIdentifier: String) -> NotificationReceipt.Event? {
        actionIdentifier == UNNotificationDefaultActionIdentifier ? .clicked : nil
    }

    /// After one attempt: nil error is done; no answer or a 5xx is retried;
    /// every 4xx is dropped (the endpoint's contract: never retry a 4xx).
    nonisolated static func verdict(after error: (any Error)?) -> Verdict {
        guard let error else { return .done }
        switch error as? APIError {
        case .http(let status, _)?: return status >= 500 ? .retry : .drop
        case .unauthorized?, .forbidden?, .decoding?: return .drop
        case .transport?, nil: return .retry
        }
    }

    /// A 429: the user's budget is spent for now, so the queue waits a window.
    nonisolated static func isRateLimited(_ error: (any Error)?) -> Bool {
        if case .http(429, _)? = error as? APIError { return true }
        return false
    }

    /// The sends that count against the window at `now`. One "in the future"
    /// (the clock was moved back) does not count, so it cannot stall the queue.
    nonisolated static func inWindow(_ sent: [Date], now: Date) -> [Date] {
        sent.filter { $0 > now.addingTimeInterval(-rateWindow) && $0 <= now }
    }

    /// When the next request may go, given when the recent ones went.
    nonisolated static func nextSendAt(sent: [Date], now: Date) -> Date {
        let recent = inWindow(sent, now: now)
        guard recent.count >= rateMax else { return now }
        return recent[recent.count - rateMax].addingTimeInterval(rateWindow)
    }
}

private extension UInt8 {
    var isHexDigit: Bool {
        (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(self)
            || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(self)
            || (UInt8(ascii: "A")...UInt8(ascii: "F")).contains(self)
    }
}

/// Sends receipts one at a time, paced under the server's limit, retrying a
/// failure with backoff and then dropping it. An actor, so `report` is safe
/// from any thread — the notification center calls back on its own queue.
actor NotificationReceiptReporter {
    typealias Send = @Sendable (NotificationReceipt) async throws -> Void
    typealias Sleep = @Sendable (TimeInterval) async -> Void

    private struct Pending: Sendable {
        let receipt: NotificationReceipt
        let attempts: Int
        let notBefore: Date
    }

    private let send: Send
    private let now: @Sendable () -> Date
    private let sleep: Sleep
    private var queue: [Pending] = []
    private var sentAt: [Date] = []
    private var pausedUntil = Date.distantPast
    private var drainTask: Task<Void, Never>?

    init(
        send: @escaping Send,
        now: @escaping @Sendable () -> Date = { Date() },
        sleep: @escaping Sleep = { seconds in try? await Task.sleep(for: .seconds(max(seconds, 0))) }
    ) {
        self.send = send
        self.now = now
        self.sleep = sleep
    }

    /// The shipped reporter: POST through `api`, with the session's Bearer
    /// token read at send time; signed out, it drops without a request.
    /// Static, so its closures are formed outside any actor (the 0.4.80106
    /// lesson: no inherited isolation in callbacks).
    static func live(api: APIClient) -> NotificationReceiptReporter {
        NotificationReceiptReporter(send: { receipt in
            guard api.token() != nil else { throw APIError.unauthorized }
            try await api.data(
                NotificationReceiptRules.path, method: "POST",
                body: try JSONEncoder().encode(receipt), contentType: "application/json",
                timeout: NotificationReceiptRules.requestTimeout)
        })
    }

    /// Fire-and-forget, from any thread: returns at once, never throws.
    nonisolated func report(_ receipt: NotificationReceipt) {
        Task { await self.enqueue(receipt) }
    }

    /// Queue a receipt and start sending if idle. Internal for the self-check.
    func enqueue(_ receipt: NotificationReceipt) {
        guard queue.count < NotificationReceiptRules.queueMax else {
            Log.app.info("notification receipt dropped: queue full")
            return
        }
        queue = queue + [Pending(receipt: receipt, attempts: 0, notBefore: .distantPast)]
        guard drainTask == nil else { return }
        drainTask = Task { await self.drain() }
    }

    /// Receipts waiting (not counting one in flight). For the self-check.
    func pendingCount() -> Int { queue.count }

    /// Returns once the queue has drained. For the self-check.
    func idle() async {
        while let task = drainTask { await task.value }
    }

    private func drain() async {
        while !queue.isEmpty, !Task.isCancelled {
            let current = now()
            sentAt = NotificationReceiptRules.inWindow(sentAt, now: current)
            let gate = max(NotificationReceiptRules.nextSendAt(sent: sentAt, now: current), pausedUntil)
            let ready = queue.firstIndex { $0.notBefore <= current }
            let earliest = queue.map(\.notBefore).min() ?? current
            let sendAt = ready == nil ? max(gate, earliest) : gate
            guard let ready, sendAt <= current else {
                await sleep(sendAt.timeIntervalSince(current))
                continue
            }
            let item = queue[ready]
            queue = Array(queue[..<ready] + queue[(ready + 1)...])
            sentAt = sentAt + [current]
            await attempt(item)
        }
        drainTask = nil
    }

    private func attempt(_ item: Pending) async {
        let failure = await outcome(of: item.receipt)
        if NotificationReceiptRules.isRateLimited(failure) {
            pausedUntil = now().addingTimeInterval(NotificationReceiptRules.rateWindow)
        }
        let verdict = NotificationReceiptRules.verdict(after: failure)
        let attempts = item.attempts + 1
        let delays = NotificationReceiptRules.retryDelays
        if verdict == .retry, attempts <= delays.count {
            let retry = Pending(
                receipt: item.receipt, attempts: attempts,
                notBefore: now().addingTimeInterval(delays[attempts - 1]))
            queue = queue + [retry]
        } else if verdict != .done {
            Log.app.info(
                "notification receipt dropped: \(item.receipt.event.rawValue, privacy: .public) after \(attempts) attempt(s)")
        }
    }

    private func outcome(of receipt: NotificationReceipt) async -> (any Error)? {
        do {
            try await send(receipt)
            return nil
        } catch {
            return error
        }
    }
}
