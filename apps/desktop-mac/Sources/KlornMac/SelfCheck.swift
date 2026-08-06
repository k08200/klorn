import AppKit
import Carbon.HIToolbox
import Foundation
import SwiftUI
import os

// Runnable verification harness. The Command Line Tools toolchain ships no
// XCTest/Testing, so the auth state machine + decoding are checked here in
// plain Swift via `swift run KlornMac --self-check` (exit 0 = all pass). These
// mirror the TS desktop-login.ts unit tests one-for-one.

/// Sendable-safe holder so stubs can be captured by the flow's @Sendable closures.
private func locked<T: Sendable>(_ initial: T) -> OSAllocatedUnfairLock<T> {
    OSAllocatedUnfairLock(initialState: initial)
}

private func makeDeps(
    nonce: String? = "N1",
    opened: OSAllocatedUnfairLock<[String]> = locked([]),
    outcomes: [PollOutcome] = [.ok(token: "jwt-123")],
    clock: OSAllocatedUnfairLock<Double> = locked(0),
    cancelled: @escaping @Sendable () -> Bool = { false }
) -> AuthFlowDeps {
    let idx = locked(0)
    return AuthFlowDeps(
        fetchNonce: { nonce },
        openLogin: { url in opened.withLock { $0.append(url) } },
        pollToken: { _ in
            idx.withLock { i in
                let o = outcomes[min(i, outcomes.count - 1)]
                i += 1
                return o
            }
        },
        sleep: { clock.withLock { $0 += AuthFlow.pollIntervalSeconds } },
        now: { clock.withLock { $0 } },
        isCancelled: cancelled
    )
}

private let base = "http://localhost:3001"

/// Block the calling thread while the async checks run (used from the CLI entry).
func runSelfChecksBlocking() -> Bool {
    let sem = DispatchSemaphore(value: 0)
    let out = locked(false)
    Task {
        let ok = await runSelfChecks()
        out.withLock { $0 = ok }
        sem.signal()
    }
    sem.wait()
    return out.withLock { $0 }
}

