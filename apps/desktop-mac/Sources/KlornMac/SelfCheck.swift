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
    let ws = RealtimeClient.wsURL(token: "abc.def")
    let wantScheme = Config.apiBaseURL.hasPrefix("https") ? "wss" : "ws"
    check("ws url = scheme+/ws+desktop+token",
          ws?.scheme == wantScheme && ws?.path == "/ws"
          && ws?.query?.contains("type=desktop") == true
          && ws?.query?.contains("token=abc.def") == true)

    print("Accessibility:")
    check("reduce motion disables the panel morph",
          !TopBarController.shouldAnimateFrame(reduceMotion: true))
    check("normal motion keeps the panel morph",
          TopBarController.shouldAnimateFrame(reduceMotion: false))

    print("Settings:")
    check("notifications default ON when unset", AppSettings.resolveNotifications(nil))
    check("notifications honor stored false", !AppSettings.resolveNotifications(false))
    check("notifications honor stored true", AppSettings.resolveNotifications(true))
    check("notifications ignore non-bool", AppSettings.resolveNotifications("nope"))

    print(failures == 0 ? "\nALL CHECKS PASSED" : "\n\(failures) CHECK(S) FAILED")
    return failures == 0
}
