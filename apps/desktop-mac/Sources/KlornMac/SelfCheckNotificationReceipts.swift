import Foundation
import os
import UserNotifications

// Self-check for notification receipts (2026-11-12), run by
// `KlornMac --self-check`. The Mac reports what became of a banner it posted
// to POST /api/notifications/desktop/receipts (packages/api
// routes/desktop-receipts.ts, #1720):
//
// - `shown` when UNUserNotificationCenter.add completed with no error;
// - `clicked` when the user opened the banner (the default action). The Mac
//   posts no action buttons, so `actioned` has no source here;
// - `attention_item` for a mail banner (`klorn-push-<id>`), `calendar_event`
//   for a meeting-soon banner (`klorn-meeting-<id>`). The summaries
//   (`klorn-held-…`, `klorn-more-…`) stand for several mails and report
//   nothing;
// - fire-and-forget: a network error or 5xx is retried with backoff, then
//   dropped; a 4xx never retried; paced under the server's 60 / minute.
//
// Network, clock and sleep are fakes; nothing here posts a banner or a request.

@MainActor
func notificationReceiptSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ cond: Bool) { results.append((name, cond)) }
    func text(_ file: String) -> String {
        (try? String(contentsOf: sourceDir.appendingPathComponent(file), encoding: .utf8)) ?? ""
    }
    typealias Rules = NotificationReceiptRules
    let item = "0b9f6c1e-4a51-4d1e-9c4f-2f7d1f0a9b3c"
    let event = "1c2d3e4f-0000-4000-8000-000000000002"

    // MARK: Which banners report, and as what

    check("a mail banner reports as an attention_item",
          Rules.receipt(forIdentifier: PushNotifier.notificationIdentifier(for: item), event: .shown)
              == NotificationReceipt(event: .shown, kind: .attentionItem, id: item))
    check("a meeting-soon banner reports as a calendar_event",
          Rules.receipt(forIdentifier: PushNotifier.meetingIdentifier(for: event), event: .clicked)
              == NotificationReceipt(event: .clicked, kind: .calendarEvent, id: event))
    check("the held and \"+N more\" summaries report nothing (no single id)",
          Rules.receipt(forIdentifier: PushNotifier.summaryIdentifier(for: item), event: .shown) == nil
          && Rules.receipt(forIdentifier: PushNotifier.moreIdentifier(for: item), event: .shown) == nil
          && Rules.receipt(forIdentifier: PushNotifier.moreIdentifier(for: item), event: .clicked) == nil)
    check("a foreign notification or an id that is not a uuid reports nothing",
          Rules.receipt(forIdentifier: "com.other.app-\(item)", event: .shown) == nil
          && Rules.receipt(forIdentifier: PushNotifier.notificationIdentifier(for: "x1"), event: .shown) == nil
          && Rules.receipt(forIdentifier: PushNotifier.notificationIdentifier(for: item + "0"), event: .shown) == nil
          && Rules.receipt(forIdentifier: PushNotifier.meetingIdentifier(for: "evt-1"), event: .shown) == nil
          && Rules.receipt(forIdentifier: PushNotifier.notificationIdentifier(for: ""), event: .shown) == nil)
    check("the default action is a click; dismiss and anything else report nothing",
          Rules.event(forAction: UNNotificationDefaultActionIdentifier) == .clicked
          && Rules.event(forAction: UNNotificationDismissActionIdentifier) == nil
          && Rules.event(forAction: "reply") == nil)

    let wire = (try? JSONEncoder().encode(NotificationReceipt(event: .shown, kind: .attentionItem, id: item)))
        .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }
    check("the wire body is exactly the endpoint's: app, event, kind, id (no action)",
          wire == ["app": "mac", "event": "shown", "kind": "attention_item", "id": item])
    let meetingWire = (try? JSONEncoder().encode(NotificationReceipt(event: .clicked, kind: .calendarEvent, id: event)))
        .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }
    check("a meeting click encodes kind calendar_event and event clicked",
          meetingWire?["kind"] == "calendar_event" && meetingWire?["event"] == "clicked")

    // MARK: Retry or drop (the contract: never retry a 4xx)

    check("success is done; no answer or a 5xx is retried",
          Rules.verdict(after: nil) == .done
          && Rules.verdict(after: APIError.transport("offline", code: -1009)) == .retry
          && Rules.verdict(after: APIError.http(503, nil)) == .retry
          && Rules.verdict(after: APIError.http(500, nil)) == .retry)
    check("every 4xx is dropped, never retried",
          [APIError.http(400, nil), .http(404, nil), .http(429, nil), .unauthorized, .forbidden]
              .allSatisfy { Rules.verdict(after: $0) == .drop })
    check("only a 429 pauses the queue",
          Rules.isRateLimited(APIError.http(429, nil))
          && !Rules.isRateLimited(APIError.http(404, nil)) && !Rules.isRateLimited(nil))

    // MARK: Pacing

    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    check("pacing: under the cap, send now",
          Rules.nextSendAt(sent: [], now: t0) == t0
          && Rules.nextSendAt(sent: Array(repeating: t0, count: Rules.rateMax - 1), now: t0) == t0)
    check("pacing: at the cap, wait until the oldest send in the window ages out",
          Rules.nextSendAt(
              sent: (0..<Rules.rateMax).map { t0.addingTimeInterval(Double($0)) },
              now: t0.addingTimeInterval(Double(Rules.rateMax)))
              == t0.addingTimeInterval(Rules.rateWindow))
    check("pacing: a clock moved back never stalls the queue (sends \"in the future\" do not count)",
          Rules.nextSendAt(
              sent: Array(repeating: t0.addingTimeInterval(3600), count: Rules.rateMax), now: t0) == t0)
    check("pacing stays under the server's 60 per minute",
          Rules.rateMax < 60 && Rules.rateWindow == 60)

    // MARK: The reporter

    check("report returns at once (any thread) and the receipt still goes out",
          await ReceiptHarness.reportEventuallySends())

    check("network error: retried with backoff, then dropped",
          await ReceiptHarness.run(answers: [.transport, .transport, .transport, .transport]) { reporter in
              await reporter.enqueue(NotificationReceipt(event: .shown, kind: .attentionItem, id: item))
          }.matches(sends: 1 + Rules.retryDelays.count, sleeps: Rules.retryDelays, pending: 0))
    check("a 5xx is retried until it lands",
          await ReceiptHarness.run(answers: [.status(503), .ok]) { reporter in
              await reporter.enqueue(NotificationReceipt(event: .shown, kind: .attentionItem, id: item))
          }.matches(sends: 2, sleeps: [Rules.retryDelays[0]], pending: 0))
    for answer in [ReceiptHarness.Answer.status(400), .status(404), .unauthorized, .forbidden] {
        check("a 4xx (\(answer)) is sent once and dropped",
              await ReceiptHarness.run(answers: [answer]) { reporter in
                  await reporter.enqueue(NotificationReceipt(event: .clicked, kind: .calendarEvent, id: event))
              }.matches(sends: 1, sleeps: [], pending: 0))
    }
    let burst = Rules.rateMax + 5
    let paced = await ReceiptHarness.run(answers: []) { reporter in
        for _ in 0..<burst { await reporter.enqueue(NotificationReceipt(event: .shown, kind: .attentionItem, id: item)) }
    }
    check("a burst is paced: \(Rules.rateMax) at once, the rest after the window",
          paced.sends.count == burst
          && paced.sends.prefix(Rules.rateMax).allSatisfy { $0 == paced.sends.first }
          && paced.sends.last.map { $0.timeIntervalSince(paced.sends[0]) >= Rules.rateWindow } == true)
    let limited = await ReceiptHarness.run(answers: [.status(429), .ok]) { reporter in
        await reporter.enqueue(NotificationReceipt(event: .shown, kind: .attentionItem, id: item))
        await reporter.enqueue(NotificationReceipt(event: .shown, kind: .attentionItem, id: item))
    }
    check("a 429 drops that receipt and pauses the queue for a window",
          limited.sends.count == 2
          && limited.sends[1].timeIntervalSince(limited.sends[0]) >= Rules.rateWindow
          && limited.pending == 0)
    check("past the queue cap, receipts are dropped, not stored",
          await ReceiptHarness.queueCapHolds())

    // MARK: Wiring (the isolation lesson of 0.4.80106)

    let notifications = text("Notifications.swift")
    let app = text("KlornApp.swift")
    let model = text("AppModel.swift")
    check("shown: reported from the add completion, only with no error, built outside any actor",
          notifications.contains("nonisolated static func add(_ request: UNNotificationRequest, receipts: NotificationReceiptReporter?)")
          && notifications.contains("if let receipt { receipts?.report(receipt) }")
          && notifications.contains("NotificationCenterCalls.add(request, receipts: receipts)"))
    check("clicked: didReceive maps the action and reports through the model's reporter",
          app.contains("NotificationReceiptRules.event(forAction: response.actionIdentifier)")
          && app.contains("self?.model.receipts.report(receipt)"))
    check("signed out: the shipped send asks nothing of the server",
          text("NotificationReceipts.swift").contains("guard api.token() != nil else { throw APIError.unauthorized }"))
    check("the shipped notifier reports to the model's reporter, built off the main actor",
          model.contains("SystemPushNotifier(receipts: receipts)")
          && model.contains("NotificationReceiptReporter.live(api: api)"))
    return results
}

