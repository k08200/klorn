import Foundation

// Self-check for Mac banners (2026-11-07), run by `KlornMac --self-check`.
//
// 1. MEETING-lane mail gets a banner. The server rings PUSH and MEETING mail
//    alike on web, mobile and Windows (packages/api judge/email-firewall.ts
//    `ringForFirewallEmail`); the Mac announced PUSH only, so a meeting invite
//    was silent here alone. Same ledger: dedupe, the 5-per-sync cap and the
//    silent first-sync baseline.
// 2. Banners follow the server's notification gate. Quiet hours and category
//    opt-outs are evaluated on the server (notify/notification-prefs.ts) and
//    read from GET /api/notifications/alert-state right before a banner posts.
//    A held banner is dropped, as Web Push drops it (the mail stays in its
//    lane); a failed check posts anyway (fail-open: a missed urgent mail is the
//    worse failure).
//
// Network is the session stub (URLProtocol); nothing here posts a real banner.

@MainActor
func meetingMailBannerSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ cond: Bool) { results.append((name, cond)) }

    typealias Stub = SessionStubProtocol
    typealias S = SessionScenarios
    let alertState = "GET /api/notifications/alert-state"

    func itemJSON(_ id: String, tier: String) -> String {
        #"{"id":"\#(id)","source":"email","sourceId":"\#(id)","type":"email","title":"t","tier":"\#(tier)","priority":9,"surfacedAt":"2026-11-07T08:00:00Z","email":{"emailDbId":"d-\#(id)","subject":"s-\#(id)","from":"Sender <s@a.example>"},"hashStale":false}"#
    }
    func lanes(push: [String], meeting: [String] = [], queue: [String] = []) -> String {
        let p = push.map { itemJSON($0, tier: "PUSH") }.joined(separator: ",")
        let m = meeting.map { itemJSON($0, tier: "MEETING") }.joined(separator: ",")
        let q = queue.map { itemJSON($0, tier: "QUEUE") }.joined(separator: ",")
        let total = push.count + meeting.count + queue.count
        return #"{"tiers":{"PUSH":[\#(p)],"MEETING":[\#(m)],"QUEUE":[\#(q)],"INFO":[],"SILENT":[]},"summary":{"PUSH":\#(push.count),"MEETING":\#(meeting.count),"QUEUE":\#(queue.count),"INFO":0,"SILENT":0,"AUTO":0,"total":\#(total)}}"#
    }
    func gate(push: Bool, meeting: Bool, reason: String = "quiet_hours") -> Stub.Reply {
        func one(_ allowed: Bool) -> String {
            allowed ? #"{"allowed":true}"# : #"{"allowed":false,"reason":"\#(reason)"}"#
        }
        return .init(body: #"{"alerts":{"push":\#(one(push)),"meeting":\#(one(meeting))}}"#)
    }

    // MARK: MEETING-lane mail, through the model's own load path
    do {
        let live = S.model([S.firewall: .init(body: lanes(push: ["p1"], meeting: ["m1"])),
                            alertState: gate(push: true, meeting: true)])
        var announced: [[String]] = []
        live.onNewPush = { announced.append($0.map(\.id)) }
        await live.loadQueue()
        let baselineQuiet = announced.isEmpty
        Stub.set(S.firewall, .init(body: lanes(push: ["p1"], meeting: ["m1", "m2"], queue: ["q1"])))
        await live.loadQueue()
        await live.loadQueue()
        check("first sync is silent for both lanes; then a new MEETING mail is announced once",
              baselineQuiet && announced == [["m2"]])
        Stub.set(S.firewall, .init(body: lanes(push: ["p1", "p2"], meeting: ["m1", "m2", "m3"])))
        await live.loadQueue()
        check("PUSH and MEETING arriving together share one announcement, PUSH first",
              announced.last == ["p2", "m3"])
        Stub.set(S.firewall, .init(body: lanes(push: ["p1"], meeting: ["m1", "m2", "m3", "p2"])))
        await live.loadQueue()
        check("a mail moved from PUSH to MEETING is not announced again", announced.count == 2)
        live.signOut()
    }

    // MARK: the server's gate (quiet hours, category opt-outs)
    do {
        let quiet = S.model([S.firewall: .init(body: lanes(push: ["p1"])),
                             alertState: gate(push: false, meeting: false)])
        var announced: [[String]] = []
        quiet.onNewPush = { announced.append($0.map(\.id)) }
        await quiet.loadQueue()
        let gateCallsAtBaseline = Stub.calls(alertState).count
        Stub.set(S.firewall, .init(body: lanes(push: ["p1", "p2"], meeting: ["m1"])))
        await quiet.loadQueue()
        let heldDuringQuiet = announced.isEmpty
        let askedWhenDue = Stub.calls(alertState).count == 1
        // The window ends: nothing held comes back as a burst.
        Stub.set(alertState, gate(push: true, meeting: true))
        await quiet.loadQueue()
        let noBurst = announced.isEmpty
        Stub.set(S.firewall, .init(body: lanes(push: ["p1", "p2", "p3"], meeting: ["m1"])))
        await quiet.loadQueue()
        check("no alert-state read while nothing is due (the silent baseline)", gateCallsAtBaseline == 0)
        check("inside quiet hours a new PUSH or MEETING mail posts no banner", heldDuringQuiet && askedWhenDue)
        check("a held banner is dropped, not posted when the window ends (as Web Push drops it)",
              noBurst && announced == [["p3"]])
        quiet.signOut()
    }
    do {
        let failing = S.model([S.firewall: .init(body: lanes(push: ["p1"])),
                               alertState: .init(status: 500, body: #"{"error":"x"}"#)])
        var announced: [[String]] = []
        failing.onNewPush = { announced.append($0.map(\.id)) }
        await failing.loadQueue()
        Stub.set(S.firewall, .init(body: lanes(push: ["p1", "p2"])))
        await failing.loadQueue()
        Stub.set(alertState, .init(cancelled: true))
        Stub.set(S.firewall, .init(body: lanes(push: ["p1", "p2"], meeting: ["m1"])))
        await failing.loadQueue()
        check("fail-open: a server error or no answer from alert-state still posts the banner",
              announced == [["p2"], ["m1"]] && Stub.calls(alertState).count == 2)
        failing.signOut()
    }

    // MARK: the ledger, pure — dedupe, cap and baselines across both lanes
    func item(_ id: String, _ tier: String) -> FirewallItem {
        try! JSONDecoder().decode(FirewallItem.self, from: Data(itemJSON(id, tier: tier).utf8))
    }
    func push(_ id: String) -> FirewallItem { item(id, "PUSH") }
    func meeting(_ id: String) -> FirewallItem { item(id, "MEETING") }
    let settled = PushLedger.fresh(owner: "u1").plan(pushItems: [push("a")], meetingItems: [meeting("b")]).next
    check("a fresh account's first sync is a silent baseline for MEETING mail too",
          PushLedger.fresh(owner: "u1").plan(pushItems: [push("a")], meetingItems: [meeting("b")]).toNotify.isEmpty
          && settled.notified == ["a", "b"] && settled.meetingBaselineEstablished == true)
    check("a mail in both lanes at once is announced once",
          settled.plan(pushItems: [push("x")], meetingItems: [meeting("x")]).toNotify.map(\.id) == ["x"])
    let both = settled.plan(pushItems: (1...4).map { push("p\($0)") },
                            meetingItems: (1...4).map { meeting("m\($0)") })
    check("PUSH and MEETING share the \(PushLedger.maxBannersPerSync)-per-sync cap, PUSH first; the rest are recorded",
          both.toNotify.map(\.id) == ["p1", "p2", "p3", "p4", "m1"]
          && ["p4", "m4"].allSatisfy { both.next.notified.contains($0) })
    // A ledger saved by a build that bannered PUSH only: its baseline covers
    // PUSH, so the MEETING lane already sitting there must not burst on update.
    let legacy = try! JSONDecoder().decode(
        PushLedger.self, from: Data(#"{"owner":"u1","baselineEstablished":true,"notified":["a"]}"#.utf8))
    let upgrade = legacy.plan(pushItems: [push("a"), push("b")], meetingItems: [meeting("m1"), meeting("m2")])
    check("after the update, the MEETING lane already there is a silent baseline; new PUSH still announced",
          legacy.meetingBaselineEstablished == nil
          && upgrade.toNotify.map(\.id) == ["b"]
          && upgrade.next.notified.contains("m2") && upgrade.next.meetingBaselineEstablished == true
          && upgrade.next.plan(pushItems: [], meetingItems: [meeting("m1"), meeting("m3")]).toNotify.map(\.id) == ["m3"])
    let banners = try! JSONDecoder().decode(
        FirewallResponse.self, from: Data(lanes(push: ["p1"], meeting: ["m1"], queue: ["q1"]).utf8))
    check("banner mail is the PUSH and MEETING lanes only",
          BannerMail.from(banners) == BannerMail(push: [push("p1")], meeting: [meeting("m1")])
          && BannerMail.from(banners).isEmpty == false
          && BannerMail(push: [], meeting: []).isEmpty)

    // MARK: what a MEETING-mail banner says
    let meetingMailBanner = PushBanner.make(for: meeting("m9"))
    check("a MEETING-mail banner names its lane; a PUSH banner is unchanged",
          meetingMailBanner.subtitle == Tier.meeting.label
          && meetingMailBanner.title == "Sender" && meetingMailBanner.body == "s-m9"
          && PushBanner.make(for: push("p9")).subtitle == nil)
    check("tapping a MEETING-mail banner opens that mail, like PUSH",
          meetingMailBanner.identifier == PushNotifier.notificationIdentifier(for: "m9")
          && PushNotifier.tapAction(identifier: meetingMailBanner.identifier, isKnownItem: { $0 == "m9" })
              == .open(itemID: "m9"))
    check("SystemPushNotifier shows the lane line only when there is one",
          bannerSourceText(sourceDir, "Notifications.swift").contains("if let subtitle = banner.subtitle { content.subtitle = subtitle }"))
    check("VoiceOver names each lane with its own count",
          PushAlerter.announcement(for: [push("a"), meeting("b"), meeting("c")])
              == L("push.announce", 1) + " " + L("push.announce.meeting", 2)
          && PushAlerter.announcement(for: [push("a"), push("b")]) == L("push.announce", 2)
          && PushAlerter.announcement(for: [meeting("b")]) == L("push.announce.meeting", 1)
          && !L("push.announce.meeting", 3).contains("%") && L("push.announce.meeting", 3).contains("3"))
    check("the new and changed strings exist in every locale",
          ["en", "ko", "de", "es", "fr", "ja", "zh"].allSatisfy { locale in
              let strings = bannerSourceText(sourceDir, "Resources/\(locale).lproj/Localizable.strings")
              return strings.contains("\"push.announce.meeting\" = ")
                  && ["prefs.banners.detail", "auto.notify.emailUrgent.detail"].allSatisfy { key in
                      strings.split(separator: "\n").first { $0.hasPrefix("\"\(key)\" = ") }?.contains("MEETING") == true
                  }
          })

    // MARK: the server's verdict, pure
    func wire(_ json: String) -> AlertStateWire? {
        try? JSONDecoder().decode(AlertStateWire.self, from: Data(json.utf8))
    }
    let quietWire = wire(#"{"alerts":{"push":{"allowed":false,"reason":"quiet_hours"},"meeting":{"allowed":true}}}"#)
    check("alert-state decodes, reason included",
          quietWire?.alerts?.push?.allowed == false && quietWire?.alerts?.push?.reason == "quiet_hours")
    check("mail banners follow the server's push verdict; meeting-soon banners its meeting verdict",
          !ServerAlertGate.allows(.emailUrgent, state: quietWire)
          && ServerAlertGate.allows(.meeting, state: quietWire))
    check("fail-open: no answer, or an older server without the field, posts",
          ServerAlertGate.allows(.emailUrgent, state: nil)
          && ServerAlertGate.allows(.meeting, state: wire("{}"))
          && ServerAlertGate.allows(.emailUrgent, state: wire(#"{"alerts":{}}"#)))

    // MARK: meeting-soon banners (calendar) — same server gate
    let soonNow = ISO8601DateFormatter().date(from: "2026-11-07T09:02:00Z")!
    let standup = CalendarEventWire(
        id: "ev-1",
        title: "Standup", startTime: "2026-11-07T09:10:00Z", endTime: "2026-11-07T09:30:00Z",
        location: nil, meetingLink: nil, allDay: false)
    do {
        let calm = S.model([alertState: gate(push: true, meeting: true)])
        var shown: [String] = []
        calm.onMeetingSoon = { shown.append($0.id); return true }
        await calm.announceMeetingSoon(upcoming: [], now: soonNow, session: calm.sessionGeneration)
        let noCallWhenNothingDue = Stub.calls(alertState).isEmpty
        await calm.announceMeetingSoon(upcoming: [standup], now: soonNow, session: calm.sessionGeneration)
        await calm.announceMeetingSoon(upcoming: [standup], now: soonNow, session: calm.sessionGeneration)
        check("a meeting-soon banner is posted once when the server allows it, asked only when one is due",
              shown == ["ev-1"] && noCallWhenNothingDue && Stub.calls(alertState).count == 1)
        calm.signOut()
    }
    do {
        let quiet = S.model([alertState: gate(push: true, meeting: false)])
        var shown: [String] = []
        quiet.onMeetingSoon = { shown.append($0.id); return true }
        await quiet.announceMeetingSoon(upcoming: [standup], now: soonNow, session: quiet.sessionGeneration)
        let held = shown.isEmpty
        Stub.set(alertState, gate(push: true, meeting: true))
        await quiet.announceMeetingSoon(upcoming: [standup], now: soonNow, session: quiet.sessionGeneration)
        check("inside quiet hours a meeting-soon banner is not posted, and is dropped",
              held && shown.isEmpty && quiet.meetingAlertStore.load()?.notified == ["ev-1"])
        quiet.signOut()
    }
    do {
        let down = S.model([alertState: .init(status: 503, body: "{}")])
        var shown: [String] = []
        down.onMeetingSoon = { shown.append($0.id); return true }
        await down.announceMeetingSoon(upcoming: [standup], now: soonNow, session: down.sessionGeneration)
        check("fail-open: a meeting-soon banner posts when alert-state fails", shown == ["ev-1"])
        down.signOut()
    }
    do {
        let unwired = S.model([alertState: gate(push: true, meeting: true)])
        await unwired.announceMeetingSoon(upcoming: [standup], now: soonNow, session: unwired.sessionGeneration)
        let ended = S.model([alertState: gate(push: true, meeting: true)])
        var shown: [String] = []
        ended.onMeetingSoon = { shown.append($0.id); return true }
        await ended.announceMeetingSoon(upcoming: [standup], now: soonNow, session: ended.sessionGeneration - 1)
        check("an unhandled or ended-session meeting is not recorded (offered again)",
              unwired.meetingAlertStore.load() == nil && shown.isEmpty && ended.meetingAlertStore.load() == nil)
        unwired.signOut()
        ended.signOut()
    }
    check("the Today refresh routes the meeting-soon banner through that gate",
          bannerSourceText(sourceDir, "AppModel.swift").contains(
              "await announceMeetingSoon(upcoming: today?.upcoming, now: Date(), session: session)"))

    return results
}

private func bannerSourceText(_ sourceDir: URL, _ file: String) -> String {
    (try? String(contentsOf: sourceDir.appendingPathComponent(file), encoding: .utf8)) ?? ""
}
