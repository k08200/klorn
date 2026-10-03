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
    // A pre-v2 row still filed under the retired AUTO key surfaces in QUEUE
    // (what the v2 flip backfilled AUTO to) — never as a sixth lane.
    let legacyFwJSON = """
    {"tiers":{"QUEUE":[],"AUTO":[{"id":"9","source":"email","sourceId":"e9","type":"email",
    "title":"Old","tier":"AUTO","priority":1,"surfacedAt":"2026-06-24T10:00:00Z"}]},
    "summary":{"PUSH":0,"QUEUE":0,"SILENT":0,"AUTO":1,"total":1}}
    """
    if let fw = try? JSONDecoder().decode(FirewallResponse.self, from: Data(legacyFwJSON.utf8)) {
        check("legacy AUTO list folds into QUEUE",
              fw.items(for: .queue).map(\.id) == ["9"] && fw.items(for: .queue).first?.tier == .queue
              && fw.tiers["AUTO"] == nil && fw.summary.count(for: .queue) == 1)
    } else {
        check("legacy AUTO list decodes", false)
    }
    // A stray AUTO count beside an EMPTY AUTO list: those rows (if any) are
    // already in QUEUE, so the count must not be added a second time.
    let strayAutoJSON = """
    {"tiers":{"QUEUE":[{"id":"9","source":"email","sourceId":"e9","type":"email",
    "title":"Old","tier":"QUEUE","priority":1,"surfacedAt":"2026-06-24T10:00:00Z"}],"AUTO":[]},
    "summary":{"PUSH":0,"QUEUE":1,"SILENT":0,"AUTO":1,"total":1}}
    """
    if let fw = try? JSONDecoder().decode(FirewallResponse.self, from: Data(strayAutoJSON.utf8)) {
        check("AUTO count with an empty AUTO list is not double-counted",
              fw.summary.count(for: .queue) == 1 && fw.items(for: .queue).count == 1)
    } else {
        check("stray AUTO count decodes", false)
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
    check("GitHub items get a source caption; mail items keep their sender line",
          sourceBadgeLabel("GITHUB") != nil && sourceBadgeLabel("GITHUB") != ""
          && sourceBadgeLabel("EMAIL") == nil && sourceBadgeLabel("PENDING_ACTION") == nil)
    check("full panel is user-resizable",
          TopBarController.styleMask(focusable: true).contains(.resizable))
    // The AppKit-level clamp is the last line of defense: whatever sets the
    // frame, the top edge stays reachable and the size fits the screen.
    let vis = NSRect(x: 0, y: 0, width: 1440, height: 875)
    check("clamp pulls a top-lodged frame back under the menu bar",
          KeyablePanel.clamped(NSRect(x: 100, y: 400, width: 800, height: 600), into: vis)
              == NSRect(x: 100, y: 275, width: 800, height: 600))
    check("clamp shrinks an oversized frame to the visible area",
          KeyablePanel.clamped(NSRect(x: 0, y: -100, width: 2000, height: 1200), into: vis)
              == NSRect(x: 0, y: 0, width: 1440, height: 875))
    check("clamp leaves a healthy frame untouched",
          KeyablePanel.clamped(NSRect(x: 100, y: 100, width: 800, height: 600), into: vis)
              == NSRect(x: 100, y: 100, width: 800, height: 600))
    check("a top-clipped frame counts as lost (unreachable grab area)",
          TopBarController.isFrameLost(
              frame: NSRect(x: 100, y: 500, width: 800, height: 600),
              visible: NSRect(x: 0, y: 0, width: 1440, height: 875))
          && !TopBarController.isFrameLost(
              frame: NSRect(x: 100, y: 100, width: 800, height: 600),
              visible: NSRect(x: 0, y: 0, width: 1440, height: 875))
          && TopBarController.isFrameLost(
              frame: NSRect(x: 5_000, y: 100, width: 800, height: 600),
              visible: NSRect(x: 0, y: 0, width: 1440, height: 875)))
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
    // Cmd+Tab needs a real managed window, not a floating utility overlay
    // (dogfood 2026-08-18: the full view was unswitchable while it was a
    // floating .canJoinAllSpaces panel).
    check("pill is the only utility overlay; expanded/full are real windows",
          TopBarController.isUtilityWindow(focusable: false)
          && !TopBarController.isUtilityWindow(focusable: true))
    check("pill panel stays fixed and non-activating",
          !TopBarController.styleMask(focusable: false).contains(.resizable)
          && TopBarController.styleMask(focusable: false).contains(.nonactivatingPanel))
    // Expanded joined the key-able/resizable family (Cmd+Tab needs a window
    // that can raise; 1140pt clipped narrow displays — 2026-08-15).
    check("expanded uses the full-family style, with its own smaller floor",
          TopBarController.minSize(for: .expanded) == TopBarMetrics.expandedMin
          && TopBarController.minSize(for: .full) == TopBarMetrics.fullMin
          && TopBarMetrics.expandedMin.width < TopBarMetrics.fullMin.width)
    check("expanded shrinks to fit a narrow display",
          {
              let s = TopBarMetrics.fittedSize(
                  ideal: TopBarMetrics.expanded, visible: NSSize(width: 1024, height: 640),
                  floor: TopBarMetrics.expandedMin)
              return s.width <= 1024 - TopBarMetrics.screenMargin * 2
          }())
    check("stored expanded size below its floor is lifted",
          AppSettings.resolveFullWindowSize(
              ["width": 100.0, "height": 100.0], floor: TopBarMetrics.expandedMin)
              == TopBarMetrics.expandedMin)
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
    // Linked calendar rows (step C7): a linked calendar's event is a read-only mirror
    // with a small source label; a row from an older server, without either field, still
    // decodes and stays editable.
    do {
        func wire(_ extra: String) -> CalendarEventWire? {
            let json = """
            {"id":"e","title":"Offsite","startTime":"2026-07-16T00:30:00.000Z",
            "endTime":"2026-07-16T01:00:00.000Z","location":null,"meetingLink":null,
            "allDay":false\(extra)}
            """
            return try? JSONDecoder().decode(CalendarEventWire.self, from: Data(json.utf8))
        }
        let plain = wire("")
        check("calendar wire — a row without readOnly/sourceLabel still decodes and is editable",
              plain?.title == "Offsite" && plain?.readOnly == nil && plain?.sourceLabel == nil
              && plain.map(calendarEventIsEditable) == true
              && plain.flatMap(calendarEventSourceLabel) == nil)
        let linked = wire(#","readOnly":true,"sourceLabel":"work@company.com""#)
        check("calendar wire — a linked row is read-only and labelled with the account email",
              linked?.readOnly == true && linked.map(calendarEventIsEditable) == false
              && linked.flatMap(calendarEventSourceLabel) == "work@company.com")
        check("calendar wire — a linked row with no (or a blank) email is labelled Linked",
              wire(#","readOnly":true"#).flatMap(calendarEventSourceLabel) == L("cal.source.linked")
              && wire(#","readOnly":true,"sourceLabel":"  ""#).flatMap(calendarEventSourceLabel)
                  == L("cal.source.linked"))
        check("calendar wire — readOnly false is editable and has no source label",
              wire(#","readOnly":false,"sourceLabel":"x@y.z""#).map(calendarEventIsEditable) == true
              && wire(#","readOnly":false,"sourceLabel":"x@y.z""#).flatMap(calendarEventSourceLabel) == nil)
        let summary = try? JSONDecoder().decode(
            TodaySummary.self,
            from: Data(#"{"total":1,"current":null,"upcoming":[{"id":"l","title":"Offsite","startTime":"2026-07-16T05:00:00.000Z","endTime":"2026-07-16T06:00:00.000Z","location":null,"meetingLink":null,"allDay":false,"readOnly":true,"sourceLabel":"work@company.com"}],"nextEvent":null}"#.utf8))
        check("calendar wire — the today summary carries the linked row's fields",
              summary?.upcoming.first?.readOnly == true
              && summary?.upcoming.first?.sourceLabel == "work@company.com")
        check("calendar wire — the source label exists in every shipped language",
              L10n.shipped.allSatisfy { code in
                  let keys = L10n.keys(forLanguage: code)
                  return keys.contains("cal.source.linked") && keys.contains("cal.source.a11y")
                      && keys.contains("cal.readOnly")
              })
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

    // Mail-row time (design pass 2026-08-25): three grains pinned in UTC/en_US
    // so the boundaries are the contract — same day flips to a date at
    // midnight, same year drops the year, and the grain decision comes from
    // the CALENDAR's day/year, never from a raw 24h subtraction.
    let mailNow = ISO8601DateFormatter().date(from: "2026-07-16T12:00:00Z")!
    let en = Locale(identifier: "en_US")
    check("mail time — today shows clock",
          mailTimeLabel(iso: "2026-07-16T05:04:00.000Z", now: mailNow, calendar: utc, locale: en)
          == "05:04")
    check("mail time — yesterday is a date even within 24h",
          mailTimeLabel(iso: "2026-07-15T23:30:00.000Z", now: mailNow, calendar: utc, locale: en)
          == "Jul 15")
    check("mail time — same year omits the year",
          mailTimeLabel(iso: "2026-01-02T08:00:00Z", now: mailNow, calendar: utc, locale: en)
          == "Jan 2")
    check("mail time — older year carries the year",
          mailTimeLabel(iso: "2025-12-31T08:00:00.000Z", now: mailNow, calendar: utc, locale: en)
          == "Dec 31, 2025")
    check("mail time — malformed/absent ISO degrades",
          mailTimeLabel(iso: "nope", now: mailNow, calendar: utc, locale: en) == ""
          && mailTimeLabel(iso: nil, now: mailNow, calendar: utc, locale: en) == "")

    // Row signals (mail-first shell 2026-08-26): the wire union decodes into
    // chips, unknown kinds decode to nil (a newer server must never blank an
    // older client), and the chronological inbox sorts newest-first with
    // receivedAt beating surfacedAt.

    // Calendar grid math (real calendar views 2026-08-26): whole weeks,
    // firstWeekday honored, local-day bucketing (the dayKey trap: a 01:00 KST
    // event belongs to its LOCAL day, not its UTC day).
    print("Calendar grid:")
    var sunFirst = Calendar(identifier: .gregorian)
    sunFirst.timeZone = TimeZone(identifier: "Asia/Seoul")!
    sunFirst.firstWeekday = 1  // Sunday
    let aug = monthGridDays(year: 2026, month: 8, calendar: sunFirst)
    // August 2026: the 1st is a Saturday, the 31st a Monday → Sun-first grid
    // runs Jul 26 … Sep 5, exactly 6 weeks.
    check("month grid — whole weeks, multiple of 7", aug.count == 42)
    check("month grid — starts on the week containing the 1st",
          localDayKey(aug.first ?? Date(), calendar: sunFirst) == "2026-07-26")
    check("month grid — ends on the week containing the 31st",
          localDayKey(aug.last ?? Date(), calendar: sunFirst) == "2026-09-05")
    var monFirst = sunFirst
    monFirst.firstWeekday = 2  // Monday (de/fr locales)
    let augMon = monthGridDays(year: 2026, month: 8, calendar: monFirst)
    check("month grid — honors firstWeekday",
          localDayKey(augMon.first ?? Date(), calendar: monFirst) == "2026-07-27"
          && augMon.count == 42)

    let kstEvent = CalendarEventWire(
        id: "e1", title: "Late sync", startTime: "2026-08-25T16:30:00.000Z",
        endTime: "2026-08-25T17:00:00.000Z", location: nil, meetingLink: nil, allDay: false)
    let buckets = eventsByDay([kstEvent,
        CalendarEventWire(id: "bad", title: "x", startTime: "not-a-date",
                          endTime: "also-no", location: nil, meetingLink: nil, allDay: false)],
        calendar: sunFirst)
    // 16:30Z on the 25th is 01:30 KST on the 26th — LOCAL day wins.
    check("events bucket on the local day, malformed dropped",
          buckets["2026-08-26"]?.map(\.id) == ["e1"] && buckets.count == 1)

    // Spanning (2026-09-10): an event shows on EVERY day it covers.
    func ev(_ id: String, _ start: String, _ end: String, allDay: Bool) -> CalendarEventWire {
        CalendarEventWire(id: id, title: id, startTime: start, endTime: end,
                          location: nil, meetingLink: nil, allDay: allDay)
    }
    // 01:30 KST on the 26th → 12:00 KST on the 27th: two local days.
    check("spanning — a timed event covers each local day",
          eventDayKeys(ev("s", "2026-08-25T16:30:00.000Z", "2026-08-27T03:00:00.000Z",
                          allDay: false), calendar: sunFirst)
              == ["2026-08-26", "2026-08-27"])
    // 15:00Z is exactly 00:00 KST on the 27th — the 27th is not covered.
    check("spanning — an end at local midnight adds no day",
          eventDayKeys(ev("m", "2026-08-26T05:00:00Z", "2026-08-26T15:00:00Z", allDay: false),
                       calendar: sunFirst) == ["2026-08-26"])
    // All-day rows are dates with an EXCLUSIVE end (Google) — read as dates,
    // so the KST reader's 09:00 local instant never adds a phantom day.
    check("spanning — all-day dates, exclusive end",
          eventDayKeys(ev("a", "2026-08-30T00:00:00Z", "2026-09-01T00:00:00Z", allDay: true),
                       calendar: sunFirst) == ["2026-08-30", "2026-08-31"])
    check("spanning — a one-day all-day event is one day",
          eventDayKeys(ev("o", "2026-07-24T00:00:00Z", "2026-07-25T00:00:00Z", allDay: true),
                       calendar: sunFirst) == ["2026-07-24"])
    check("spanning — capped at maxSpannedDays",
          eventDayKeys(ev("r", "2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z", allDay: true),
                       calendar: sunFirst).count == maxSpannedDays)
    check("spanning — malformed end keeps the start day",
          eventDayKeys(ev("x", "2026-08-26T05:00:00Z", "nope", allDay: false),
                       calendar: sunFirst) == ["2026-08-26"])
    check("spanning — buckets carry the event under both days",
          eventsByDay([ev("s", "2026-08-25T16:30:00.000Z", "2026-08-27T03:00:00.000Z",
                          allDay: false)], calendar: sunFirst).keys.sorted()
              == ["2026-08-26", "2026-08-27"])
    // Week view: seven days from the calendar's firstWeekday, around Aug 5.
    let aug5 = aug.count > 10 ? aug[10] : Date()
    let sunWeek = weekDays(containing: aug5, calendar: sunFirst)
    check("week — seven days from Sunday",
          sunWeek.count == 7
          && localDayKey(sunWeek[0], calendar: sunFirst) == "2026-08-02"
          && localDayKey(sunWeek[6], calendar: sunFirst) == "2026-08-08")
    check("week — Monday-first locales start on Monday",
          localDayKey(weekDays(containing: aug5, calendar: monFirst).first ?? Date(),
                      calendar: monFirst) == "2026-08-03")
    // Calendar editor (2026-09-11): the wire body a draft becomes, and the
    // draft an existing event opens as — all-day dates must round-trip
    // without gaining or losing a day across the UTC/local seam.
    do {
        let sept26 = ISO8601DateFormatter().date(from: "2026-08-26T01:00:00Z") ?? Date()  // 10:00 KST 26일
        let timed = calendarEventPayload(
            CalendarEventDraft(title: " Sync ", allDay: false, start: sept26,
                               end: sept26.addingTimeInterval(3600), location: " HQ "),
            calendar: sunFirst)
        check("event payload — timed: UTC instants, trimmed text",
              timed.startTime == "2026-08-26T01:00:00.000Z"
              && timed.endTime == "2026-08-26T02:00:00.000Z"
              && timed.title == "Sync" && timed.location == "HQ" && timed.allDay == false)
        let oneDay = calendarEventPayload(
            CalendarEventDraft(title: "Offsite", allDay: true, start: sept26, end: sept26, location: ""),
            calendar: sunFirst)
        check("event payload — all-day: local date, exclusive next-day end",
              oneDay.startTime == "2026-08-26T00:00:00.000Z"
              && oneDay.endTime == "2026-08-27T00:00:00.000Z" && oneDay.allDay)
        let twoDays = calendarEventPayload(
            CalendarEventDraft(title: "Offsite", allDay: true, start: sept26,
                               end: sept26.addingTimeInterval(86_400), location: ""),
            calendar: sunFirst)
        check("event payload — all-day: inclusive last day → exclusive end",
              twoDays.endTime == "2026-08-28T00:00:00.000Z")
        check("draft validity — title required, timed end after start",
              !calendarDraftIsValid(CalendarEventDraft(
                  title: " ", allDay: false, start: sept26, end: sept26.addingTimeInterval(60),
                  location: ""))
              && !calendarDraftIsValid(CalendarEventDraft(
                  title: "x", allDay: false, start: sept26, end: sept26, location: ""))
              && calendarDraftIsValid(CalendarEventDraft(
                  title: "x", allDay: true, start: sept26, end: sept26, location: "")))
        // The fixture's 오프사이트: 24T00Z … 25T00Z (all-day) opens as ONE day,
        // the 24th, in the editor — not the 25th, and not two days.
        let opened = calendarDraft(
            from: CalendarEventWire(
                id: "o", title: "오프사이트", startTime: "2026-07-24T00:00:00Z",
                endTime: "2026-07-25T00:00:00Z", location: nil, meetingLink: nil, allDay: true),
            calendar: sunFirst)
        check("draft from all-day event — exclusive end becomes the inclusive last day",
              opened.map { localDayKey($0.start, calendar: sunFirst) } == "2026-07-24"
              && opened.map { localDayKey($0.end, calendar: sunFirst) } == "2026-07-24"
              && opened?.allDay == true)
        check("draft from event — malformed time is nil, never a crash",
              calendarDraft(from: CalendarEventWire(
                  id: "b", title: "x", startTime: "nope", endTime: "nope", location: nil,
                  meetingLink: nil, allDay: false), calendar: sunFirst) == nil)
        let fresh = newCalendarDraft(on: sept26, now: sept26, calendar: sunFirst)
        check("new draft — next full hour, one hour long",
              sunFirst.component(.hour, from: fresh.start) == 11
              && fresh.end.timeIntervalSince(fresh.start) == 3600 && !fresh.allDay)
    }

    // Waiting on (2026-09-18): the wire decodes, and a row opens through the
    // live folder path as MY message on the right account.
    do {
        let resp = try? JSONDecoder().decode(
            WaitingOnResponse.self,
            from: Data(#"{"items":[{"gmailId":"g","threadId":"t","to":"Sarah <s@x.com>","subject":"S","sentAt":"2026-09-10T00:00:00.000Z","daysWaiting":8,"inbox":"li-1"}],"minDays":2}"#.utf8))
        let row = resp?.items.first?.asMailboxItem
        check("waiting on — decodes; row opens live on its account",
              resp?.minDays == 2 && resp?.items.first?.daysWaiting == 8
              && row?.gmailId == "g" && row?.inbox == "li-1" && row?.to == "Sarah <s@x.com>"
              && row?.receivedAt == "2026-09-10T00:00:00.000Z")
        check("waiting on — live mode flag covers folders and waiting-on only",
              ListMode.waitingOn.showsLiveMessages && ListMode.mailbox(.sent).showsLiveMessages
              && !ListMode.inbox.showsLiveMessages && !ListMode.calendar.showsLiveMessages)
    }

    check("day order — all-day first, then by start time",
          sortedForDay([
              ev("t2", "2026-08-26T08:00:00Z", "2026-08-26T09:00:00Z", allDay: false),
              ev("a", "2026-08-26T00:00:00Z", "2026-08-27T00:00:00Z", allDay: true),
              ev("t1", "2026-08-26T05:00:00Z", "2026-08-26T06:00:00Z", allDay: false),
          ]).map(\.id) == ["a", "t1", "t2"])
    // The chip's time label must not vanish on a plain (no-millis) ISO row —
    // fixtures and older clients write those, the API writes millis.
    check("event time label — plain ISO renders too",
          eventTimeLabel(startISO: "2026-08-26T05:00:00Z", endISO: "2026-08-26T06:30:00Z",
                         allDay: false, calendar: sunFirst) == "14:00–15:30"
          && eventTimeLabel(startISO: "2026-08-26T05:00:00.000Z",
                            endISO: "2026-08-26T06:30:00.000Z",
                            allDay: false, calendar: sunFirst) == "14:00–15:30")


    // Label categories (2026-08-27): the filter reads the SAME signal the
    // chip renders, so sidebar counts can never disagree with row labels.
    print("Label categories:")
    check("label — promotions matches only its category",
          LabelFilter.promotions.matches(.category("promotions"))
          && !LabelFilter.promotions.matches(.category("social"))
          && !LabelFilter.promotions.matches(.replied(3))
          && !LabelFilter.promotions.matches(nil))
    check("label — personal is Gmail's own definition (no category label)",
          LabelFilter.personal.matches(nil)
          && LabelFilter.personal.matches(.replied(6))
          && LabelFilter.personal.matches(.first)
          && !LabelFilter.personal.matches(.category("updates")))
    check("label — first contact is exact",
          LabelFilter.firstContact.matches(.first)
          && !LabelFilter.firstContact.matches(.replied(1))
          && !LabelFilter.firstContact.matches(nil))
    check("label — every category chip has a filter (gmail + judge families)",
          ["promotions", "social", "updates", "forums",
           "internal", "customer", "investor", "system"].allSatisfy { name in
              LabelFilter.allCases.contains { $0.matches(.category(name)) }
          })
    check("label — 회사 is the judge's internal verdict, and only that",
          LabelFilter.company.matches(.category("internal"))
          && !LabelFilter.company.matches(.category("social"))
          && !LabelFilter.company.matches(.replied(9)))
    check("label — a judge category is NOT 개인 (the claim excludes it)",
          !LabelFilter.personal.matches(.category("system")))
    // Reply axis (2026-09-14): its filter reads replyState, never the
    // relationship signal — and no other filter reads replyState.
    check("label — needsReply reads the reply axis only",
          LabelFilter.needsReply.matches(.category("customer"), replyState: "needsReply")
          && !LabelFilter.needsReply.matches(nil, replyState: "replied")
          && !LabelFilter.needsReply.matches(nil)
          && LabelFilter.customer.matches(.category("customer"), replyState: "needsReply"))
    do {
        let owed = try? JSONDecoder().decode(
            EmailContext.self,
            from: Data(#"{"emailDbId":"e","replyState":"needsReply"}"#.utf8))
        let older = try? JSONDecoder().decode(
            EmailContext.self, from: Data(#"{"emailDbId":"e"}"#.utf8))
        check("replyState — decoded when present, nil on an older server",
              owed?.replyState == "needsReply" && older?.replyState == nil)
        // Proactive drafts (2026-09-28): the row flag and the chip wording.
        let drafted = try? JSONDecoder().decode(
            EmailContext.self,
            from: Data(#"{"emailDbId":"e","replyState":"needsReply","draftReady":true}"#.utf8))
        check("draftReady — decoded when present, false on an older server",
              drafted?.draftReady == true && owed?.draftReady == false
              && older?.draftReady == false)
        check("reply chip — a waiting draft replaces 'needs reply', never 'answered'",
              ReplyStateChip.kind(state: "needsReply", draftReady: true) == .draftReady
              && ReplyStateChip.kind(state: "needsReply", draftReady: false) == .needsReply
              && ReplyStateChip.kind(state: "replied", draftReady: true) == .answered
              && ReplyStateChip.kind(state: "other", draftReady: true) == nil)
        func detail(_ json: String) -> EmailDetail? {
            try? JSONDecoder().decode(EmailDetail.self, from: Data(json.utf8))
        }
        check("prepared draft — trimmed when present, nil when blank or absent",
              detail(#"{"id":"e","proactiveDraft":"  3pm works.  "}"#)?.preparedDraft == "3pm works."
              && detail(#"{"id":"e","proactiveDraft":"   "}"#)?.preparedDraft == nil
              && detail(#"{"id":"e","proactiveDraft":null}"#)?.preparedDraft == nil
              && detail(#"{"id":"e"}"#) != nil
              && detail(#"{"id":"e"}"#)?.preparedDraft == nil)
    }

    print("Row signals + chronological inbox:")
    func ctx(_ json: String) -> EmailContext? {
        try? JSONDecoder().decode(EmailContext.self, from: Data(json.utf8))
    }
    check("signal — replied decodes",
          ctx(#"{"emailDbId":"x","signal":{"kind":"replied","count":6}}"#)?.signal
          == .replied(6))
    check("signal — category decodes",
          ctx(#"{"emailDbId":"x","signal":{"kind":"category","category":"promotions"}}"#)?
              .signal == .category("promotions"))
    check("signal — first decodes",
          ctx(#"{"emailDbId":"x","signal":{"kind":"first"}}"#)?.signal == .first)
    check("signal — unknown kind degrades to nil, row still decodes",
          {
              let c = ctx(#"{"emailDbId":"x","signal":{"kind":"astral"}}"#)
              return c != nil && c?.signal == nil
          }())
    check("signal — absent stays nil",
          ctx(#"{"emailDbId":"x"}"#)?.signal == nil)

    let chronoJSON = #"""
    {"tiers":{"PUSH":[
       {"id":"old","source":"email","sourceId":"e1","type":"email","title":"old",
        "tier":"PUSH","tierReason":null,"priority":5,"surfacedAt":"2026-08-20T00:00:00Z",
        "email":{"emailDbId":"d1","subject":null,"from":null,"snippet":null,
                 "receivedAt":"2026-08-20T09:00:00Z"}}],
      "SILENT":[
       {"id":"new","source":"email","sourceId":"e2","type":"email","title":"new",
        "tier":"SILENT","tierReason":null,"priority":1,
        "surfacedAt":"2026-08-26T00:00:00Z"}]},
     "summary":{"PUSH":1,"QUEUE":0,"SILENT":1,"AUTO":0,"total":2}}
    """#
    if let chrono = try? JSONDecoder().decode(FirewallResponse.self, from: Data(chronoJSON.utf8)) {
        // The SILENT row is NEWER (surfacedAt fallback) than the PUSH row's
        // receivedAt — chronology must beat lane loudness in the inbox.
        check("inbox — newest first across lanes, receivedAt/surfacedAt mixed",
              chrono.itemsByTime.map(\.id) == ["new", "old"])
    } else {
        check("inbox — chrono fixture decodes", false)
    }


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
        endTime: "2026-07-21T06:00:00.000Z", location: "Zoom", attendees: nil)
    check("draft label = title · time · location",
          eventDraftLabel(draft, calendar: utcCal) == "Sync with Sarah · 05:00–06:00 · Zoom")
    check("draft label omits missing location",
          eventDraftLabel(
              EventDraft(title: "T", startTime: "2026-07-21T05:00:00.000Z",
                         endTime: "2026-07-21T06:00:00.000Z", location: nil, attendees: nil),
              calendar: utcCal) == "T · 05:00–06:00")
    check("draft label survives malformed time",
          eventDraftLabel(
              EventDraft(title: "T", startTime: "not-a-date", endTime: "nope", location: nil, attendees: nil),
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

    print("Sections & mode:")
    check("today section height clamps junk and keeps sane values",
          AppSettings.resolveTodaySectionHeight("junk") == 240
          && AppSettings.resolveTodaySectionHeight(50.0) == 120
          && AppSettings.resolveTodaySectionHeight(9_999.0) == 520
          && AppSettings.resolveTodaySectionHeight(300.0) == 300)
    check("unknown attention mode decodes as BASIC (fail-closed)",
          AttentionMode(rawValue: "WEIRD") == nil
          && (AttentionMode(rawValue: "AUTO") ?? .basic) == .auto)

    print("Tier v2 lanes:")
    check("exactly five lanes; retired AUTO is not one of them",
          Tier.allCases == [.push, .meeting, .queue, .info, .silent]
          && Tier(rawValue: "AUTO") == nil)
    check("the five live lanes always show",
          Tier.visibleOrder(counts: { _ in 0 }) == [.push, .meeting, .queue, .info, .silent]
          && Tier.visibleOrder(counts: { _ in 1 }) == [.push, .meeting, .queue, .info, .silent])
    if let t = try? JSONDecoder().decode([Tier].self, from: Data(#"["AUTO","CALL"]"#.utf8)) {
        check("legacy AUTO/unknown lane strings decode as QUEUE", t == [.queue, .queue])
    } else {
        check("legacy AUTO/unknown lane strings decode as QUEUE", false)
    }
    // Two-level sidebar (founder 2026-08-20): action lanes primary, filed
    // lanes behind one disclosure — MEETING earns its row with items.
    check("sidebar defaults to PUSH/QUEUE primary; filed = INFO+SILENT",
          Tier.sidebarLanes(counts: { _ in 0 })
              == Tier.SidebarLanes(primary: [.push, .queue], filed: [.info, .silent], filedTotal: 0))
    check("MEETING becomes primary only while it holds items",
          Tier.sidebarLanes(counts: { $0 == .meeting ? 2 : 0 }).primary
              == [.push, .meeting, .queue])
    check("filed total sums its lanes",
          Tier.sidebarLanes(counts: { [.info: 4, .silent: 91][$0] ?? 0 })
              == Tier.SidebarLanes(
                  primary: [.push, .queue], filed: [.info, .silent], filedTotal: 95))
    check("section height resolvers clamp junk",
          AppSettings.resolveInboxSectionHeight("junk") == 620
          && AppSettings.resolveInboxSectionHeight(10.0) == 180
          && AppSettings.resolveUpcomingSectionHeight(9_999.0) == 600)
    check("guide teaches the five live lanes",
          Tier.coreOrder == [.push, .meeting, .queue, .info, .silent])
    // A v1 server's summary (no MEETING/INFO keys) must still decode.
    let v1Summary = """
    {"SILENT":1,"QUEUE":2,"PUSH":3,"AUTO":4,"total":10}
    """
    if let sum = try? JSONDecoder().decode(FirewallSummary.self, from: Data(v1Summary.utf8)) {
        check("v1 summary decodes; absent v2 lanes count zero",
              sum.count(for: .meeting) == 0 && sum.count(for: .info) == 0
              && sum.count(for: .push) == 3)
        check("a bare summary ignores the retired AUTO count", sum.count(for: .queue) == 2)
    } else {
        check("v1 summary decodes", false)
    }

    print("IMAP mailboxes:")
    // GET /api/naver-imap/status wire (routes/imap-connect.ts).
    let imapJSON = """
    {"connected":true,"email":"me@naver.com","host":"imap.naver.com:993",
    "accounts":[{"email":"me@naver.com","host":"imap.naver.com:993",
    "connectedAt":"2026-08-17T00:00:00.000Z","lastSyncedAt":null,"needsReconnect":false}]}
    """
    if let imap = try? JSONDecoder().decode(ImapStatusResponse.self, from: Data(imapJSON.utf8)) {
        let accounts = imap.resolvedAccounts(fallbackEmail: nil)
        check("imap status decodes its accounts", accounts.count == 1 && accounts[0].email == "me@naver.com")
        check("null lastSyncedAt is tolerated", accounts[0].lastSyncedAt == nil)
    } else {
        check("imap status decodes", false)
    }
    // An older server sent only {connected, email} — keep showing the mailbox.
    let legacyImap = ImapStatusResponse(connected: true, accounts: nil)
    check("legacy single-account shape still lists one mailbox",
          legacyImap.resolvedAccounts(fallbackEmail: "old@naver.com").count == 1)
    check("disconnected legacy shape lists nothing",
          ImapStatusResponse(connected: false, accounts: nil)
              .resolvedAccounts(fallbackEmail: "old@naver.com").isEmpty)
    check("provider labels are human, unknown falls back",
          providerLabel("GOOGLE") == "Gmail" && providerLabel("naver") == "Naver"
          && providerLabel(nil) == L("inbox.provider.generic")
          && providerLabel("WEIRD") == L("inbox.provider.generic"))
    // The connect form must not fire a request that the server will only
    // reject: blank/short password, or an address that smuggles a second one.
    check("connect form accepts a plain mailbox + app password",
          canSubmitImapConnect(email: "me@naver.com", password: "abcd1234"))
    check("connect form rejects blank/short password",
          !canSubmitImapConnect(email: "me@naver.com", password: "")
          && !canSubmitImapConnect(email: "me@naver.com", password: "ab"))
    check("connect form rejects a malformed or multi address",
          !canSubmitImapConnect(email: "menaver.com", password: "abcd1234")
          && !canSubmitImapConnect(email: "me@naver", password: "abcd1234")
          && !canSubmitImapConnect(email: "a@naver.com, b@evil.com", password: "abcd1234")
          && !canSubmitImapConnect(email: "", password: "abcd1234"))

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
        check("absent provider decodes as nil (older server)", two[0].provider == nil)
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
    // Folders: "all" is EXPLICIT (the server's folder default is the primary),
    // and the page token rides along verbatim.
    check("mailbox path — all is explicit",
          mailboxPath(box: .sent, selectedInbox: "all") == "/api/email/mailbox/sent?inbox=all")
    check("mailbox path — blank selection is all",
          mailboxPath(box: .drafts, selectedInbox: "") == "/api/email/mailbox/drafts?inbox=all")
    check("mailbox path — linked id + page token",
          mailboxPath(box: .archived, selectedInbox: "li-1", pageToken: "tok 2")
              == "/api/email/mailbox/archived?inbox=li-1&pageToken=tok%202")
    check("mailbox item query — row from an older server reads as primary",
          mailboxItemQuery(inbox: nil) == "?inbox=primary")
    check("mailbox item query — linked id (hyphen encoded)",
          mailboxItemQuery(inbox: "li-1") == "?inbox=li%2D1")
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

    print("Meeting links:")
    // meetingLink is invite data anyone can set. Only an absolute https URL with
    // a host and no userinfo is ever opened (mirror of web safeMeetingHref).
    check("https link → allowed",
          MeetingLink.safeURL("https://meet.google.com/abc")?.absoluteString
              == "https://meet.google.com/abc")
    check("upper-case scheme and host → allowed",
          MeetingLink.safeURL("HTTPS://Zoom.us/j/1")?.absoluteString.lowercased()
              == "https://zoom.us/j/1")
    check("zoom join link keeps its query",
          MeetingLink.safeURL("https://us02web.zoom.us/j/123?pwd=abc")?.absoluteString
              == "https://us02web.zoom.us/j/123?pwd=abc")
    let refusedLinks: [(String, String?)] = [
        ("http", "http://meet.google.com/abc"),
        ("javascript:", "javascript:alert(1)"),
        ("data:", "data:text/html,<script>alert(1)</script>"),
        ("file:", "file:///etc/passwd"),
        ("zoommtg:", "zoommtg://zoom.us/join?confno=1"),
        ("msteams:", "msteams://teams.microsoft.com/l/meetup-join/x"),
        ("ftp:", "ftp://example.com/x"),
        ("user:pass@", "https://user:pass@host/"),
        ("user@", "https://user@host/"),
        ("host look-alike userinfo", "https://meet.google.com@evil.example/abc"),
        ("nil", nil),
        ("empty", ""),
        ("leading whitespace", " https://x.example/"),
        ("trailing whitespace", "https://x.example/ "),
        ("leading tab", "\thttps://x.example/"),
        ("embedded newline", "https://x.exa\nmple/"),
        ("relative path", "/x"),
        ("scheme-relative", "//evil.example/x"),
        ("no scheme", "meet.google.com/abc"),
        ("https without a host", "https:evil.example"),
    ]
    for (label, raw) in refusedLinks {
        check("refused: \(label)", MeetingLink.safeURL(raw) == nil)
    }
    // IDNA is Foundation's and may differ across macOS releases: opening the
    // punycode https form or refusing are both safe; anything else is not.
    let idnLink = MeetingLink.safeURL("https://bücher.example/room")
    check("IDN host → punycode https or refused",
          idnLink == nil || idnLink?.absoluteString == "https://xn--bcher-kva.example/room")
    check("punycode host → allowed as-is",
          MeetingLink.safeURL("https://xn--bcher-kva.example/room")?.absoluteString
              == "https://xn--bcher-kva.example/room")

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
    // Restart is a support tool: hidden until Option turns Quit into it.
    // Restart is a support tool: listed only when the menu opens with Option
    // held. Pure flag check (the harness blocks the main thread, so it never
    // builds AppKit menus).
    check("Restart is listed only with Option held",
          MaintenanceDisclosure.isRevealGesture([.option])
          && MaintenanceDisclosure.isRevealGesture([.option, .command])
          && !MaintenanceDisclosure.isRevealGesture([])
          && !MaintenanceDisclosure.isRevealGesture([.command]))
    check("accessibility action reveals support tools",
          MaintenanceDisclosure.revealed == .init(expanded: true, supportTools: true))
    // Same rule in the sidebars: a plain click never shows Restart /
    // connection status; an Option-click does, and collapsing hides them.
    let closed = MaintenanceDisclosure.State(expanded: false, supportTools: false)
    let plain = MaintenanceDisclosure.toggled(closed, optionHeld: false)
    let revealed = MaintenanceDisclosure.toggled(closed, optionHeld: true)
    check("plain click opens App & support without support tools",
          plain == .init(expanded: true, supportTools: false))
    check("Option-click reveals support tools (also when already open)",
          revealed == .init(expanded: true, supportTools: true)
          && MaintenanceDisclosure.toggled(plain, optionHeld: true) == revealed)
    check("collapsing hides support tools again",
          MaintenanceDisclosure.toggled(revealed, optionHeld: false) == closed
          && MaintenanceDisclosure.toggled(revealed, optionHeld: true) == closed)

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
    // One per surface that has an account area: the expanded panel's account
    // column and the full sidebar (via actions), plus the Settings window's
    // Accounts tab, which has no TopBarActions and calls the model directly.
    // None in a header.
    let settingsSignOut = (try? String(
        contentsOf: sourceDir.appendingPathComponent("PreferencesView.swift"), encoding: .utf8))
        .map { $0.components(separatedBy: "model.signOut()").count - 1 } ?? 0
    check("sign-out is offered once per surface, not twice",
          signOutCallSites == 2 && settingsSignOut == 1)
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
        L("engagement.repliedTimes", 5), L("waiting.days", 3), L("waiting.hint", 2),
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
        L("mail.noMatches", "x", "y"), L("purpose.title.linked", "x"),
        L("label.correct.domain", "x"), L("label.correct.a11y", "x"),
    ].allSatisfy { $0.contains("x") && !$0.contains("%") })
    // Mixed string+integer formats: the argument ORDER must survive too, since
    // a "%1$@ %2$d" fed the wrong way round is the same pointer-read crash.
    check("mixed formats render", [
        L("tier.row.a11y", "x", 3, "y"), L("proposals.a11y", 2),
        L("waiting.row.a11y", "x", "y", 2),
    ].allSatisfy { !$0.contains("%") })

    // "Add account" → the purpose question for the NEW mailbox. Id-based
    // detection: a count would miss a concurrent unlink + link, and must
    // never pick the primary (id nil) or an account that was already there.
    do {
        func inbox(_ id: String?, _ kind: String) -> InboxOption {
            InboxOption(
                id: id, email: id.map { "\($0)@x.test" }, kind: kind, needsReconnect: false,
                provider: "GOOGLE", purpose: nil)
        }
        let before = [inbox(nil, "primary"), inbox("l1", "linked")]
        let baseline = Set(before.compactMap(\.id))
        check("link watch — nothing new yet",
              AppModel.newlyLinkedInbox(baseline: baseline, now: before) == nil)
        check("link watch — the new linked id is the target",
              AppModel.newlyLinkedInbox(
                baseline: baseline, now: before + [inbox("l2", "linked")])?.id == "l2")
        check("link watch — unlink + link (same count) still finds the new one",
              AppModel.newlyLinkedInbox(
                baseline: baseline, now: [inbox(nil, "primary"), inbox("l3", "linked")])?.id == "l3")
        check("link watch — primary is never 'new'",
              AppModel.newlyLinkedInbox(baseline: [], now: [inbox(nil, "primary")]) == nil)
    }

    // Company domains (2026-09-10): the connect-time question offers the
    // account's own domain — never a public provider — and the field splits
    // on what people type. The SERVER validates; these only shape the ask.
    check("company domain — suggested from the account's address",
          suggestedCompanyDomain(for: "yong@Acme.com") == "acme.com")
    check("company domain — public providers suggest nothing",
          suggestedCompanyDomain(for: "k0820086@gmail.com") == nil
          && suggestedCompanyDomain(for: "x@naver.com") == nil
          && suggestedCompanyDomain(for: nil) == nil
          && suggestedCompanyDomain(for: "not-an-address") == nil)
    // Sender labels (2026-09-11): the chip menu needs the bare address, and
    // the wire says when a chip is the user's own correction.
    check("mail address — bare address from a display-name From",
          mailAddress(in: "Sarah Kim <Sarah@Acme.com>") == "sarah@acme.com"
          && mailAddress(in: "bob@acme.io") == "bob@acme.io"
          && mailAddress(in: "no address here") == nil
          && mailAddress(in: nil) == nil)
    check("mail domain — of an address",
          mailDomain(of: "sarah@acme.com") == "acme.com" && mailDomain(of: "nope") == nil)
    do {
        let byUser = try? JSONDecoder().decode(
            EmailContext.self,
            from: Data(#"{"emailDbId":"e","signal":{"kind":"category","category":"customer","byUser":true}}"#.utf8))
        let derived = try? JSONDecoder().decode(
            EmailContext.self,
            from: Data(#"{"emailDbId":"e","signal":{"kind":"category","category":"customer"}}"#.utf8))
        check("signal byUser — decoded when present, false when absent",
              byUser?.signal == .category("customer") && byUser?.signalByUser == true
              && derived?.signalByUser == false)
    }
    check("company domains — input splits on commas, spaces, newlines",
          parseCompanyDomainsInput(" acme.com, acme.io\nsub.acme.co.kr  ")
              == ["acme.com", "acme.io", "sub.acme.co.kr"]
          && parseCompanyDomainsInput("").isEmpty)

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
    // fr/de shipped 2026-08-23; pt/it stand in for "unshipped" now.
    check("an unshipped language falls back to English",
          L10n.resolvedCode(override: .system, preferred: ["pt-BR", "it-IT"]) == "en")
    check("every shipped language is actually selectable",
          L10n.shipped.allSatisfy { code in
              L10n.resolvedCode(override: .system, preferred: ["\(code)-XX"]) == code
          })
    // A language in the picker with no catalogue would render raw keys.
    check("every shipped language has a catalogue",
          L10n.shipped.allSatisfy { !L10n.keys(forLanguage: $0).isEmpty })
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
    // The Theme colors are appearance-dynamic since dark mode — every block
    // must PIN the appearance it audits, or the verdict silently depends on
    // the OS of the machine running the check (caught 2026-08-15: a dark-OS
    // machine resolved the light block against dark values and failed it,
    // while light-OS CI passed).
    NSAppearance(named: .aqua)!.performAsCurrentDrawingAppearance {
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
    }

    // Dark appearance (2026-08-15): the same floors, resolved under darkAqua —
    // the dynamic Theme colors re-resolve inside this scope, so a future dark
    // palette tweak that drops below a floor fails here, not in dogfood.
    NSAppearance(named: .darkAqua)!.performAsCurrentDrawingAppearance {
        let darkCanvas = srgba(Theme.bg)
        let darkRaised = over(Theme.surfaceRaised, darkCanvas)
        let darkPanel = over(Theme.panel, darkCanvas)
        check("dark: textDim clears 4.5:1 on the panel over the canvas",
              contrast(Theme.textDim, on: darkPanel) >= 4.5)
        check("dark: textDim clears 4.5:1 on a raised card",
              contrast(Theme.textDim, on: darkRaised) >= 4.5)
        check("dark: text clears 4.5:1 on a raised card",
              contrast(Theme.text, on: darkRaised) >= 4.5)
        check("dark: engage (non-text) clears 3:1 on a raised card",
              contrast(Theme.engage, on: darkRaised) >= 3.0)
    }
    // Lane palette (FD-4, 2026-10-02): one palette with the web. Pure math on
    // Theme.laneComponents — no NSColor resolution — so the verdict never
    // depends on the running machine's appearance. Two guards: the five lane
    // colors stay pairwise distinct per appearance (the old ramp shipped INFO
    // and SILENT as near-identical slates), and each one clears the 4.5:1
    // text floor on the canvas, because `tint` colors text (LaneChip, errors).
    func rawContrast(_ a: Theme.RGBA, _ b: Theme.RGBA) -> Double {
        let (x, y) = (luminance(a) + 0.05, luminance(b) + 0.05)
        return max(x, y) / min(x, y)
    }
    let lanes = Tier.allCases
    for dark in [false, true] {
        let mode = dark ? "dark" : "light"
        let canvas = dark ? Theme.bgDark : Theme.bgLight
        let colors = lanes.map { Theme.laneComponents($0, dark: dark) }
        // Distinct = some channel differs by ≥ 0.15 (≈ 38/255). INFO vs SILENT
        // on the old ramp differed by at most 0.07 — that is the regression.
        var distinct = true
        for i in colors.indices {
            for j in colors.indices where j > i {
                let (a, b) = (colors[i], colors[j])
                if max(abs(a.r - b.r), abs(a.g - b.g), abs(a.b - b.b)) < 0.15 { distinct = false }
            }
        }
        check("\(mode): the five lane colors are pairwise distinct", distinct)
        for (tier, color) in zip(lanes, colors) {
            check("\(mode): \(tier.rawValue) lane ink clears 4.5:1 on the canvas",
                  rawContrast(color, canvas) >= 4.5)
        }
    }

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

    // Content-driven growth (a sidebar section handle making the SwiftUI tree
    // taller) resized the window UP off-screen without live-resize or move
    // events (clipping recording, 2026-08-19). Two walls, both source-pinned
    // here because the delegate needs a window and the harness has none:
    // sizingOptions=[] stops SwiftUI from driving the window frame at all,
    // and windowDidResize re-clamps whatever still resizes it.
    let hostSizingPinned = lineOffenders { $0.contains("host.sizingOptions = []") }
    check("SwiftUI content size never drives the window frame",
          hostSizingPinned.contains("TopBarController.swift"))
    let resizeHookPresent = lineOffenders { $0.contains("func windowDidResize") }
    check("windowDidResize re-clamp hook is wired",
          resizeHookPresent.contains("TopBarController.swift"))

    // Overflow must never eat the header: the root pins content to the TOP
    // (a centered NSHostingView/ZStack clipped the header first when the
    // sections' minimum exceeded the window — screenshots, 2026-08-20).
    let rootTopPinned = lineOffenders {
        $0.contains("maxHeight: .infinity, alignment: .top")
    }
    check("root content pins to the top (overflow clips at the bottom)",
          rootTopPinned.contains("TopBar.swift"))
    let sidebarScrolls = lineOffenders {
        $0.contains("minHeight: geo.size.height, alignment: .top")
    }
    check("sidebar scrolls instead of clipping when the window is short",
          sidebarScrolls.contains("TopBar.swift"))

    // Mail HTML is authored against a white page; the reading surface must
    // pin one regardless of app theme (dark mode ghost-text recording,
    // 2026-08-19) and must keep WebKit from auto-darkening the canvas.
    let mailWrap = EmailHtmlView.wrap("<p>hi</p>")
    check("mail surface pins a light card in every theme",
          mailWrap.contains("background: #ffffff")
          && mailWrap.contains("color-scheme: light"))

    print("Settings window (M0):")
    // Every section the old overlay showed lands in exactly one tab — a
    // regroup that drops one silently removes a setting from the app.
    let tabbed = SettingsTab.allCases.flatMap(\.sections)
    check("every Preferences section is in exactly one tab",
          tabbed.count == PrefsSection.allCases.count
          && Set(tabbed) == Set(PrefsSection.allCases))
    check("General is the first tab (macOS convention)",
          SettingsTab.allCases.first == .general)
    check("signed out hides only server-backed sections",
          SettingsTab.allCases.allSatisfy { tab in
              tab.visibleSections(signedIn: false) == tab.sections.filter { !$0.requiresSignIn }
              && tab.visibleSections(signedIn: true) == tab.sections
          })
    check("signed-out Assistant tab is empty (shows the sign-in note)",
          SettingsTab.assistant.visibleSections(signedIn: false).isEmpty)
    check("signed-out Accounts tab still shows sign-in status",
          SettingsTab.accounts.visibleSections(signedIn: false) == [.account])
    check("unknown persisted tab falls back to General",
          SettingsTab.restored("billing") == .general
          && SettingsTab.restored("privacy") == .privacy)
    check("every tab title is localized",
          SettingsTab.allCases.allSatisfy { $0.title != $0.titleKey && !$0.title.isEmpty })
    check("Settings window fits the smallest supported display",
          SettingsMetrics.height + SettingsMetrics.chromeHeight
              <= SettingsMetrics.smallestVisibleHeight)
    check("an open Settings window keeps the app in Cmd+Tab",
          TopBarController.activationPolicy(for: .collapsed, settingsOpen: true) == .regular)
    check("only a real close clears the Settings-open flag",
          !WindowPresenceEvent.willClose.openState(current: true)
          && WindowPresenceEvent.becameKey.openState(current: false)
          && WindowPresenceEvent.attached(visible: true).openState(current: false))
    check("hiding or covering Settings (⌘H) keeps it counted as open",
          WindowPresenceEvent.occlusionChanged(visible: false).openState(current: true)
          && WindowPresenceEvent.attached(visible: false).openState(current: true)
          && !WindowPresenceEvent.occlusionChanged(visible: false).openState(current: false))
    check("Settings tracking uses the real window, not a private id or a timer",
          lineOffenders { $0.contains("com_apple_SwiftUI_Settings_window") }.isEmpty
          && !lineOffenders { $0.contains(".onDisappear { model.settingsWindowOpen") }
              .contains("SettingsWindow.swift"))
    check("closing Settings returns the resting app to ambient",
          TopBarController.activationPolicy(for: .collapsed, settingsOpen: false) == .accessory)
    // Source pins: the overlay path is gone and the scene is real.
    check("Preferences is no longer an in-window overlay",
          lineOffenders { $0.contains("showPreferences") }.isEmpty
          && !lineOffenders { $0.contains("PreferencesView(") }.contains("TopBar.swift"))
    check("the Settings scene hosts SettingsRoot",
          lineOffenders { $0.contains("SettingsRoot().environment") }.contains("KlornApp.swift")
          && lineOffenders { $0.contains("Settings { EmptyView() }") }.isEmpty)

    print("App menus (M1):")
    let signedInFull = MenuState(
        signedIn: true, fullViewOpen: true, mailSurfaceIsKey: true, modalOpen: false, targetTier: .queue,
        emailLoaded: true, readerReplying: false, teamModeAvailable: false,
        listHasSearchField: true)
    var everyCommand: [MenuCommand] = [.compose, .find, .reply, .dismiss]
    everyCommand += Tier.allCases.map { MenuCommand.moveTo($0) }
    everyCommand += MenuRules.destinations.map { MenuCommand.go($0) }
    var loggedOut = signedInFull
    loggedOut.signedIn = false
    check("logged out disables every command",
          everyCommand.allSatisfy { !MenuRules.isEnabled($0, in: loggedOut) })
    var noSelection = signedInFull
    noSelection.targetTier = nil
    check("no selection disables message commands",
          [MenuCommand.reply, .dismiss, .moveTo(.push)]
              .allSatisfy { !MenuRules.isEnabled($0, in: noSelection) })
    check("no selection keeps compose, find and go live",
          [MenuCommand.compose, .find, .go(.inbox), .go(.calendar)]
              .allSatisfy { MenuRules.isEnabled($0, in: noSelection) })
    check("with a selection, reply / dismiss / other lanes are live",
          MenuRules.isEnabled(.reply, in: signedInFull)
          && MenuRules.isEnabled(.dismiss, in: signedInFull)
          && MenuRules.isEnabled(.moveTo(.push), in: signedInFull))
    check("moving to the current lane is disabled",
          !MenuRules.isEnabled(.moveTo(.queue), in: signedInFull))
    var composing = signedInFull
    composing.readerReplying = true
    check("reply is disabled while the inline composer is open",
          !MenuRules.isEnabled(.reply, in: composing))
    check("an open inline reply blocks everything that would unmount it",
          !MenuRules.isEnabled(.dismiss, in: composing)
          && Tier.allCases.allSatisfy { !MenuRules.isEnabled(.moveTo($0), in: composing) }
          && MenuRules.destinations.allSatisfy { !MenuRules.isEnabled(.go($0), in: composing) })
    check("compose and in-place Find stay live while replying",
          MenuRules.isEnabled(.compose, in: composing) && MenuRules.isEnabled(.find, in: composing))
    var composingElsewhere = composing
    composingElsewhere.listHasSearchField = false
    check("Find that would switch modes waits for the reply to close",
          !MenuRules.isEnabled(.find, in: composingElsewhere))
    var settingsKey = signedInFull
    settingsKey.mailSurfaceIsKey = false
    check("message commands are off while another window (Settings) is key",
          [MenuCommand.reply, .dismiss, .moveTo(.push)]
              .allSatisfy { !MenuRules.isEnabled($0, in: settingsKey) }
          && MenuRules.isEnabled(.go(.inbox), in: settingsKey))
    let request = ReplyRequest(token: 1, itemId: "a")
    check("menu Reply only lands on the item it was issued for",
          MenuRules.shouldStartReply(request, selectedItemId: "a", replying: false, emailLoaded: true)
          && !MenuRules.shouldStartReply(request, selectedItemId: "b", replying: false, emailLoaded: true)
          && !MenuRules.shouldStartReply(request, selectedItemId: nil, replying: false, emailLoaded: true)
          && !MenuRules.shouldStartReply(nil, selectedItemId: "a", replying: false, emailLoaded: true))
    check("menu Reply never overwrites a reply in progress or races the load",
          !MenuRules.shouldStartReply(request, selectedItemId: "a", replying: true, emailLoaded: true)
          && !MenuRules.shouldStartReply(request, selectedItemId: "a", replying: false, emailLoaded: false))
    check("⌘N has a single owner (the app menu)",
          lineOffenders { $0.contains(".keyboardShortcut(\"n\"") }.isEmpty)
    var loading = signedInFull
    loading.emailLoaded = false
    check("reply waits for the email to load",
          !MenuRules.isEnabled(.reply, in: loading))
    var collapsed = signedInFull
    collapsed.fullViewOpen = false
    check("message commands need the full view; navigation opens it",
          !MenuRules.isEnabled(.dismiss, in: collapsed)
          && MenuRules.isEnabled(.go(.inbox), in: collapsed)
          && MenuRules.isEnabled(.compose, in: collapsed))
    var modal = signedInFull
    modal.modalOpen = true
    check("a modal overlay disables every command",
          everyCommand.allSatisfy { !MenuRules.isEnabled($0, in: modal) })
    var teams = signedInFull
    check("Teams follows the server grant",
          !MenuRules.isEnabled(.go(.teams), in: teams)
          && { teams.teamModeAvailable = true; return MenuRules.isEnabled(.go(.teams), in: teams) }())
    let shortcuts = everyCommand.compactMap { MenuRules.shortcut(for: $0) }
    check("no two commands share a key equivalent",
          Set(shortcuts.map { "\($0.key.character)|\($0.modifiers.rawValue)" }).count == shortcuts.count)
    check("every key equivalent carries ⌘ or ⌃ (bare keys belong to text and quick replies)",
          shortcuts.allSatisfy { !$0.modifiers.intersection([.command, .control]).isEmpty })
    check("lane moves are ⌃⌘1–5 in lane order",
          Tier.allCases.enumerated().allSatisfy { index, tier in
              let sc = MenuRules.shortcut(for: .moveTo(tier))
              return sc?.key.character == Character("\(index + 1)")
                  && sc?.modifiers == [.control, .command]
          })
    check("Dismiss has no shortcut (⌘⌫ edits text in the reply field)",
          MenuRules.shortcut(for: .dismiss) == nil)
    check("Go destinations mirror the sidebar modes",
          Set(MenuRules.destinations).count == MenuRules.destinations.count
          && MenuRules.destinations.first == .inbox)
    check("every Go destination has a localized title",
          MenuRules.destinations.allSatisfy {
              let title = MenuRules.title(for: $0)
              return !title.isEmpty && !title.contains(".")
          })
    check("menu titles are localized",
          ["menu.message", "menu.go", "menu.compose", "menu.find", "menu.moveToLane"]
              .allSatisfy { L($0) != $0 })
    check("Find lands on a mode with the search field",
          ListMode.inbox.hasSearchField && !ListMode.calendar.hasSearchField)
    check("Go puts mail destinations on the mail sidebar level",
          ListMode.waitingOn.isMailFamily && ListMode.mailbox(.sent).isMailFamily
          && !ListMode.proposals.isMailFamily && !ListMode.calendar.isMailFamily)

    print("Main window (M2):")
    check("macMainWindow defaults OFF and reads only a stored Bool",
          !AppSettings.resolveMacMainWindow(nil)
          && AppSettings.resolveMacMainWindow(true)
          && !AppSettings.resolveMacMainWindow(false)
          && !AppSettings.resolveMacMainWindow("YES"))
    check("flag on: only the full state routes to the main window",
          TopBarController.routesToMainWindow(.full, macMainWindow: true)
          && !TopBarController.routesToMainWindow(.expanded, macMainWindow: true)
          && !TopBarController.routesToMainWindow(.collapsed, macMainWindow: true))
    check("flag off: nothing routes to the main window",
          [BarState.collapsed, .expanded, .full]
              .allSatisfy { !TopBarController.routesToMainWindow($0, macMainWindow: false) })
    check("an open main window makes the app regular (Dock + Cmd+Tab)",
          TopBarController.activationPolicy(for: .collapsed, mainWindowOpen: true) == .regular)
    check("closing the main window returns the resting app to ambient",
          TopBarController.activationPolicy(for: .collapsed, mainWindowOpen: false) == .accessory)
    check("closing the main window while Settings is open stays regular",
          TopBarController.activationPolicy(
              for: .collapsed, settingsOpen: true, mainWindowOpen: false) == .regular
          && TopBarController.activationPolicy(
              for: .collapsed, settingsOpen: false, mainWindowOpen: true) == .regular)
    check("main window closed: policy is exactly the pre-M2 rule",
          [BarState.collapsed, .expanded, .full].allSatisfy { state in
              [false, true].allSatisfy { dock in
                  [false, true].allSatisfy { settings in
                      TopBarController.activationPolicy(
                          for: state, showInDock: dock, settingsOpen: settings, mainWindowOpen: false)
                          == TopBarController.activationPolicy(
                              for: state, showInDock: dock, settingsOpen: settings)
                  }
              }
          })
    check("mail surface is key: bar only in its full state, main window only while open",
          MenuRules.mailSurfaceIsKey(
              barPanelIsKey: true, barFullOpen: true, mainWindowIsKey: false, mainWindowOpen: false)
          && MenuRules.mailSurfaceIsKey(
              barPanelIsKey: false, barFullOpen: false, mainWindowIsKey: true, mainWindowOpen: true)
          && !MenuRules.mailSurfaceIsKey(
              barPanelIsKey: true, barFullOpen: false, mainWindowIsKey: false, mainWindowOpen: false)
          && !MenuRules.mailSurfaceIsKey(
              barPanelIsKey: false, barFullOpen: false, mainWindowIsKey: true, mainWindowOpen: false)
          && !MenuRules.mailSurfaceIsKey(
              barPanelIsKey: false, barFullOpen: true, mainWindowIsKey: false, mainWindowOpen: true))
    var mainKey = signedInFull
    mainKey.mailSurfaceIsKey = MenuRules.mailSurfaceIsKey(
        barPanelIsKey: false, barFullOpen: false, mainWindowIsKey: true, mainWindowOpen: true)
    check("message commands work against a key main window",
          MenuRules.isEnabled(.reply, in: mainKey) && MenuRules.isEnabled(.dismiss, in: mainKey)
          && MenuRules.isEnabled(.moveTo(.push), in: mainKey))
    check("only a requested window survives, and only with the flag on",
          MainWindowRules.keepsAttachedWindow(macMainWindow: true, requested: true)
          && !MainWindowRules.keepsAttachedWindow(macMainWindow: true, requested: false)
          && !MainWindowRules.keepsAttachedWindow(macMainWindow: false, requested: true)
          && !MainWindowRules.keepsAttachedWindow(macMainWindow: false, requested: false))
    check("beta toggle: hidden until Option, visible while on",
          !MainWindowRules.showsBetaToggle(optionHeld: false, macMainWindow: false)
          && MainWindowRules.showsBetaToggle(optionHeld: true, macMainWindow: false)
          && MainWindowRules.showsBetaToggle(optionHeld: false, macMainWindow: true))
    let titleBarHeight: CGFloat = 28
    check("main window floor holds the full view and fits the smallest display",
          MainWindowRules.minSize == TopBarMetrics.fullMin
          && MainWindowRules.minSize.height + titleBarHeight <= SettingsMetrics.smallestVisibleHeight
          && MainWindowRules.defaultSize.width >= MainWindowRules.minSize.width
          && MainWindowRules.defaultSize.height >= MainWindowRules.minSize.height
          && MainWindowRules.defaultSize.width <= 1280
          && MainWindowRules.defaultSize.height + titleBarHeight <= SettingsMetrics.smallestVisibleHeight)
    check("main-window strings are localized",
          ["prefs.mainWindow", "prefs.mainWindow.detail"].allSatisfy { L($0) != $0 })
    let mainWindowSource = swiftFiles.first { $0.lastPathComponent == "MainWindow.swift" }
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    // The tracked part of the file: the root view and the opener, up to the
    // Settings toggle (whose key monitor legitimately uses view lifecycle).
    let trackedPart = mainWindowSource.components(separatedBy: "struct MainWindowBetaToggle").first ?? ""
    check("main window tracking uses the real NSWindow, never onAppear/onDisappear",
          trackedPart.contains("WindowPresenceTracker(")
          && !trackedPart.contains("onAppear") && !trackedPart.contains("onDisappear")
          && lineOffenders {
              ($0.contains("onAppear") || $0.contains("onDisappear")) && $0.contains("mainWindowOpen")
          }.isEmpty)
    check("the main window scene hosts the unchanged FullView and adds no menu item",
          trackedPart.contains("FullView(actions: actions)")
          && lineOffenders { $0.contains("Window(\"Klorn\", id: MainWindowRules.sceneID)") }
              .contains("KlornApp.swift")
          && lineOffenders { $0.contains(".commandsRemoved()") }.contains("KlornApp.swift"))
    let appSource = swiftFiles.first { $0.lastPathComponent == "KlornApp.swift" }
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    check("closing the main window never quits the app",
          appSource.contains("func applicationShouldTerminateAfterLastWindowClosed")
          && appSource.contains("-> Bool {\n        false\n    }"))
    check("the main window is the first scene (SwiftUI's launch pick is turned away, not Settings)",
          appSource.components(separatedBy: "KlornScenes.mainWindow(appDelegate)").count == 3
          && appSource.allRanges("KlornScenes.mainWindow(appDelegate)").allSatisfy { main in
              appSource[main.upperBound...].contains("KlornScenes.settings(appDelegate)")
          })
    check("BarState.full still exists until M8",
          lineOffenders { $0.contains("enum BarState { case collapsed, expanded, full }") }
              .contains("TopBar.swift"))

    print(failures == 0 ? "\nALL CHECKS PASSED" : "\n\(failures) CHECK(S) FAILED")
    return failures == 0
}

private extension String {
    /// Every range of `needle`, in order (self-check source pins).
    func allRanges(_ needle: String) -> [Range<String.Index>] {
        var out: [Range<String.Index>] = []
        var from = startIndex
        while let r = range(of: needle, range: from..<endIndex) {
            out.append(r)
            from = r.upperBound
        }
        return out
    }
}