/// Drives a `NotificationReceiptReporter` on a fake clock: sleeping advances
/// the clock at once, and each send answers the next scripted `Answer`.
/// Main-actor, like the suite that calls it, so `run`'s `act` closure may be
/// main-actor too. The fakes it hands the reporter go to `@Sendable`
/// parameters and are nonisolated, as the shipped ones are.
@MainActor
enum ReceiptHarness {
    enum Answer: Sendable, CustomStringConvertible {
        case ok, transport, unauthorized, forbidden
        case status(Int)

        var description: String {
            switch self {
            case .ok: "ok"
            case .transport: "transport"
            case .unauthorized: "401"
            case .forbidden: "403"
            case .status(let code): "\(code)"
            }
        }

        func result() throws {
            switch self {
            case .ok: return
            case .transport: throw APIError.transport("offline", code: -1009)
            case .unauthorized: throw APIError.unauthorized
            case .forbidden: throw APIError.forbidden
            case .status(let code): throw APIError.http(code, nil)
            }
        }
    }

    struct Outcome {
        let sends: [Date]
        let sleeps: [TimeInterval]
        let pending: Int

        func matches(sends count: Int, sleeps expected: [TimeInterval], pending left: Int) -> Bool {
            sends.count == count && sleeps == expected && pending == left
        }
    }