func runSelfChecks() async -> Bool {
    var failures = 0
    func check(_ name: String, _ cond: Bool) {
        print(cond ? "  ✓ \(name)" : "  ✗ \(name)")
        if !cond { failures += 1 }
    }
    func reason(_ r: SignInResult) -> SignInFailure? {
        if case .failure(let reason, _) = r { return reason }
        return nil
    }

    print("AuthFlow:")
    let opened = locked([String]())
    let happy = await AuthFlow.run(makeDeps(opened: opened), apiBase: base)
    check("happy path → success", happy == .success(token: "jwt-123"))
    let url = opened.withLock { $0.first } ?? ""
    check("opens desktop login URL", url.contains("/api/auth/google/login")
        && url.contains("source=desktop") && url.contains("nonce=N1"))

    let pending = await AuthFlow.run(
        makeDeps(outcomes: [.pending, .pending, .ok(token: "jwt-late")]), apiBase: base)
    check("polls through pending → token", pending == .success(token: "jwt-late"))

    let blip = await AuthFlow.run(makeDeps(outcomes: [.retry, .ok(token: "j")]), apiBase: base)
    check("retries transient → success", blip == .success(token: "j"))

    let opened2 = locked([String]())
    let noNonce = await AuthFlow.run(makeDeps(nonce: nil, opened: opened2), apiBase: base)
    check("nonce failure → nonceFailed", reason(noNonce) == .nonceFailed)
    check("nonce failure does not open browser", opened2.withLock { $0.isEmpty })

    let inv = await AuthFlow.run(makeDeps(outcomes: [.invalidNonce]), apiBase: base)
    check("404 → invalidNonce", reason(inv) == .invalidNonce)

    let exp = await AuthFlow.run(makeDeps(outcomes: [.expired]), apiBase: base)
    check("410 → expired", reason(exp) == .expired)

    let timeout = await AuthFlow.run(makeDeps(outcomes: [.pending]), apiBase: base)
    check("never completes → timeout", reason(timeout) == .timeout)

    let cancelled = await AuthFlow.run(makeDeps(outcomes: [.pending], cancelled: { true }), apiBase: base)
    check("cancelled → cancelled", reason(cancelled) == .cancelled)

    print("Decoding:")
    let fwJSON = """
    {"tiers":{"PUSH":[{"id":"1","source":"email","sourceId":"e1","type":"email","title":"Hi",
    "tier":"PUSH","tierReason":"VIP sender","priority":5,"surfacedAt":"2026-06-24T10:00:00Z",
    "email":{"emailDbId":"d1","subject":"Invoice due","from":"boss@co.com","snippet":"…"},
    "hashStale":false}],"QUEUE":[],"SILENT":[],"AUTO":[]},
    "summary":{"PUSH":1,"QUEUE":0,"SILENT":0,"AUTO":0,"total":1}}
    """
    if let fw = try? JSONDecoder().decode(FirewallResponse.self, from: Data(fwJSON.utf8)) {
        check("FirewallResponse counts", fw.summary.push == 1 && fw.summary.total == 1)
        check("FirewallResponse items", fw.items(for: .push).first?.email?.subject == "Invoice due"
            && fw.items(for: .queue).isEmpty)
    } else {
        check("FirewallResponse decodes", false)
    }

    let okTok = try? JSONDecoder().decode(
        DesktopTokenResponse.self, from: Data(#"{"status":"ok","token":"jwt"}"#.utf8))
    check("DesktopToken ok", okTok?.status == "ok" && okTok?.token == "jwt")
    let pendTok = try? JSONDecoder().decode(
        DesktopTokenResponse.self, from: Data(#"{"status":"pending"}"#.utf8))
    check("DesktopToken pending", pendTok?.status == "pending" && pendTok?.token == nil)

    // EmailDetail learned-engagement signal — present decodes, absent stays nil
    // (decoding must be resilient: strangers omit the field entirely).
    let engJSON = #"{"id":"e1","from":"a@co.com","engagement":{"outboundCount":5,"learnedImportance":0.9}}"#
    let engDetail = try? JSONDecoder().decode(EmailDetail.self, from: Data(engJSON.utf8))
    check("EmailDetail engagement decodes", engDetail?.engagement?.outboundCount == 5)
    let noEng = try? JSONDecoder().decode(
        EmailDetail.self, from: Data(#"{"id":"e2","from":"b@co.com"}"#.utf8))
    check("EmailDetail no-engagement is nil", noEng != nil && noEng?.engagement == nil)

    // Engagement display logic — reply-count phrasing, learned-importance buckets,
    // clamping, and the color-independent accessibility label.
    check("engagement reply count (plural)",
          engDetail?.engagement?.replyCountLabel == L("engagement.repliedTimes", 5))
    check("engagement reply count (singular)",
          EmailDetail.Engagement(outboundCount: 1, learnedImportance: 0.25).replyCountLabel
              == L("engagement.repliedOnce"))
    let saturated = EmailDetail.Engagement(outboundCount: 6, learnedImportance: 1.0)
    check("importance label: consistent", saturated.importanceLabel == L("engagement.consistent"))
    check("importance label: important",
          EmailDetail.Engagement(outboundCount: 2, learnedImportance: 0.5).importanceLabel == L("engagement.important"))
    check("importance label: building",
          EmailDetail.Engagement(outboundCount: 1, learnedImportance: 0.25).importanceLabel == L("engagement.building"))
    check("importance fill clamps high", EmailDetail.Engagement(outboundCount: 9, learnedImportance: 1.5).importanceFill == 1.0)
    let faded = EmailDetail.Engagement(outboundCount: 2, learnedImportance: 0.0)
    check("faded engagement hides meter", faded.importanceFill == 0.0 && !faded.showsImportance)
    check("faded a11y label omits importance", faded.accessibilityLabel == faded.replyCountLabel)
    check("engaged a11y label combines count + strength",
          saturated.accessibilityLabel
              == L("engagement.combined.a11y", L("engagement.repliedTimes", 6), L("engagement.consistent")))

    print("Notifications:")
    func push(_ id: String) -> FirewallItem {
        FirewallItem(id: id, source: "email", sourceId: id, type: "email", title: id,
                     tier: .push, tierReason: nil, priority: 0, surfacedAt: "",
                     email: nil, href: nil, hashStale: nil)
    }
    let base0 = planPushNotifications(seen: [], baselineEstablished: false,
                                      pushItems: [push("a"), push("b")])
    check("first load = silent baseline", base0.toNotify.isEmpty && base0.seen == ["a", "b"])

    let next = planPushNotifications(seen: ["a", "b"], baselineEstablished: true,
                                     pushItems: [push("a"), push("b"), push("c")])
    check("notifies only the new PUSH item",
          next.toNotify.map(\.id) == ["c"] && next.seen == ["a", "b", "c"])

    let none = planPushNotifications(seen: ["a", "b"], baselineEstablished: true,
                                     pushItems: [push("a"), push("b")])
    check("no new PUSH = no notifications", none.toNotify.isEmpty)

    // Notification identity round-trips, so a banner tap can find its item.
    // Without this the OS banner is a dead end: it interrupts you and then has
    // nowhere to take you (dogfood: "the notification does nothing").
    check("notification id encodes the item id",
          PushNotifier.notificationIdentifier(for: "item-42") == "klorn-push-item-42")
    check("notification id round-trips back to the item id",
          PushNotifier.itemID(fromNotificationIdentifier: "klorn-push-item-42") == "item-42")
    check("item ids containing the prefix survive the round trip",
          PushNotifier.itemID(
              fromNotificationIdentifier: PushNotifier.notificationIdentifier(
                  for: "klorn-push-nested")) == "klorn-push-nested")
    check("a foreign notification id is not claimed",
          PushNotifier.itemID(fromNotificationIdentifier: "other-app-1") == nil)

    // Tap routing: a known item opens in the reading pane; one that has since
    // left the queue still shows the bar (a tap must never be a no-op); a
    // foreign banner is left alone.
    check("tapping a live item opens it",
          PushNotifier.tapAction(identifier: "klorn-push-i1", isKnownItem: { $0 == "i1" })
              == .open(itemID: "i1"))
    check("tapping a vanished item falls back to expanding the bar",
          PushNotifier.tapAction(identifier: "klorn-push-gone", isKnownItem: { _ in false })
              == .expand)
    check("tapping another app's notification is ignored",
          PushNotifier.tapAction(identifier: "someone-else", isKnownItem: { _ in true })
              == .ignore)

    print("PushCard:")
    // Keymap — only an explicit arm gives the card the keyboard, and these are
    // the only keys it may consume (1/2/3 send, Return open, Esc dismiss).
    check("key 1 sends option 0", PushCardKeymap.action(chars: "1", keyCode: 18) == .send(0))
    check("key 2 sends option 1", PushCardKeymap.action(chars: "2", keyCode: 19) == .send(1))
    check("key 3 sends option 2", PushCardKeymap.action(chars: "3", keyCode: 20) == .send(2))
    check("return opens on web", PushCardKeymap.action(chars: "\r", keyCode: 36) == .open)
    check("esc dismisses", PushCardKeymap.action(chars: nil, keyCode: 53) == .dismiss)
    check("key 4 is not consumed", PushCardKeymap.action(chars: "4", keyCode: 21) == nil)
    check("letters are not consumed", PushCardKeymap.action(chars: "a", keyCode: 0) == nil)

    // Card queue — FIFO, deduped by id, one card at a time.
    var cardQueue = PushCardQueue()
    cardQueue.enqueue([push("a"), push("b")])
    check("queue presents first item", cardQueue.current?.id == "a" && cardQueue.pendingCount == 1)
    cardQueue.enqueue([push("b"), push("c")])
    check("queue dedups by id", cardQueue.items.map(\.id) == ["a", "b", "c"])
    cardQueue.advance()
    check("advance moves to next", cardQueue.current?.id == "b" && cardQueue.pendingCount == 1)
    cardQueue.advance()
    cardQueue.advance()
    check("advance past end empties", cardQueue.current == nil && cardQueue.pendingCount == 0)
    cardQueue.advance()  // must not trap on empty
    check("advance on empty is safe", cardQueue.current == nil)

    // Reply options — wire shape from POST /api/email/:id/reply-options
    // (packages/contract reply-options.ts): exactly 3 drafts, fixed tone order.
    let optJSON = """
    {"to":"boss@co.com","subject":"Re: Invoice due","options":[
    {"tone":"accept","body":"Yes, works for me."},
    {"tone":"decline","body":"Sorry, I can't."},
    {"tone":"info","body":"Which invoice?"}]}
    """
    if let opts = try? JSONDecoder().decode(ReplyOptionsResponse.self, from: Data(optJSON.utf8)) {
        check("ReplyOptions decodes 3 drafts", opts.options.count == 3 && opts.to == "boss@co.com")
        check("ReplyOptions keeps tone order",
              opts.options.map(\.tone) == ["accept", "decline", "info"])
        check("tone labels", opts.options.map(\.toneLabel)
              == [L("reply.tone.accept"), L("reply.tone.decline"), L("reply.tone.info")])
    } else {
        check("ReplyOptions decodes", false)
    }
    check("unknown tone label falls back",
          ReplyOption(tone: "urgent", body: "x").toneLabel == "Urgent")

    // Layout metrics + morph math (reference-video parity: present-morph,
    // click-to-expand). All pure so the harness can pin the geometry.
    check("compact size", PushCardMetrics.size(for: .compact) == PushCardMetrics.compact)
    check("expanded size", PushCardMetrics.size(for: .expanded) == PushCardMetrics.expanded)
    check("expanded is strictly larger",
          PushCardMetrics.expanded.width > PushCardMetrics.compact.width
          && PushCardMetrics.expanded.height > PushCardMetrics.compact.height)
    let morphTarget = NSRect(x: 100, y: 100, width: 460, height: 360)
    let morphStart = PushCardMetrics.presentStartFrame(target: morphTarget)
    check("present-morph starts hugging the top edge",
          morphStart.maxY == morphTarget.maxY && morphStart.height < morphTarget.height)
    check("present-morph start stays horizontally centered",
          abs(morphStart.midX - morphTarget.midX) < 0.5)
    let screen = NSRect(x: 0, y: 0, width: 1512, height: 950)
    let compactFrame = PushCardController.cardFrame(
        size: PushCardMetrics.compact, visible: screen)
    let expandedFrame = PushCardController.cardFrame(
        size: PushCardMetrics.expanded, visible: screen)
    check("card pinned top-center below the pill",
          compactFrame.midX == screen.midX
          && compactFrame.maxY == screen.maxY - PushCardController.topOffset)
    check("expand keeps the top edge anchored (grows downward)",
          expandedFrame.maxY == compactFrame.maxY && expandedFrame.midX == compactFrame.midX)

    // Expanded-view detail text: Klorn summary first, snippet fallback, nil when empty.
    check("detail prefers Klorn summary", cardDetailText(summary: "S", snippet: "sn") == "S")
    check("detail falls back to snippet", cardDetailText(summary: "", snippet: "sn") == "sn")
    check("detail nil when both empty", cardDetailText(summary: nil, snippet: " ") == nil)

    print("Top bar window fit:")
    // Small-display fit: full was a hardcoded 1400×860 that clipped on 13"
    // screens, and the frame math never consulted the screen (2026-08-05).
    let smallScreen = NSRect(x: 0, y: 0, width: 1280, height: 775)
    let fittedFull = TopBarMetrics.fittedSize(
        ideal: TopBarMetrics.full, visible: smallScreen.size, floor: TopBarMetrics.fullMin)
    check("full shrinks to fit a small display",
          fittedFull.width <= smallScreen.width - TopBarMetrics.screenMargin * 2
          && fittedFull.height <= smallScreen.height - TopBarMetrics.screenMargin * 2)
    check("screen clamp beats the floor — no off-screen window on tiny displays",
          {
              let s = TopBarMetrics.fittedSize(
                  ideal: TopBarMetrics.full, visible: NSSize(width: 640, height: 400),
                  floor: TopBarMetrics.fullMin)
              return s.width <= 640 - TopBarMetrics.screenMargin * 2
                  && s.height <= 400 - TopBarMetrics.screenMargin * 2
          }())
    check("floor still lifts a too-small ideal on a roomy display",
          TopBarMetrics.fittedSize(
              ideal: NSSize(width: 300, height: 300), visible: NSSize(width: 1512, height: 950),
              floor: TopBarMetrics.fullMin) == TopBarMetrics.fullMin)
    check("large displays keep the ideal size",
          TopBarMetrics.fittedSize(
              ideal: TopBarMetrics.full, visible: NSSize(width: 1512, height: 950),
              floor: TopBarMetrics.fullMin) == TopBarMetrics.full)
    let fittedFrame = TopBarMetrics.pinnedFrame(size: fittedFull, visible: smallScreen, topMargin: 8)
    check("pinned frame stays fully on screen", smallScreen.contains(fittedFrame))
    check("pinned frame is top-centered",
          abs(fittedFrame.midX - smallScreen.midX) < 0.5
          && fittedFrame.maxY == smallScreen.maxY - 8)
    check("full panel is user-resizable",
          TopBarController.styleMask(focusable: true).contains(.resizable))
    check("same-state re-render never reframes (snap-back fix)",
          !TopBarController.shouldSetFrame(
              renderedState: .full, state: .full, panelVisible: true, frameLost: false))
    check("state morph, first show, and a lost frame each reframe",
          TopBarController.shouldSetFrame(
              renderedState: .collapsed, state: .full, panelVisible: true, frameLost: false)
          && TopBarController.shouldSetFrame(
              renderedState: .full, state: .full, panelVisible: false, frameLost: false)
          && TopBarController.shouldSetFrame(
              renderedState: .full, state: .full, panelVisible: true, frameLost: true))
    check("drag floor is screen-clamped on small displays",
          TopBarMetrics.fittedSize(
              ideal: TopBarMetrics.fullMin, visible: NSSize(width: 800, height: 500)).width
              <= 800 - TopBarMetrics.screenMargin * 2)
    check("pill/expanded panel stays fixed and non-activating",
          !TopBarController.styleMask(focusable: false).contains(.resizable)
          && TopBarController.styleMask(focusable: false).contains(.nonactivatingPanel))
    check("stored size below the floor is lifted",
          AppSettings.resolveFullWindowSize(
              ["width": 100.0, "height": 100.0], floor: TopBarMetrics.fullMin)
              == TopBarMetrics.fullMin)
    check("malformed stored size resolves nil",
          AppSettings.resolveFullWindowSize("junk", floor: TopBarMetrics.fullMin) == nil)
    check("valid stored size round-trips",
          AppSettings.resolveFullWindowSize(
              ["width": 1200.0, "height": 700.0], floor: TopBarMetrics.fullMin)
              == NSSize(width: 1200, height: 700))
    check("first launch fires exactly once",
          AppSettings.isFirstLaunch(nil) && !AppSettings.isFirstLaunch(true))

    print("Link inbox:")
    check("link URL parses from the start response",
          LinkInboxFlow.url(from: Data(#"{"url":"https://accounts.google.com/o/oauth2/v2/auth?x=1"}"#.utf8))
          != nil)
    check("non-https link URL is refused",
          LinkInboxFlow.url(from: Data(#"{"url":"javascript:alert(1)"}"#.utf8)) == nil)
    check("malformed link body is refused",
          LinkInboxFlow.url(from: Data("nope".utf8)) == nil)

    print("Sender name:")
    // The raw From header is routing data. A list row that leads with
    // "<sarah.kim@northwind-partners.com>" hides the one thing that identifies
    // the sender, and truncates before it gets there.
    check("display name wins over the address",
          senderDisplayName("Sarah Kim <sarah@x.io>") == "Sarah Kim")
    check("quoted display names are unwrapped",
          senderDisplayName("\"Kim, Sarah\" <sarah@x.io>") == "Kim, Sarah")
    check("a bare address is shown as-is",
          senderDisplayName("billing@vendor.io") == "billing@vendor.io")
    check("an address with no name loses only the brackets",
          senderDisplayName("<billing@vendor.io>") == "billing@vendor.io")
    check("non-Latin display names survive",
          senderDisplayName("이준호 <junho@team.co.kr>") == "이준호")
    check("empty input stays empty",
          senderDisplayName(nil).isEmpty && senderDisplayName("").isEmpty)

    print("No web escape:")
    // Klorn is a native client, not a launcher for its own web app: the only
    // link out is sign-in (AuthFlow) and the GitHub release page (UpdateCheck).
    // A new NSWorkspace.open on a Klorn URL would quietly reintroduce the
    // "finish this on the web" round trip the app exists to remove, so the rule
    // is checked against the sources rather than trusted to review.
    let sourceDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let swiftFiles = (try? FileManager.default.contentsOfDirectory(at: sourceDir, includingPropertiesForKeys: nil))?
        .filter { $0.pathExtension == "swift" } ?? []
    check("sources are readable", !swiftFiles.isEmpty)
    let allowedWebBaseUsers: Set<String> = ["AuthFlow.swift", "Config.swift", "SelfCheck.swift"]
    let offenders = swiftFiles.filter { url in
        guard !allowedWebBaseUsers.contains(url.lastPathComponent),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return false }
        return text.contains("Config.webBaseURL")
    }
    check("nothing navigates to the Klorn web app",
          offenders.isEmpty)
    if !offenders.isEmpty {
        print("      offenders: \(offenders.map(\.lastPathComponent).joined(separator: ", "))")
    }

    print("Dismiss:")
    let fw2JSON = """
    {"tiers":{"PUSH":[{"id":"p1","source":"email","sourceId":"e1","type":"email","title":"a",
    "tier":"PUSH","tierReason":null,"priority":1,"surfacedAt":"","email":null,"hashStale":null},
    {"id":"p2","source":"email","sourceId":"e2","type":"email","title":"b","tier":"PUSH",
    "tierReason":null,"priority":1,"surfacedAt":"","email":null,"hashStale":null}],
    "QUEUE":[],"SILENT":[],"AUTO":[]},"summary":{"PUSH":2,"QUEUE":0,"SILENT":0,"AUTO":0,"total":2}}
    """
    if let fw = try? JSONDecoder().decode(FirewallResponse.self, from: Data(fw2JSON.utf8)) {
        let after = fw.removingIDs(["p1"])
        check("removingIDs drops the item", after.items(for: .push).map(\.id) == ["p2"])
        check("removingIDs decrements summary", after.summary.push == 1 && after.summary.total == 1)
        check("removingIDs ignores unknown id",
              fw.removingIDs(["nope"]).summary.push == 2)
        check("allItemIDs collects across tiers", fw.allItemIDs == ["p1", "p2"])

        // Tier correction (teach-the-firewall): optimistic move between tiers.
        let moved = fw.movingItem(id: "p1", to: .silent)
        check("movingItem removes from the old tier", moved.items(for: .push).map(\.id) == ["p2"])
        check("movingItem prepends to the new tier", moved.items(for: .silent).map(\.id) == ["p1"])
        check("movingItem restamps the item's tier", moved.item(id: "p1")?.tier == .silent)
        check("movingItem shifts summary, total unchanged",
              moved.summary.push == 1 && moved.summary.silent == 1 && moved.summary.total == 2)
        check("movingItem to the same tier is a no-op",
              fw.movingItem(id: "p1", to: .push).items(for: .push).map(\.id) == ["p1", "p2"])
        check("movingItem unknown id is a no-op",
              fw.movingItem(id: "nope", to: .silent).summary.push == 2)
    } else {
        check("dismiss fixture decodes", false)
    }
    // Snooze target: 9am the next day, strictly in the future.
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC")!
    let noonJan1 = cal.date(from: DateComponents(year: 2026, month: 1, day: 1, hour: 12))!
    let snoozeTo = AppModel.tomorrow9am(from: noonJan1, calendar: cal)
    let parts = cal.dateComponents([.year, .month, .day, .hour, .minute], from: snoozeTo)
    check("snooze = next day 09:00",
          parts.year == 2026 && parts.month == 1 && parts.day == 2 && parts.hour == 9 && parts.minute == 0)
    check("snooze is in the future", snoozeTo > noonJan1)

    // Snooze options — each resolves to its concrete target, always in the future.
    // noonJan1 = Thu 2026-01-01 12:00 UTC.
    func at(_ opt: SnoozeOption) -> DateComponents {
        cal.dateComponents([.year, .month, .day, .hour, .minute, .weekday],
                           from: opt.resurface(from: noonJan1, calendar: cal))
    }
    let oneHour = at(.oneHour)
    check("snooze 1h = +1 hour same day", oneHour.day == 1 && oneHour.hour == 13 && oneHour.minute == 0)
    let evening = at(.thisEvening)
    check("snooze evening = today 18:00", evening.day == 1 && evening.hour == 18)
    let tom = at(.tomorrow)
    check("snooze tomorrow = next day 09:00", tom.day == 2 && tom.hour == 9)
    let week = at(.nextWeek)  // next Monday after Thu Jan 1 → Mon Jan 5, 09:00
    check("snooze next week = next Monday 09:00", week.weekday == 2 && week.day == 5 && week.hour == 9)
    check("every snooze option is in the future",
          SnoozeOption.allCases.allSatisfy { $0.resurface(from: noonJan1, calendar: cal) > noonJan1 })
    // Past-6pm evening rolls to tomorrow so it's never in the past.
    let latePM = cal.date(from: DateComponents(year: 2026, month: 1, day: 1, hour: 22))!
    let rolled = cal.dateComponents([.day, .hour], from: SnoozeOption.thisEvening.resurface(from: latePM, calendar: cal))
    check("evening after 6pm rolls to tomorrow", rolled.day == 2 && rolled.hour == 18)

    print("Realtime:")
    check("wakes on notification", RealtimeClient.shouldWake(#"{"type":"notification","payload":{}}"#))
    check("wakes on sync", RealtimeClient.shouldWake(#"{"type":"sync"}"#))
    check("ignores connection chatter", !RealtimeClient.shouldWake(#"{"type":"client_joined"}"#))
    check("ignores non-JSON", !RealtimeClient.shouldWake("pong"))
    let ws = RealtimeClient.wsURL()
    let wantScheme = Config.apiBaseURL.hasPrefix("https") ? "wss" : "ws"
    check("ws url = scheme+/ws+desktop, no token in URL",
          ws?.scheme == wantScheme && ws?.path == "/ws"
          && ws?.query?.contains("type=desktop") == true
          && ws?.query?.contains("token=") != true)
    // Heartbeat: a half-open socket (mac sleep, NAT rebind) never errors
    // receive(), so liveness rests on these — pin the pure parts.
    check("backoff doubles", RealtimeClient.nextBackoff(1) == 2)
    check("backoff caps at 30 s",
          RealtimeClient.nextBackoff(20) == 30 && RealtimeClient.nextBackoff(30) == 30)
    check("ping cadence comfortably exceeds the pong timeout",
          RealtimeClient.pingIntervalSeconds > RealtimeClient.pongTimeoutSeconds
          && RealtimeClient.pongTimeoutSeconds > 0)
    let pongBox = PongBox()
    check("pong flag starts clear", !pongBox.isMarked)
    pongBox.mark()
    check("pong flag latches", pongBox.isMarked)

    print("Accessibility:")
    check("reduce motion disables the panel morph",
          !TopBarController.shouldAnimateFrame(reduceMotion: true))
    check("normal motion keeps the panel morph",
          TopBarController.shouldAnimateFrame(reduceMotion: false))
    check("reduce transparency → opaque panel",
          Theme.panelOpacity(reduceTransparency: true) == 1.0)
    check("normal transparency keeps the translucent panel",
          Theme.panelOpacity(reduceTransparency: false) == Theme.panelDefaultOpacity)
    check("push announcement (singular)",
          TopBarController.pushAnnouncement(newCount: 1) == "1 new message needs you")
    check("push announcement (plural)",
          TopBarController.pushAnnouncement(newCount: 3) == "3 new messages need you")

    print("Settings:")
    check("notifications default ON when unset", AppSettings.resolveNotifications(nil))
    check("notifications honor stored false", !AppSettings.resolveNotifications(false))
    check("notifications honor stored true", AppSettings.resolveNotifications(true))
    check("notifications ignore non-bool", AppSettings.resolveNotifications("nope"))
    check("pill default ON when unset", AppSettings.resolvePillVisible(nil))
    check("pill honors stored false", !AppSettings.resolvePillVisible(false))
    check("pill honors stored true", AppSettings.resolvePillVisible(true))
    check("pill ignores non-bool", AppSettings.resolvePillVisible(3))

    // Hidden-pill mode: the collapsed pill draws only when visible-mode is on
    // or a bigger state is open (hiding must never eat the expanded panel).
    check("collapsed pill draws when visible", TopBarController.shouldDraw(state: .collapsed, pillVisible: true))
    check("collapsed pill hides when hidden-mode", !TopBarController.shouldDraw(state: .collapsed, pillVisible: false))
    check("expanded panel draws even in hidden-mode", TopBarController.shouldDraw(state: .expanded, pillVisible: false))
    check("full view draws even in hidden-mode", TopBarController.shouldDraw(state: .full, pillVisible: false))

    print("Card chime:")
    // The arrival sound plays once per NEW batch, only when alerts are on,
    // and never for an empty diff (a reload with nothing new must be silent).
    check("chimes for new PUSH when alerts on",
          PushCardController.shouldChime(newCount: 2, alertsEnabled: true))
    check("silent when alerts off",
          !PushCardController.shouldChime(newCount: 2, alertsEnabled: false))
    check("silent when nothing new",
          !PushCardController.shouldChime(newCount: 0, alertsEnabled: true))

    print("Briefing:")
    // The TODAY column shows a one-line preview of the day's briefing note:
    // markdown bold stripped, whitespace collapsed, capped; nil when empty.
    check("briefing preview strips markdown + collapses",
          briefingPreview("**Top 3 Today**\n1. Handle the contract email\n2. Reply to Alex")
              == "Top 3 Today 1. Handle the contract email 2. Reply to Alex")
    check("briefing preview caps length",
          (briefingPreview(String(repeating: "word ", count: 100))?.count ?? 999) <= 140)
    check("briefing preview nil when blank", briefingPreview("  \n  ") == nil)
    check("briefing preview nil when absent", briefingPreview(nil) == nil)

    print("Calendar:")
    // GET /api/calendar/today/summary wire — prisma dates arrive as ISO strings
    // with millis; decoding must be resilient to null current/nextEvent.
    let calJSON = """
    {"total":2,"current":{"id":"c1","title":"Standup","startTime":"2026-07-16T00:30:00.000Z",
    "endTime":"2026-07-16T01:00:00.000Z","location":null,"meetingLink":"https://meet.example/a",
    "allDay":false},"upcoming":[{"id":"c2","title":"Design review","startTime":"2026-07-16T05:00:00.000Z",
    "endTime":"2026-07-16T06:30:00.000Z","location":"Room 3","meetingLink":null,"allDay":false}],
    "nextEvent":null}
    """
    if let today = try? JSONDecoder().decode(TodaySummary.self, from: Data(calJSON.utf8)) {
        check("TodaySummary decodes", today.total == 2 && today.current?.title == "Standup")
        check("TodaySummary upcoming", today.upcoming.first?.location == "Room 3"
              && today.nextEvent == nil)
    } else {
        check("TodaySummary decodes", false)
    }
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC")!
    check("event time label — range",
          eventTimeLabel(startISO: "2026-07-16T05:00:00.000Z", endISO: "2026-07-16T06:30:00.000Z",
                         allDay: false, calendar: utc) == "05:00–06:30")
    check("event time label — all day",
          eventTimeLabel(startISO: "2026-07-16T00:00:00.000Z", endISO: "2026-07-17T00:00:00.000Z",
                         allDay: true, calendar: utc) == L("calendar.allDay"))
    check("event time label — malformed ISO degrades",
          eventTimeLabel(startISO: "not-a-date", endISO: "also-no", allDay: false, calendar: utc) == "")

    print("Upcoming agenda:")
    // 7-day grouping for the UPCOMING section: today excluded (the TODAY rows
    // own it), window ends 7 days after tomorrow's start, malformed ISO drops
    // the event. Calendar + locale injected so labels are deterministic.
    var agendaCal = Calendar(identifier: .gregorian)
    agendaCal.timeZone = TimeZone(identifier: "UTC")!
    agendaCal.locale = Locale(identifier: "en_US_POSIX")
    // Wed 2026-07-22 09:00 UTC → tomorrow = Thu Jul 23, window ends Jul 30 00:00.
    let agendaNow = ISO8601DateFormatter().date(from: "2026-07-22T09:00:00Z")!
    func agendaEvent(_ id: String, _ startISO: String) -> CalendarEventWire {
        CalendarEventWire(id: id, title: id, startTime: startISO, endTime: startISO,
                          location: nil, meetingLink: nil, allDay: false)
    }
    let agenda = upcomingAgenda(now: agendaNow, events: [
        agendaEvent("today", "2026-07-22T15:00:00.000Z"),        // today → excluded
        agendaEvent("tmrw2", "2026-07-23T10:00:00.000Z"),
        agendaEvent("tmrw1", "2026-07-23T08:00:00.000Z"),        // out of order on purpose
        agendaEvent("sat", "2026-07-25T09:00:00Z"),              // no-millis ISO tolerated
        agendaEvent("beyond", "2026-07-30T09:00:00.000Z"),       // day 8 → excluded
        agendaEvent("bad", "not-a-date"),                        // malformed → dropped
    ], calendar: agendaCal)
    check("agenda keeps only tomorrow → +7 days",
          agenda.flatMap(\.events).map(\.id) == ["tmrw1", "tmrw2", "sat"])
    check("agenda groups by day, first labeled Tomorrow",
          agenda.count == 2 && agenda[0].label == L("calendar.tomorrow") && agenda[0].events.count == 2)
    check("agenda later day gets its weekday name", agenda[1].label == "Saturday")
    check("agenda sorts within a day", agenda[0].events.map(\.id) == ["tmrw1", "tmrw2"])
    check("agenda empty input → empty",
          upcomingAgenda(now: agendaNow, events: [], calendar: agendaCal).isEmpty)
    // GET /api/calendar list envelope ({events}) decodes the wire subset.
    let calListJSON = """
    {"events":[{"id":"u1","title":"Offsite","description":null,"startTime":"2026-07-23T01:00:00.000Z",
    "endTime":"2026-07-23T02:00:00.000Z","location":"HQ","meetingLink":null,"color":null,
    "allDay":false,"googleId":"g1"}]}
    """
    if let list = try? JSONDecoder().decode(CalendarListResponse.self, from: Data(calListJSON.utf8)) {
        check("calendar list wire decodes", list.events.first?.title == "Offsite"
              && list.events.first?.location == "HQ")
    } else {
        check("calendar list wire decodes", false)
    }

    print("Card body:")
    // The expanded card shows the email body inline; whitespace-only bodies
    // collapse to nil (no empty scroll box), real text is trimmed and passed
    // through, and an over-long body is capped so one card can't grow unbounded.
    check("body text passes real content",
          cardBodyText("Hi,\n\nCan we move to 3pm?\n") == "Hi,\n\nCan we move to 3pm?")
    check("blank body → nil", cardBodyText("   \n  ") == nil)
    check("nil body → nil", cardBodyText(nil) == nil)
    let long = String(repeating: "a", count: 5000)
    check("over-long body is capped", (cardBodyText(long)?.count ?? 0) <= 4000)

    print("Text hygiene:")
    check("decodes the live-observed apostrophe entity",
          decodeHTMLEntities("We will alert you when it&#39;s up again")
              == "We will alert you when it's up again")
    check("decodes amp/lt/gt/quot",
          decodeHTMLEntities("a &amp; b &lt;c&gt; &quot;d&quot;") == "a & b <c> \"d\"")
    check("plain text passes through untouched", decodeHTMLEntities("plain") == "plain")
    check("ampersand-free fast path", decodeHTMLEntities("no entities here") == "no entities here")

    print("Self update:")
    check("release zip URL is tag-scoped",
          SelfUpdate.releaseZipURL(version: "0.4.1")?.absoluteString
              == "https://github.com/k08200/klorn/releases/download/desktop-v0.4.1/Klorn-macos.zip")
    check("translocated path detected",
          SelfUpdate.isTranslocated(bundlePath: "/private/var/folders/x/T/AppTranslocation/ID/d/Klorn.app"))
    check("real path not flagged", !SelfUpdate.isTranslocated(bundlePath: "/Applications/Klorn.app"))
    check("real bundle is its own install target",
          SelfUpdate.installTarget(bundlePath: "/Applications/Klorn.app",
                                   homeDirectory: "/Users/u", exists: { _ in false })
              == "/Applications/Klorn.app")
    check("translocated resolves to existing known location",
          SelfUpdate.installTarget(
              bundlePath: "/x/AppTranslocation/y/d/Klorn.app", homeDirectory: "/Users/u",
              exists: { $0 == "/Users/u/Applications/Klorn.app" })
              == "/Users/u/Applications/Klorn.app")
    check("translocated with no known install → nil (fallback path)",
          SelfUpdate.installTarget(bundlePath: "/x/AppTranslocation/y/d/Klorn.app",
                                   homeDirectory: "/Users/u", exists: { _ in false }) == nil)
    check("team id parsed from codesign output",
          SelfUpdate.parseTeamID("Format=app bundle\nTeamIdentifier=P89M32649C\n") == "P89M32649C")
    check("unset team id rejected", SelfUpdate.parseTeamID("TeamIdentifier=not set\n") == nil)
    // Relaunch must WAIT for the old pid — launching early loses to the
    // single-instance guard (observed live 2026-07-20: nobody left running).
    let relaunch = SelfUpdate.relaunchScript(pid: 123, appPath: "/Users/u/Applications/Klorn.app")
    check("relaunch waits on the old pid", relaunch.contains("kill -0 123"))
    check("relaunch opens the app after the wait",
          relaunch.hasSuffix("/usr/bin/open \"/Users/u/Applications/Klorn.app\""))
    check("relaunch quotes embedded double-quotes",
          SelfUpdate.relaunchScript(pid: 1, appPath: "/x/\"odd\"/K.app")
              .contains("open \"/x/\\\"odd\\\"/K.app\""))

    print("Calendar write:")
    var utcCal = Calendar(identifier: .gregorian)
    utcCal.timeZone = TimeZone(identifier: "UTC")!
    let draft = EventDraft(
        title: "Sync with Sarah", startTime: "2026-07-21T05:00:00.000Z",
        endTime: "2026-07-21T06:00:00.000Z", location: "Zoom")
    check("draft label = title · time · location",
          eventDraftLabel(draft, calendar: utcCal) == "Sync with Sarah · 05:00–06:00 · Zoom")
    check("draft label omits missing location",
          eventDraftLabel(
              EventDraft(title: "T", startTime: "2026-07-21T05:00:00.000Z",
                         endTime: "2026-07-21T06:00:00.000Z", location: nil),
              calendar: utcCal) == "T · 05:00–06:00")
    check("draft label survives malformed time",
          eventDraftLabel(
              EventDraft(title: "T", startTime: "not-a-date", endTime: "nope", location: nil),
              calendar: utcCal) == "T")
    let draftTurn = try? JSONDecoder().decode(ChatTurnResponse.self, from: Data("""
    {"reply":"일정 잡을까요?","eventDraft":{"title":"Sync","startTime":"2026-07-21T05:00:00Z",
    "endTime":"2026-07-21T06:00:00Z","location":null}}
    """.utf8))
    check("turn decodes an event draft", draftTurn?.eventDraft?.title == "Sync")
    check("turn without a draft stays nil-draft",
          (try? JSONDecoder().decode(ChatTurnResponse.self,
                                     from: Data(#"{"reply":"ok"}"#.utf8)))?.eventDraft == nil)

    print("Agent activity:")
    func totals(_ e: Int, _ p: Int, _ r: Int) -> TodayActions.Totals {
        TodayActions.Totals(executed: e, rejected: r, pending: p, urgent: 0)
    }
    check("all-zero day hides the block", agentActivityLine(totals(0, 0, 0)) == nil)
    check("executed only", agentActivityLine(totals(2, 0, 0)) == "2 done")
    check("pending only", agentActivityLine(totals(0, 1, 0)) == "1 awaiting approval")
    check("combined keeps done · pending · declined order",
          agentActivityLine(totals(2, 1, 3)) == "2 done · 1 awaiting approval · 3 declined")
    let taJSON = """
    {"executed":[],"rejected":[],"urgent":[],"sinceUtc":"2026-07-19T00:00:00Z",
    "pending":[{"id":"p1","toolName":"send_email","summary":"[확인 필요] send_email",
    "conversationId":"c1","at":"2026-07-03T18:35:54Z"}],
    "totals":{"executed":0,"rejected":0,"pending":1,"urgent":0}}
    """
    if let ta = try? JSONDecoder().decode(TodayActions.self, from: Data(taJSON.utf8)) {
        check("today-actions decodes subset",
              ta.totals.pending == 1 && ta.pending.first?.toolName == "send_email")
    } else {
        check("today-actions decodes", false)
    }

    print("Assistant:")
    check("send allowed for normal text", canSendChat("what matters today?", busy: false))
    check("send blocked while a turn is in flight", !canSendChat("hi", busy: true))
    check("send blocked for blank text", !canSendChat("   \n ", busy: false))
    check("send blocked beyond the server cap",
          !canSendChat(String(repeating: "x", count: 4001), busy: false))
    let turnJSON = #"{"reply":"Here's what matters.","eventDraft":null}"#
    let turn = try? JSONDecoder().decode(ChatTurnResponse.self, from: Data(turnJSON.utf8))
    check("turn response decodes without error field",
          turn?.reply == "Here's what matters." && turn?.error == nil)
    let errTurn = try? JSONDecoder().decode(
        ChatTurnResponse.self,
        from: Data(#"{"reply":"(partial)","error":"provider timeout"}"#.utf8))
    check("turn response carries the error", errTurn?.error == "provider timeout")

    print("Commitments:")
    // The API returns a WRAPPER — {"commitments":[...]} — not a bare array
    // (decoding the bare array silently failed in prod: infinite spinner,
    // 2026-07-20). This fixture mirrors the real wire shape.
    let cJSON = """
    {"commitments":[{"id":"c1","title":"I'll send the SOW","owner":"USER","counterpartyName":"Sarah",
    "counterpartyEmail":"s@co.com","dueText":"by Friday","status":"OPEN","confidence":0.9},
    {"id":"c2","title":"They'll confirm budget","owner":"COUNTERPARTY","counterpartyName":null,
    "counterpartyEmail":"cfo@co.com","dueText":null,"status":"OPEN"},
    {"id":"c3","title":"orphan promise","owner":null,"counterpartyName":null,
    "counterpartyEmail":null,"dueText":null,"status":"OPEN"}]}
    """
    if let cs = (try? JSONDecoder().decode(CommitmentsResponse.self, from: Data(cJSON.utf8)))?
        .commitments {
        check("commitments decode subset", cs.count == 3 && cs[0].title == "I'll send the SOW")
        let groups = commitmentGroups(cs)
        check("counterparty promises → waiting-on", groups.waitingOn.map(\.id) == ["c2"])
        check("user + unknown owner → I-owe", groups.iOwe.map(\.id) == ["c1", "c3"])
        check("counterparty label prefers name", cs[0].counterpartyLabel == "Sarah")
        check("counterparty label falls back to email", cs[1].counterpartyLabel == "cfo@co.com")
        check("counterparty label nil when absent", cs[2].counterpartyLabel == nil)
    } else {
        check("commitments decode", false)
    }

    print("Mailbox search:")
    check("2+ chars activates search", isSearchActive("re"))
    check("1 char does not", !isSearchActive("r"))
    check("whitespace-padded 1 char does not", !isSearchActive("  r  "))
    check("blank does not", !isSearchActive("   "))
    let searchJSON = """
    {"emails":[{"id":"e9","from":"Boss <b@co.com>","subject":"Deal","snippet":"can you…",
    "date":"2026-07-19","isRead":false,"linkedInboxAccountId":"li-1","extraField":123}],
    "total":1,"source":"gmail","unread":1,"page":1}
    """
    if let sr = try? JSONDecoder().decode(EmailSearchResponse.self, from: Data(searchJSON.utf8)) {
        check("search response decodes subset", sr.total == 1 && sr.emails.first?.subject == "Deal")
        check("search row tolerates unknown fields", sr.emails.first?.isRead == false)
        check("search row carries its inbox id", sr.emails.first?.linkedInboxAccountId == "li-1")
    } else {
        check("search response decodes", false)
    }

    print("Multi-inbox:")
    // GET /api/email/inboxes wire (routes/email.ts): the primary row has a
    // NULL id; linked rows carry the LinkedInboxAccount id.
    let inboxJSON = """
    {"inboxes":[{"id":null,"email":"me@co.com","kind":"primary","needsReconnect":false},
    {"id":"li-1","email":"side.acct@gmail.com","kind":"linked","needsReconnect":true}]}
    """
    if let inboxResp = try? JSONDecoder().decode(InboxesResponse.self, from: Data(inboxJSON.utf8)) {
        let two = inboxResp.inboxes
        check("inboxes wire decodes", two.count == 2 && two[0].id == nil && two[1].needsReconnect)
        check("primary selection value is \"primary\"", two[0].selectionValue == "primary")
        check("selector label — all", inboxSelectorLabel(selected: "all", inboxes: two) == L("mail.allInboxes"))
        check("selector label — short name of the selection",
              inboxSelectorLabel(selected: "primary", inboxes: two) == "me"
              && inboxSelectorLabel(selected: "li-1", inboxes: two) == "side.acct")
        check("selector label — stale id reads as all",
              inboxSelectorLabel(selected: "gone", inboxes: two) == L("mail.allInboxes"))
        check("row badge maps null → primary", inboxRowBadge(linkedId: nil, inboxes: two) == "me")
        check("row badge maps a linked id", inboxRowBadge(linkedId: "li-1", inboxes: two) == "side.acct")
        check("row badge hidden with one inbox", inboxRowBadge(linkedId: nil, inboxes: [two[0]]) == nil)
    } else {
        check("inboxes wire decodes", false)
    }
    check("inbox param — all omits", inboxQueryParam(selected: "all") == nil)
    check("inbox param — primary passes", inboxQueryParam(selected: "primary") == "primary")
    check("inbox param — linked id passes", inboxQueryParam(selected: "li-1") == "li-1")
    check("search path scopes to the inbox",
          emailSearchPath(query: "deal", selectedInbox: "primary")
              == "/api/email?search=deal&inbox=primary")
    check("search path omits all-inboxes scope",
          emailSearchPath(query: "deal", selectedInbox: "all") == "/api/email?search=deal")
    check("firewall path — all unscoped",
          firewallPath(selected: "all") == "/api/inbox/firewall")
    check("firewall path — primary scoped",
          firewallPath(selected: "primary") == "/api/inbox/firewall?inbox=primary")
    check("firewall path — linked id scoped (hyphen encoded)",
          firewallPath(selected: "li-1") == "/api/inbox/firewall?inbox=li%2D1")
    check("inbox display label falls back by kind",
          inboxDisplayLabel(email: nil, kind: "primary") == L("mail.inboxPrimary")
          && inboxDisplayLabel(email: nil, kind: "linked") == L("mail.inboxLinked")
          && inboxDisplayLabel(email: "a@b.c", kind: "linked") == "a@b.c")
    check("inbox short name splits + caps",
          inboxShortName("averylongalias.mail@x.io") == "averylongalias"
          && inboxShortName(nil) == nil && inboxShortName("@x.io") == nil)

    print("Auto update check:")
    // Quiet background cadence: first run always checks; then every 6h.
    let t0 = Date(timeIntervalSince1970: 1_000_000)
    check("never checked → due", AppModel.updateCheckDue(now: t0, last: nil))
    check("5h later → not due",
          !AppModel.updateCheckDue(now: t0.addingTimeInterval(5 * 3600), last: t0))
    check("6h later → due",
          AppModel.updateCheckDue(now: t0.addingTimeInterval(6 * 3600), last: t0))
    check(
        "panel interval: 10min after check → not due",
        !AppModel.updateCheckDue(
            now: t0.addingTimeInterval(10 * 60), last: t0,
            intervalSeconds: AppModel.updateCheckPanelIntervalMinutes * 60))
    check(
        "panel interval: 15min after check → due",
        AppModel.updateCheckDue(
            now: t0.addingTimeInterval(15 * 60), last: t0,
            intervalSeconds: AppModel.updateCheckPanelIntervalMinutes * 60))

    print("Shortcut:")
    check("default toggle displays as ⌥⌘K", ShortcutFormat.display(.defaultToggle) == "⌥⌘K")
    check("NS flags → carbon modifiers",
          ShortcutFormat.carbonModifiers(from: [.command, .option]) == UInt32(cmdKey | optionKey))
    check("control+shift maps both",
          ShortcutFormat.carbonModifiers(from: [.control, .shift]) == UInt32(controlKey | shiftKey))
    check("a command shortcut is valid", ShortcutFormat.isValid(carbonModifiers: UInt32(cmdKey)))
    check("shift-only is rejected", !ShortcutFormat.isValid(carbonModifiers: UInt32(shiftKey)))
    check("no modifier is rejected", !ShortcutFormat.isValid(carbonModifiers: 0))
    check("glyph order is ⌃⌥⇧⌘",
          ShortcutFormat.modifierSymbols(UInt32(cmdKey | shiftKey | optionKey | controlKey)) == "⌃⌥⇧⌘")
    check("named key label", ShortcutFormat.keyLabel(UInt32(kVK_Space)) == "Space")
    check("custom shortcut round-trips display",
          ShortcutFormat.display(Shortcut(keyCode: UInt32(kVK_ANSI_J),
                                          carbonModifiers: UInt32(controlKey | cmdKey))) == "⌃⌘J")
    check("settings default shortcut is ⌥⌘K",
          AppSettings.resolveShortcut(nil) == .defaultToggle)
    check("settings restores a stored shortcut",
          AppSettings.resolveShortcut(["keyCode": 38, "carbonModifiers": UInt32(cmdKey)])
              == Shortcut(keyCode: 38, carbonModifiers: UInt32(cmdKey)))

    print("Single instance:")
    // A second launch must defer to the running one (the "two stacked bars"
    // bug) — but only for a real bundle; unbundled `swift run` (nil id) never
    // defers so the harness/dev loop keeps working.
    check("defers when another instance is running",
          Entry.shouldDeferToExistingInstance(bundleID: "ai.klorn.desktop", otherInstanceCount: 1))
    check("launches when it's the only instance",
          !Entry.shouldDeferToExistingInstance(bundleID: "ai.klorn.desktop", otherInstanceCount: 0))
    check("unbundled run never defers",
          !Entry.shouldDeferToExistingInstance(bundleID: nil, otherInstanceCount: 2))

    print("Summon cycle:")
    // ⌥⌘K steps UP one size per press — pill, expanded, full — and from full
    // it dismisses back to rest. Never jumps straight to the big panel.
    check("nothing on screen → show the pill",
          TopBarController.summonAction(isVisible: false, state: .collapsed) == .showPill)
    check("pill → expand",
          TopBarController.summonAction(isVisible: true, state: .collapsed) == .expand)
    check("expanded → full",
          TopBarController.summonAction(isVisible: true, state: .expanded) == .expandFull)
    check("full → dismiss",
          TopBarController.summonAction(isVisible: true, state: .full) == .dismissToRest)
    // A summon draws the pill even in hidden-pill mode (pillVisible=false):
    // the summon is explicit intent, the setting only governs the resting pill.
    check("summon draws the pill in hidden mode",
          TopBarController.shouldDraw(state: .collapsed, pillVisible: false || true))
    check("resting hidden mode still hides the pill",
          !TopBarController.shouldDraw(state: .collapsed, pillVisible: false))

    print("Card snooze:")
    // The card's snooze menu offers the same four options as the reading pane
    // (one source of truth), each with a concrete future resurface time.
    check("snooze menu = all four options",
          PushCardSnooze.options.map(\.rawValue) == ["oneHour", "thisEvening", "tomorrow", "nextWeek"])
    check("snooze menu labels are human",
          PushCardSnooze.options.map(\.label)
              == [L("snooze.oneHour"), L("snooze.thisEvening"), L("snooze.tomorrow"), L("snooze.nextWeek")])
    check("snooze resurfaces in the future",
          SnoozeOption.oneHour.resurface(from: noonJan1, calendar: cal) > noonJan1)

    print("Usage gauge:")
    // /api/billing/models usage → ACCOUNT column gauge (reference HUD's meter).
    let usageJSON = #"{"usage":{"rpmUsed":3,"rpmCap":15,"dailyUsed":137,"dailyCap":500,"dailyResetAt":"2026-07-17T00:00:00.000Z"}}"#
    if let status = try? JSONDecoder().decode(BillingStatusWire.self, from: Data(usageJSON.utf8)) {
        check("usage wire decodes", status.usage.dailyUsed == 137 && status.usage.dailyCap == 500)
    } else {
        check("usage wire decodes", false)
    }
    check("usage fill fraction", usageFillFraction(used: 250, cap: 500) == 0.5)
    check("usage fill clamps over-cap", usageFillFraction(used: 900, cap: 500) == 1.0)
    check("usage fill safe on zero cap", usageFillFraction(used: 10, cap: 0) == 0)
    check("usage label", usageLabel(used: 137, cap: 500) == "137 / 500 today")

    // Card footer "Show all N" mirrors the reference video's session link:
    // only when more items wait behind the current card, N = total queued.
    check("show-all label counts the whole queue", showAllLabel(pendingCount: 2) == "Show all 3")
    check("show-all hidden with an empty queue", showAllLabel(pendingCount: 0) == nil)

    print("Meeting card:")
    // Lead-window planner: surface the FIRST upcoming event whose start is
    // within leadMinutes, once per event id — never one that already started,
    // never twice, never outside the window.
    func event(_ id: String, minutesAway: Int) -> CalendarEventWire {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let now = fmt.date(from: "2026-07-16T09:00:00.000Z")!
        let start = now.addingTimeInterval(Double(minutesAway) * 60)
        return CalendarEventWire(
            id: id, title: id,
            startTime: fmt.string(from: start),
            endTime: fmt.string(from: start.addingTimeInterval(1800)),
            location: nil, meetingLink: nil, allDay: false)
    }
    let planNow = ISO8601DateFormatter().date(from: "2026-07-16T09:00:00Z")!
    check("inside the lead window → surfaces",
          meetingCardPlan(now: planNow, events: [event("m1", minutesAway: 8)],
                          leadMinutes: 10, shown: [])?.id == "m1")
    check("too early → nil",
          meetingCardPlan(now: planNow, events: [event("m2", minutesAway: 45)],
                          leadMinutes: 10, shown: []) == nil)
    check("already started → nil",
          meetingCardPlan(now: planNow, events: [event("m3", minutesAway: -5)],
                          leadMinutes: 10, shown: []) == nil)
    check("already shown → nil",
          meetingCardPlan(now: planNow, events: [event("m4", minutesAway: 8)],
                          leadMinutes: 10, shown: ["m4"]) == nil)
    check("earliest qualifying event wins",
          meetingCardPlan(now: planNow, events: [event("m6", minutesAway: 9), event("m5", minutesAway: 4)],
                          leadMinutes: 10, shown: [])?.id == "m5")
    check("all-day events never interrupt", {
        var allDay = event("m7", minutesAway: 5)
        allDay = CalendarEventWire(id: allDay.id, title: allDay.title, startTime: allDay.startTime,
                                   endTime: allDay.endTime, location: nil, meetingLink: nil, allDay: true)
        return meetingCardPlan(now: planNow, events: [allDay], leadMinutes: 10, shown: []) == nil
    }())

    // Readiness display mapping is fixed vocabulary (server enum).
    check("readiness labels", readinessLabel("ready") == "Ready"
          && readinessLabel("watch") == "Watch"
          && readinessLabel("needs_review") == L("meeting.needsReview")
          && readinessLabel("???") == "Prep")

    // Prep-pack wire decode (subset the card renders).
    let packJSON = """
    {"generatedAt":"2026-07-16T08:55:00.000Z","event":{"id":"m1","title":"Board sync",
    "description":null,"startTime":"2026-07-16T09:10:00.000Z","endTime":"2026-07-16T10:00:00.000Z",
    "location":"Zoom","meetingLink":"https://zoom.us/j/1"},"readiness":"watch",
    "checklist":["Skim the term sheet","Reply to Alex"],"relatedEmails":[],
    "openTasks":[],"openCommitments":[]}
    """
    if let pack = try? JSONDecoder().decode(MeetingPrepPack.self, from: Data(packJSON.utf8)) {
        check("MeetingPrepPack decodes", pack.readiness == "watch"
              && pack.checklist.count == 2 && pack.event.meetingLink != nil)
    } else {
        check("MeetingPrepPack decodes", false)
    }

    print("Launch at login:")
    // Only a packaged .app can register as a login item (SMAppService needs a
    // bundle); the unbundled `swift run` must degrade to a visible explanation,
    // never a silent no-op toggle.
    check("available for a bundled app", LoginItem.availability(hasBundleId: true) == .available)
    check("unbundled run explains itself",
          LoginItem.availability(hasBundleId: false)
              == .unavailable(reason: L("prefs.launchAtLogin.unavailable.value")))

    print("Update check:")
    // Tag comparison: strict semver on the desktop-v prefix; equal or older
    // tags are "up to date", malformed tags never claim an update exists.
    check("newer tag → update", UpdateCheck.compare(current: "0.2.2", latestTag: "desktop-v0.3.0") == .updateAvailable("0.3.0"))
    check("same tag → up to date", UpdateCheck.compare(current: "0.2.2", latestTag: "desktop-v0.2.2") == .upToDate)
    check("older tag → up to date", UpdateCheck.compare(current: "0.3.0", latestTag: "desktop-v0.2.2") == .upToDate)
    check("minor beats patch", UpdateCheck.compare(current: "0.2.9", latestTag: "desktop-v0.3.0") == .updateAvailable("0.3.0"))
    check("malformed tag → unknown", UpdateCheck.compare(current: "0.2.2", latestTag: "v1") == .unknown)
    check("dev build → unknown", UpdateCheck.compare(current: "dev", latestTag: "desktop-v9.9.9") == .unknown)

    print("Status item:")
    check("status line — signed out",
          StatusItemController.statusLine(signedIn: false, pushCount: 9) == L("bar.menuBar.signedOut"))
    check("status line — clear inbox",
          StatusItemController.statusLine(signedIn: true, pushCount: 0) == L("bar.menuBar.clear"))
    check("status line — push count",
          StatusItemController.statusLine(signedIn: true, pushCount: 3) == L("bar.menuBar.push", 3))
    // Exactly one anchor at a time: the pill OR the menu-bar icon, never both,
    // never neither — hiding the pill is what makes the icon appear.
    check("menu-bar icon appears when the pill is hidden",
          StatusItemController.shouldShow(pillVisible: false))
    check("menu-bar icon absent while the pill is visible",
          !StatusItemController.shouldShow(pillVisible: true))

    print("PKCE + relay + TLS (security audit 2026-07-20):")
    // Challenge must match the server's createHash("sha256").digest("base64url").
    check("PKCE challenge matches server digest",
          PKCE.challenge(for: "test-verifier") == "JBbiqONGWPaAmwXk_8bT6UnlPfrn65D32eZlJS-zGG0")
    let pkce = PKCE.generate()
    check("PKCE verifier is 32 bytes base64url (43 chars, no padding)",
          pkce.verifier.count == 43 && !pkce.verifier.contains("=")
          && pkce.challenge == PKCE.challenge(for: pkce.verifier))
    check("login URL carries nonce + relay scheme",
          AuthFlow.loginURL(apiBase: base, nonce: "n1")
          == "\(base)/api/auth/google/login?source=desktop&nonce=n1&appScheme=klorn")
    check("relay URL → code",
          AuthFlow.relayCode(from: URL(string: "klorn://oauth-callback?code=abc")!) == "abc")
    check("wrong scheme → nil",
          AuthFlow.relayCode(from: URL(string: "evil://oauth-callback?code=abc")!) == nil)
    check("missing code → nil",
          AuthFlow.relayCode(from: URL(string: "klorn://oauth-callback")!) == nil)
    // Relay short-circuits the poll: token arrives via exchange-code, and a
    // poll that would say "pending" forever never blocks the sign-in.
    let relayDeps = AuthFlowDeps(
        fetchNonce: { "N1" }, openLogin: { _ in }, pollToken: { _ in .pending },
        sleep: {}, now: { 0 }, isCancelled: { false },
        takeRelayCode: { "relay-code" }, exchangeCode: { $0 == "relay-code" ? "jwt-relay" : nil })
    let relayResult = await AuthFlow.run(relayDeps, apiBase: base)
    check("relay code → success without polling", relayResult == .success(token: "jwt-relay"))
    // Plaintext http is dev-localhost only; a remote http env override is refused.
    check("https remote allowed", Config.validated("https://klorn-api.onrender.com") != nil)
    check("http localhost allowed", Config.validated("http://localhost:3001") != nil)
    check("http remote refused", Config.validated("http://evil.example.com") == nil)

    print("Row reason + chat markdown:")
    // The generic QUEUE fallback restates the tier — suppressed on rows so the
    // list doesn't repeat one noise line 65 times. Specific reasons survive.
    check("boilerplate queue reason suppressed",
          rowTierReason("Visible in queue for manual review") == nil)
    check("specific reason passes through",
          rowTierReason("Manual override — user moved to PUSH")
              == "Manual override — user moved to PUSH")
    check("nil/empty reason → nil",
          rowTierReason(nil) == nil && rowTierReason("") == nil)
    check("markdown bold renders (asterisks consumed)",
          String(chatMarkdown("**Sentry** alert").characters) == "Sentry alert")
    check("plain text untouched", String(chatMarkdown("hello").characters) == "hello")
    check("newlines preserved", String(chatMarkdown("a\nb").characters) == "a\nb")

    print("Glass mask:")
    // The stretchable blur mask must stay non-degenerate on EVERY surface:
    // capInsets summing to ≥ the masked dimension breaks NSImage stretching
    // and the square blur backdrop bleeds past the corner (pill capsule,
    // dogfood zoom 2026-07-20).
    for state in [BarState.collapsed, .expanded, .full] {
        let mask = NSImage.roundedCornerMask(radius: TopBarMetrics.corner(for: state))
        let minSide = min(TopBarMetrics.size(for: state).width, TopBarMetrics.size(for: state).height)
        check("mask caps fit \(state) surface",
              mask.capInsets.top + mask.capInsets.bottom < minSide
              && mask.capInsets.left + mask.capInsets.right < minSide)
    }
    let cardMask = NSImage.roundedCornerMask(radius: PushCardMetrics.corner)
    check("mask caps fit PushCard",
          cardMask.capInsets.top + cardMask.capInsets.bottom < PushCardMetrics.compact.height)

    print("Automation settings:")
    // Decoding must survive an older desktop build meeting a newer server (and
    // vice versa): every field absent has to land on the server's own defaults,
    // not on false/empty, or the panel would show "all notifications off" for a
    // user whose notifications are in fact all on.
    if let sparse = try? JSONDecoder().decode(
        AutomationSettings.self, from: Data("{}".utf8))
    {
        check("absent fields default to server defaults",
              sparse.agentMode == .suggest && sparse.replyTone == .matchMe
              && sparse.isEverything && sparse.quietHoursStart == nil)
    } else {
        check("AutomationSettings decodes an empty object", false)
    }

    let autoJSON = """
    {"agentMode":"AUTO","replyTone":"FORMAL","notifyEmailUrgent":true,"notifyMeeting":true,
    "notifyTaskDue":false,"notifyAgentProposal":false,"notifyDailyBriefing":false,
    "notifyEmailCandidate":false,"quietHoursStart":"22:00","quietHoursEnd":"08:00"}
    """
    if let s = try? JSONDecoder().decode(AutomationSettings.self, from: Data(autoJSON.utf8)) {
        check("decodes mode + tone", s.agentMode == .auto && s.replyTone == .formal)
        check("decodes quiet hours", s.quietHoursStart == "22:00" && s.quietHoursEnd == "08:00")
        check("essentials-only state is recognised", s.isEssentialsOnly && !s.isEverything)
    } else {
        check("AutomationSettings decodes a full payload", false)
    }

    // An unknown mode/tone from a newer server must not crash or silently
    // become a *more* autonomous setting.
    let unknownJSON = #"{"agentMode":"OVERDRIVE","replyTone":"SASSY"}"#
    if let s = try? JSONDecoder().decode(AutomationSettings.self, from: Data(unknownJSON.utf8)) {
        check("unknown mode falls back to ask-first", s.agentMode == .suggest)
        check("unknown tone falls back to match-me", s.replyTone == .matchMe)
    } else {
        check("AutomationSettings tolerates unknown enum values", false)
    }

    // The six notify toggles were decoded and PATCHed but never consulted before
    // presenting anything, so switching a category off changed nothing on this
    // Mac (dogfood: "I turned meetings off and still got the card").
    let allOn = AutomationSettings()
    check("urgent-mail interrupts are allowed when the category is on",
          allOn.allowsInterrupt(for: .emailUrgent))
    check("meeting interrupts are allowed when the category is on",
          allOn.allowsInterrupt(for: .meeting))
    let essentialsOnly = AutomationSettings().applyingEssentialsOnly()
    check("essentials-only still allows urgent mail and meetings",
          essentialsOnly.allowsInterrupt(for: .emailUrgent)
          && essentialsOnly.allowsInterrupt(for: .meeting))
    let mutedMail = AutomationSettings(notifyEmailUrgent: false)
    check("urgent mail off suppresses the mail interrupt",
          !mutedMail.allowsInterrupt(for: .emailUrgent))
    check("urgent mail off leaves meetings alone",
          mutedMail.allowsInterrupt(for: .meeting))
    let mutedMeeting = AutomationSettings(notifyMeeting: false)
    check("meetings off suppresses the meeting card",
          !mutedMeeting.allowsInterrupt(for: .meeting))
    check("meetings off leaves urgent mail alone",
          mutedMeeting.allowsInterrupt(for: .emailUrgent))

    // Before the server's settings arrive the model holds AutomationSettings(),
    // so the defaults decide what happens on a cold start. They must fail OPEN:
    // dropping an urgent interrupt because a fetch was slow is the one failure
    // a firewall cannot make.
    check("a cold start (no settings loaded yet) still interrupts",
          AutomationSettings().allowsInterrupt(for: .emailUrgent)
          && AutomationSettings().allowsInterrupt(for: .meeting))

    let essentials = AutomationSettings().applyingEssentialsOnly()
    check("essentials keeps urgent mail + meetings",
          essentials.notifyEmailUrgent && essentials.notifyMeeting)
    check("essentials mutes the rest",
          !essentials.notifyTaskDue && !essentials.notifyAgentProposal
          && !essentials.notifyDailyBriefing && !essentials.notifyEmailCandidate)
    check("everything preset turns all categories on",
          essentials.applyingEverything().isEverything)

    // Clearing quiet hours has to reach the server as an explicit null; a
    // dropped key would leave the old window in place.
    let cleared = AutomationSettings().patchPayload
    check("cleared quiet hours PATCH as null",
          cleared["quietHoursStart"] is NSNull && cleared["quietHoursEnd"] is NSNull)
    check("PATCH carries mode, tone and all six categories",
          cleared["agentMode"] as? String == "SUGGEST"
          && cleared["replyTone"] as? String == "MATCH_ME"
          && NotifyCategory.all.allSatisfy { cleared[$0.id] != nil })

    check("quiet hours normalize pads to HH:mm", QuietHours.normalize("9:5") == "09:05")
    check("quiet hours normalize accepts 4 digits", QuietHours.normalize("2200") == "22:00")
    check("quiet hours normalize passes through", QuietHours.normalize("22:00") == "22:00")
    check("quiet hours reject out-of-range",
          QuietHours.normalize("24:00") == nil && QuietHours.normalize("22:60") == nil)
    check("quiet hours reject junk",
          QuietHours.normalize("later") == nil && QuietHours.normalize("22") == nil
          && QuietHours.normalize("") == nil)
    check("half a window is discarded",
          QuietHours.pair(start: "22:00", end: "").start == nil)
    check("a full window survives", QuietHours.pair(start: "22:00", end: "8:00")
          == (start: "22:00", end: "08:00"))

    print("Activation policy:")
    // Resting must stay out of Cmd+Tab and the Dock — an ambient firewall that
    // shows up in the app switcher is no longer ambient. Everything the user
    // deliberately opened must be in it, or there is no way to switch back.
    check("collapsed stays out of Cmd+Tab",
          TopBarController.activationPolicy(for: .collapsed) == .accessory)
    check("expanded joins Cmd+Tab",
          TopBarController.activationPolicy(for: .expanded) == .regular)
    check("full joins Cmd+Tab",
          TopBarController.activationPolicy(for: .full) == .regular)

    // Opt-in escape hatch: people who expect Cmd+Tab to reach every running app
    // can have that, without changing what Klorn is by default. The default
    // stays ambient — the checks above are the showInDock=false path.
    check("the default is unchanged: resting is still ambient",
          TopBarController.activationPolicy(for: .collapsed, showInDock: false) == .accessory)
    check("showInDock puts the resting app in Cmd+Tab and the Dock",
          TopBarController.activationPolicy(for: .collapsed, showInDock: true) == .regular)
    check("showInDock does not change an already-open panel",
          TopBarController.activationPolicy(for: .expanded, showInDock: true) == .regular
          && TopBarController.activationPolicy(for: .full, showInDock: true) == .regular)
    check("show-in-Dock defaults to off when nothing is stored",
          !AppSettings.resolveShowInDock(nil))
    check("show-in-Dock honors a stored true",
          AppSettings.resolveShowInDock(true))
    check("show-in-Dock ignores a non-bool",
          !AppSettings.resolveShowInDock("yes"))

    print("One way out:")
    // Both panels offered sign-out twice: once in the header, once under the
    // account heading. Two controls for one destructive action is the kind of
    // thing that makes a user wonder whether they differ — and the header copy
    // sat directly beside the ✕, so the riskiest action lived next to the most
    // reflexive one. Sign-out now lives only where account actions belong.
    // Checked against the sources, like the web-escape rule, because a future
    // header could quietly add it back.
    // Count real call sites, skipping this file (its own literals would match).
    let signOutCallSites = swiftFiles.reduce(0) { total, url in
        guard url.lastPathComponent != "SelfCheck.swift",
              let text = try? String(contentsOf: url, encoding: .utf8) else { return total }
        return total + text.components(separatedBy: "actions.onSignOut()").count - 1
    }
    // Three, one per surface that has an account area: the expanded panel's
    // account column, the full sidebar, and Preferences. None in a header.
    check("sign-out is offered once per surface, not twice", signOutCallSites == 3)
    let headerSignOut = swiftFiles.contains { url in
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return false }
        return text.contains("Button(L(\"auth.signOut\")")
    }
    check("no header offers sign-out beside the ✕", !headerSignOut)

    print("Column header tracking:")
    // Wide tracking is a Latin small-caps device: it makes "RECENT PUSH" read
    // as a deliberate micro-label. Hangul syllable blocks already carry their
    // own internal spacing, so the same value pulls "최근 PUSH" apart and
    // costs legibility — the one tracking value was wrong for one of the two
    // scripts (apple-design: tracking is script- and size-specific).
    check("Latin headers keep the editorial tracking",
          ColumnHeader.tracking(for: "RECENT PUSH") == 1.4)
    check("Hangul headers drop it", ColumnHeader.tracking(for: "최근 PUSH") == 0)
    check("a pure-Hangul header drops it", ColumnHeader.tracking(for: "수신함") == 0)
    check("an empty title is treated as Latin", ColumnHeader.tracking(for: "") == 1.4)

    print("Korean josa:")
    // "%@(으)로" is a workaround, not Korean — the collapsed pill already gets
    // this right ("PUSH 3건"), so the app contradicted itself. Pick the
    // particle from the final consonant of the preceding word.
    check("no final consonant takes 로", L10n.josaRo(after: "Queue") == "로")
    check("final consonant takes 으로", L10n.josaRo(after: "Push") == "으로")
    check("Hangul without a final consonant takes 로", L10n.josaRo(after: "메모") == "로")
    check("Hangul with a final consonant takes 으로", L10n.josaRo(after: "받은편지함") == "으로")
    // ㄹ is the exception: 서울로, never 서울으로.
    check("a final ㄹ still takes 로", L10n.josaRo(after: "서울") == "로")
    check("digits are read as spoken, so 3 takes 으로", L10n.josaRo(after: "3") == "으로")
    check("2 has no final consonant when spoken, so it takes 로", L10n.josaRo(after: "2") == "로")
    check("an empty string falls back to the plain particle", L10n.josaRo(after: "") == "로")

    check("no final consonant takes 와", L10n.josaWa(after: "Queue") == "와")
    check("final consonant takes 과", L10n.josaWa(after: "Push") == "과")
    check("Hangul without a final consonant takes 와", L10n.josaWa(after: "메모") == "와")
    check("Hangul with a final consonant takes 과", L10n.josaWa(after: "받은편지함") == "과")

    print("Tier guide:")
    // The one first run is the only one there is: showing the explainer over a
    // signed-out shell spends it on someone with no mail to explain.
    check("offered on a first run with a mailbox",
          GuideSeen.shouldPresent(seen: false, signedIn: true))
    check("not offered before sign-in",
          !GuideSeen.shouldPresent(seen: false, signedIn: false))
    check("not offered twice", !GuideSeen.shouldPresent(seen: true, signedIn: true))

    // Every tier must explain itself: a blank blurb would leave the sidebar
    // exactly as unexplained as before, and only for that one tier.
    check("every tier has a distinct meaning",
          Set(Tier.allCases.map(\.blurb)).count == Tier.allCases.count
          && Tier.allCases.allSatisfy { !$0.blurb.isEmpty && !$0.blurb.hasPrefix("tier.") })
    check("every tier has an empty state",
          Set(Tier.allCases.map(\.emptyTitle)).count == Tier.allCases.count
          && Tier.allCases.allSatisfy { !$0.emptyTitle.hasPrefix("tier.") })

    print("Localization:")
    // A key present in one language and missing in another ships a raw key
    // ("prefs.done") to whoever runs the other language — the kind of bug that
    // only the untested locale ever sees.
    let english = L10n.keys(forLanguage: "en")
    check("English catalogue loads", !english.isEmpty)
    for code in L10n.shipped where code != "en" {
        let other = L10n.keys(forLanguage: code)
        let missing = english.subtracting(other).sorted()
        let extra = other.subtracting(english).sorted()
        check("\(code) has every English key", missing.isEmpty)
        if !missing.isEmpty { print("      missing: \(missing.joined(separator: ", "))") }
        check("\(code) defines no unknown keys", extra.isEmpty)
        if !extra.isEmpty { print("      unknown: \(extra.joined(separator: ", "))") }
    }

    // Every key carrying a format specifier, exercised with the argument type
    // its call site passes. A "%@" fed an Int makes String(format:) read the
    // integer as a pointer and segfault — a crash that only fires in the
    // language and screen that owns the bad key, so it must be checked here
    // rather than found in dogfood.
    check("integer formats render", [
        L("bar.push", 3), L("bar.more", 2), L("commitments.a11y", 4),
        L("aiUsage.a11y", 7, 20), L("bar.menuBar.push", 9),
        L("engagement.repliedTimes", 5),
    ].allSatisfy { $0.contains(where: \.isNumber) })
    check("string formats render", [
        L("today.a11y", "x"), L("briefing.a11y", "x"), L("commitments.markDone.a11y", "x"),
        L("commitments.dismiss.a11y", "x"), L("calendar.join.a11y", "x"),
        L("calendar.proposed.a11y", "x"), L("mail.filterByInbox.a11y", "x"),
        L("mail.inbox.a11y", "x"), L("mail.searchResult.a11y", "x", "y"),
        L("mail.snooze.a11y", "x"), L("mail.dismiss.a11y", "x"),
        L("mail.changeTier.a11y", "x", "y"), L("mail.moveTo", "x", "y"), L("mail.whyTier", "x", "y"),
        L("reading.replyTo", "x"), L("push.sendReply.a11y", "x", "y"),
        L("prefs.updates.get", "x"), L("prefs.updates.upToDate", "x"),
        L("prefs.shortcut.change.a11y", "x"), L("prefs.infoRow.a11y", "x", "y"),
        L("engagement.combined.a11y", "x", "y"), L("proposals.row.a11y", "x", "y"),
        L("mail.needsReconnect", "x"), L("calendar.eventRow.a11y", "x", "y"),
        L("mail.noMatches", "x", "y"),
    ].allSatisfy { $0.contains("x") && !$0.contains("%") })
    // Mixed string+integer formats: the argument ORDER must survive too, since
    // a "%1$@ %2$d" fed the wrong way round is the same pointer-read crash.
    check("mixed formats render", [
        L("tier.row.a11y", "x", 3, "y"), L("proposals.a11y", 2),
    ].allSatisfy { !$0.contains("%") })

    // Three separate passes each missed strings here, because the misses were
    // never in `Text("…")` — they were in helpers that take a plain String
    // (ColumnHeader, EmptyState, sidebarAction, SubtleTextButton). Grepping for
    // the helpers is what actually finds them, so the harness does it.
    let localizingHelpers = [
        "ColumnHeader(title: \"", "EmptyState(icon: \"", "sidebarAction(\"",
        "SubtleTextButton(title: \"", "actionItem(\"",
    ]
    let unlocalized = swiftFiles.filter { url in
        guard url.lastPathComponent != "SelfCheck.swift",
              let text = try? String(contentsOf: url, encoding: .utf8) else { return false }
        // EmptyState's first argument is an SF Symbol name, not a string the
        // user reads; only its `title:` matters.
        return localizingHelpers.contains { helper in
            helper == "EmptyState(icon: \"" ? text.contains("\", title: \"") : text.contains(helper)
        }
    }
    check("no user-facing string bypasses the catalogue", unlocalized.isEmpty)
    if !unlocalized.isEmpty {
        print("      offenders: \(unlocalized.map(\.lastPathComponent).joined(separator: ", "))")
    }

    // The helper grep above still only knows the helpers it was told about, and
    // three rounds of misses were three different shapes. This one is
    // shape-agnostic: any literal that reads like a sentence — two or more
    // words, starting with a capital — is prose, and prose belongs in the
    // catalogue. Comments, keys, symbol names and format strings don't match.
    let proseLiteral = try! NSRegularExpression(
        pattern: #""[A-Z][a-z]+(?: [A-Za-z,'’]+){1,}\.?""#)
    var proseOffenders: [String] = []
    let proseExempt: Set<String> = ["SelfCheck.swift", "PreviewRender.swift"]
    for url in swiftFiles where !proseExempt.contains(url.lastPathComponent) {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            // Skip comments and the catalogue-facing call itself.
            if trimmed.hasPrefix("//") || trimmed.hasPrefix("///") || trimmed.hasPrefix("*") {
                continue
            }
            if trimmed.contains("Log.") || trimmed.contains("Announcement(") { continue }
            // Explicitly marked server values: compared against, never displayed.
            if trimmed.contains("// wire-value") { continue }
            let range = NSRange(trimmed.startIndex..., in: trimmed)
            if proseLiteral.firstMatch(in: trimmed, range: range) != nil {
                proseOffenders.append("\(url.lastPathComponent): \(trimmed.prefix(60))")
            }
        }
    }
    check("no sentence-shaped literal outside the catalogue", proseOffenders.isEmpty)
    for offender in proseOffenders.prefix(8) { print("      \(offender)") }

    check("override wins over the system language",
          L10n.resolvedCode(override: .korean, preferred: ["en-US"]) == "ko")
    check("system follows the preferred language",
          L10n.resolvedCode(override: .system, preferred: ["ko-KR", "en-US"]) == "ko")
    check("region tags are matched on the base language",
          L10n.resolvedCode(override: .system, preferred: ["ko-Hang-KR"]) == "ko")
    check("an unshipped language falls back to English",
          L10n.resolvedCode(override: .system, preferred: ["fr-FR", "de-DE"]) == "en")
    check("no preferred language falls back to English",
          L10n.resolvedCode(override: .system, preferred: []) == "en")

    // WCAG 2.2 AA contrast (the CLAUDE.md baseline). textDim carries
    // caption-sized text on the glass panel AND on surfaceRaised cards, so both
    // stacks must clear the 4.5:1 text floor (1.4.3). The engage tone only
    // colors non-text signal (chip icon + meter), so it gets the 3:1 graphics
    // floor (1.4.11). Ratios are computed from the live Theme colors — a future
    // palette tweak that drops below the floor fails here, not in dogfood.
    func srgba(_ color: Color) -> (r: Double, g: Double, b: Double, a: Double) {
        // Fail loudly: a silent black fallback would make every fg-on-light
        // check pass at 21:1 and hide a real regression.
        guard let ns = NSColor(color).usingColorSpace(.sRGB) else {
            fatalError("theme color is not sRGB-convertible")
        }
        return (ns.redComponent, ns.greenComponent, ns.blueComponent, ns.alphaComponent)
    }
    func luminance(_ c: (r: Double, g: Double, b: Double, a: Double)) -> Double {
        func lin(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
    }
    func contrast(_ fg: Color, on bg: (r: Double, g: Double, b: Double, a: Double)) -> Double {
        let (a, b) = (luminance(srgba(fg)) + 0.05, luminance(bg) + 0.05)
        return max(a, b) / min(a, b)
    }
    /// Composite a translucent color over an opaque backdrop (source-over).
    func over(_ top: Color, _ bottom: (r: Double, g: Double, b: Double, a: Double))
        -> (r: Double, g: Double, b: Double, a: Double) {
        let t = srgba(top)
        return (t.r * t.a + bottom.r * (1 - t.a),
                t.g * t.a + bottom.g * (1 - t.a),
                t.b * t.a + bottom.b * (1 - t.a), 1)
    }
    let white: (r: Double, g: Double, b: Double, a: Double) = (1, 1, 1, 1)
    let canvas = srgba(Theme.bg)
    // Worst real stack: a raised card over the translucent panel with the
    // canvas showing through — darker backdrop than pure white, lower ratio.
    let raisedOnCanvas = over(Theme.surfaceRaised, canvas)
    // NOTE: these are the two statically checkable backdrops. The live glass
    // panel is a blur over arbitrary desktop content, so its contrast is only
    // bounded when reduce-transparency forces it opaque — the white case here.
    check("textDim clears 4.5:1 on opaque white (reduce-transparency panel)",
          contrast(Theme.textDim, on: white) >= 4.5)
    check("textDim clears 4.5:1 on a raised card over the canvas",
          contrast(Theme.textDim, on: raisedOnCanvas) >= 4.5)
    check("text clears 4.5:1 on a raised card over the canvas",
          contrast(Theme.text, on: raisedOnCanvas) >= 4.5)
    check("engage (non-text) clears 3:1 on a raised card over the canvas",
          contrast(Theme.engage, on: raisedOnCanvas) >= 3.0)
    // textDim IS the floor: any extra .opacity() on top drops caption text
    // back under 4.5:1, so both single-line shapes are banned — thinning the
    // color (`textDim.opacity(…)`) and thinning an inline chain
    // (`…(Theme.textDim).opacity(…)`). engage may never color a Text at all
    // (it is a non-text tone, ~3.7:1 on a raised card). Decorative
    // (accessibilityHidden) views that want a fainter look put `.opacity(…)`
    // on the view, on its own line. Line-level grep: a multi-line chain or a
    // container-inherited style still slips through — the render-preview pass
    // is the backstop for those.
    func lineOffenders(_ isOffense: (Substring) -> Bool) -> [String] {
        swiftFiles.filter { url in
            guard url.lastPathComponent != "SelfCheck.swift",
                  let text = try? String(contentsOf: url, encoding: .utf8) else { return false }
            return text.split(separator: "\n").contains(where: isOffense)
        }.map(\.lastPathComponent)
    }
    let dimmedTextOffenders = lineOffenders {
        $0.contains("textDim.opacity") || $0.contains("textDim).opacity")
    }
    check("nothing thins textDim below the AA floor", dimmedTextOffenders.isEmpty)
    if !dimmedTextOffenders.isEmpty {
        print("      offenders: \(dimmedTextOffenders.joined(separator: ", "))")
    }
    let engageTextOffenders = lineOffenders { $0.contains("Text(") && $0.contains("Theme.engage") }
    check("engage never colors text", engageTextOffenders.isEmpty)
    if !engageTextOffenders.isEmpty {
        print("      offenders: \(engageTextOffenders.joined(separator: ", "))")
    }

    print(failures == 0 ? "\nALL CHECKS PASSED" : "\n\(failures) CHECK(S) FAILED")
    return failures == 0
}
