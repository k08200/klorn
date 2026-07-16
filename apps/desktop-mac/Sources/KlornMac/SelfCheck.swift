import Foundation
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
          engDetail?.engagement?.replyCountLabel == "You engage with this sender · replied 5 times")
    check("engagement reply count (singular)",
          EmailDetail.Engagement(outboundCount: 1, learnedImportance: 0.25).replyCountLabel
              == "You engage with this sender · replied once")
    let saturated = EmailDetail.Engagement(outboundCount: 6, learnedImportance: 1.0)
    check("importance label: consistent", saturated.importanceLabel == "Consistently important to you")
    check("importance label: important",
          EmailDetail.Engagement(outboundCount: 2, learnedImportance: 0.5).importanceLabel == "Important to you")
    check("importance label: building",
          EmailDetail.Engagement(outboundCount: 1, learnedImportance: 0.25).importanceLabel == "Building importance")
    check("importance fill clamps high", EmailDetail.Engagement(outboundCount: 9, learnedImportance: 1.5).importanceFill == 1.0)
    let faded = EmailDetail.Engagement(outboundCount: 2, learnedImportance: 0.0)
    check("faded engagement hides meter", faded.importanceFill == 0.0 && !faded.showsImportance)
    check("faded a11y label omits importance", faded.accessibilityLabel == faded.replyCountLabel)
    check("engaged a11y label combines count + strength",
          saturated.accessibilityLabel == "You engage with this sender · replied 6 times. Consistently important to you")

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
        check("tone labels", opts.options.map(\.toneLabel) == ["Accept", "Decline", "Ask info"])
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

    print("Top bar open URL:")
    func item(href: String?) -> FirewallItem {
        FirewallItem(id: "x", source: "email", sourceId: "x", type: "email", title: "t",
                     tier: .push, tierReason: nil, priority: 0, surfacedAt: "",
                     email: nil, href: href, hashStale: nil)
    }
    let web = Config.webBaseURL
    check("absolute href opens verbatim",
          TopBarController.resolveURL(item(href: "https://x.test/mail/9"))?.absoluteString == "https://x.test/mail/9")
    check("root-relative href joins web base",
          TopBarController.resolveURL(item(href: "/mail/9"))?.absoluteString == web + "/mail/9")
    check("bare-relative href joins with slash",
          TopBarController.resolveURL(item(href: "mail/9"))?.absoluteString == web + "/mail/9")
    check("nil href falls back to inbox root",
          TopBarController.resolveURL(item(href: nil))?.absoluteString == web)
    check("no item falls back to inbox root",
          TopBarController.resolveURL(nil)?.absoluteString == web)

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
                         allDay: true, calendar: utc) == "All day")
    check("event time label — malformed ISO degrades",
          eventTimeLabel(startISO: "not-a-date", endISO: "also-no", allDay: false, calendar: utc) == "")

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

    print("Card snooze:")
    // The card's snooze menu offers the same four options as the reading pane
    // (one source of truth), each with a concrete future resurface time.
    check("snooze menu = all four options",
          PushCardSnooze.options.map(\.rawValue) == ["oneHour", "thisEvening", "tomorrow", "nextWeek"])
    check("snooze menu labels are human",
          PushCardSnooze.options.map(\.label) == ["In 1 hour", "This evening", "Tomorrow 9am", "Next week"])
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
          && readinessLabel("needs_review") == "Needs review"
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
          LoginItem.availability(hasBundleId: false) == .unavailable(reason: "Packaged app only"))

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
          StatusItemController.statusLine(signedIn: false, pushCount: 9) == "Klorn — not signed in")
    check("status line — clear inbox",
          StatusItemController.statusLine(signedIn: true, pushCount: 0) == "Klorn — no urgent mail")
    check("status line — push count",
          StatusItemController.statusLine(signedIn: true, pushCount: 3) == "Klorn — 3 PUSH waiting")
    // Exactly one anchor at a time: the pill OR the menu-bar icon, never both,
    // never neither — hiding the pill is what makes the icon appear.
    check("menu-bar icon appears when the pill is hidden",
          StatusItemController.shouldShow(pillVisible: false))
    check("menu-bar icon absent while the pill is visible",
          !StatusItemController.shouldShow(pillVisible: true))

    print(failures == 0 ? "\nALL CHECKS PASSED" : "\n\(failures) CHECK(S) FAILED")
    return failures == 0
}