    struct State: Sendable {
        var now = Date(timeIntervalSince1970: 1_800_000_000)
        var sends: [Date] = []
        var sleeps: [TimeInterval] = []
        var answers: [Answer] = []
    }

    static func reporter(
        _ state: OSAllocatedUnfairLock<State>, gate: ReceiptGate? = nil
    ) -> NotificationReceiptReporter {
        NotificationReceiptReporter(
            send: { _ in
                let answer = state.withLock { s -> Answer in
                    s.sends.append(s.now)
                    return s.answers.isEmpty ? .ok : s.answers.removeFirst()
                }
                await gate?.wait()
                try answer.result()
            },
            now: { state.withLock { $0.now } },
            sleep: { seconds in
                state.withLock { s in
                    s.sleeps.append(seconds)
                    s.now = s.now.addingTimeInterval(max(seconds, 0))
                }
            })
    }

    static func run(
        answers: [Answer], _ act: (NotificationReceiptReporter) async -> Void
    ) async -> Outcome {
        let state = OSAllocatedUnfairLock(initialState: State(answers: answers))
        let reporter = reporter(state)
        await act(reporter)
        await reporter.idle()
        let pending = await reporter.pendingCount()
        return state.withLock { Outcome(sends: $0.sends, sleeps: $0.sleeps, pending: pending) }
    }

    /// `report` is the fire-and-forget door the notification center's queue
    /// uses: it returns at once and the receipt still goes out.
    static func reportEventuallySends() async -> Bool {
        let state = OSAllocatedUnfairLock(initialState: State())
        let reporter = reporter(state)
        reporter.report(NotificationReceipt(
            event: .shown, kind: .attentionItem, id: "0b9f6c1e-4a51-4d1e-9c4f-2f7d1f0a9b3c"))
        for _ in 0..<2000 where state.withLock({ $0.sends.isEmpty }) {
            try? await Task.sleep(for: .milliseconds(1))
        }
        await reporter.idle()
        return state.withLock { $0.sends.count } == 1
    }

    /// Holds the first send open, fills the queue past its cap, then lets go.
    static func queueCapHolds() async -> Bool {
        let gate = ReceiptGate()
        let state = OSAllocatedUnfairLock(initialState: State())
        let reporter = reporter(state, gate: gate)
        let receipt = NotificationReceipt(
            event: .shown, kind: .attentionItem, id: "0b9f6c1e-4a51-4d1e-9c4f-2f7d1f0a9b3c")
        await reporter.enqueue(receipt)
        for _ in 0..<2000 where state.withLock({ $0.sends.isEmpty }) {
            try? await Task.sleep(for: .milliseconds(1))
        }
        guard !state.withLock({ $0.sends.isEmpty }) else { return false }
        for _ in 0..<(NotificationReceiptRules.queueMax + 10) { await reporter.enqueue(receipt) }
        let held = await reporter.pendingCount()
        await gate.release()
        await reporter.idle()
        let sends = state.withLock { $0.sends.count }
        return held == NotificationReceiptRules.queueMax && sends == NotificationReceiptRules.queueMax + 1
    }
}

/// A door the fake send waits behind until the harness opens it.
actor ReceiptGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}
