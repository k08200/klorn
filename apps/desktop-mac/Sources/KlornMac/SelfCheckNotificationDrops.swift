import Foundation

// Self-check for the Mac notification-drop fixes (2026-11-12), run by
// `KlornMac --self-check`. An audit of origin/main 8c119f25 found four ways a
// banner could go missing, ring when it should not, or a count stay wrong:
//
// 1. Overflow. Past 5 new mails in one sync the rest were recorded as seen
//    with no banner. Now the first 4 post on their own and ONE "+N more need
//    you" summary covers the rest; a tap opens Today, which lists them.
// 2. Permission. A launch at login never asked macOS, so a Mac that only ever
//    started Klorn at login never got banners. Now the first sync asks
//    whenever macOS has no answer yet (`.notDetermined`), whatever the launch
//    mode, and never once the user decided. The "Open at login" question
//    still waits for a window the user opened.
// 3. Fail-open. No answer from the server's alert gate within 4 s posted the
//    banner anyway, so it could ring during quiet hours. Now nothing rings
//    unverified: new PUSH mail is held and comes back the next pass the server
//    answers; new MEETING-lane mail is offered again on the next pass; a
//    meeting reminder is offered again on the next tick until the meeting
//    starts. The same holds while macOS's permission prompt is unanswered (a
//    banner posted then is refused and lost). A server without the endpoint
//    (404) gates nothing.
// 4. Dock badge. It counted Today's PUSH mail whether read or not. Now it
//    counts the unread ones: the server's flag, minus mail opened here.
//
// (5. Focus: a Time Sensitive banner needs a restricted entitlement and a
// Developer ID provisioning profile — founder steps in the README, no code.)
//
// Network is the session stub; nothing here posts a real banner, raises a
// real permission prompt or touches the Dock tile.

@MainActor
func notificationDropsSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ cond: Bool) { results.append((name, cond)) }
    func text(_ file: String) -> String {
        (try? String(contentsOf: sourceDir.appendingPathComponent(file), encoding: .utf8)) ?? ""
    }
    typealias Stub = SessionStubProtocol
    typealias S = SessionScenarios
    let alertState = "GET /api/notifications/alert-state"
    let t0 = ISO8601DateFormatter().date(from: "2026-11-08T00:00:00Z")!
    let cap = PushLedger.maxBannersPerSync

    /// "p7" arrived at 23:07 the night before `t0`: a higher number is newer.
    func arrivedAt(_ id: String) -> String {
        let minute = Int(id.drop { !$0.isNumber }) ?? 0
        return String(format: "2026-11-07T23:%02d:00Z", min(minute, 59))
    }
    func itemJSON(_ id: String, tier: String, unread: Bool? = nil) -> String {
        let flag = unread.map { #","unread":\#($0)"# } ?? ""
        return #"{"id":"\#(id)","source":"email","sourceId":"\#(id)","type":"email","title":"t","tier":"\#(tier)","priority":9,"surfacedAt":"\#(arrivedAt(id))","email":{"emailDbId":"d-\#(id)","subject":"s-\#(id)","from":"Name-\#(id) <\#(id)@a.example>"\#(flag)},"hashStale":false}"#
    }
    func lanes(push: [String], meeting: [String] = [], unread: [String: Bool] = [:], window: [String]? = nil) -> Stub.Reply {
        let p = push.map { itemJSON($0, tier: "PUSH", unread: unread[$0]) }.joined(separator: ",")
        let m = meeting.map { itemJSON($0, tier: "MEETING", unread: unread[$0]) }.joined(separator: ",")
        let todayPush = window.map { ids in
            #","todayPush":{"windowHours":72,"since":"2026-11-05T00:00:00Z","ids":[\#(ids.map { "\"\($0)\"" }.joined(separator: ","))]}"#
        } ?? ""
        return .init(body: #"{"tiers":{"PUSH":[\#(p)],"MEETING":[\#(m)],"QUEUE":[],"INFO":[],"SILENT":[]},"summary":{"PUSH":\#(push.count),"MEETING":\#(meeting.count),"QUEUE":0,"INFO":0,"SILENT":0,"AUTO":0,"total":\#(push.count + meeting.count)}\#(todayPush)}"#)
    }
    func gate(push: Bool, meeting: Bool = true, reason: String = "quiet_hours") -> Stub.Reply {
        func one(_ allowed: Bool) -> String {
            allowed ? #"{"allowed":true}"# : #"{"allowed":false,"reason":"\#(reason)"}"#
        }
        return .init(body: #"{"alerts":{"push":\#(one(push)),"meeting":\#(one(meeting))}}"#)
    }
    let serverError = Stub.Reply(status: 500, body: #"{"error":"x"}"#)
    func item(_ id: String, _ tier: String = "PUSH") -> FirewallItem {
        try! JSONDecoder().decode(FirewallItem.self, from: Data(itemJSON(id, tier: tier).utf8))
    }
    func wire(_ json: String) -> AlertStateWire? {
        try? JSONDecoder().decode(AlertStateWire.self, from: Data(json.utf8))
    }
    final class Recorder {
        var announced: [[String]] = []
        var held: [[String]] = []
        var closed: [[String]] = []
        var delayed: [[String]] = []
        var clock: Date
        init(_ clock: Date) { self.clock = clock }
        var anything: Bool { !(announced.isEmpty && held.isEmpty && closed.isEmpty && delayed.isEmpty) }
    }
    func wired(_ model: AppModel, _ rec: Recorder) {
        model.bannerClock = { rec.clock }
        model.onNewPush = { rec.announced.append($0.map(\.id)) }
        model.onHeldSummary = { rec.held.append($0.map(\.id)) }
        model.onClosedSummary = { rec.closed.append($0.map(\.id)) }
        model.onDelayedSummary = { rec.delayed.append($0.map(\.id)) }
    }
    func heldIDs(_ model: AppModel) -> [String] { model.pushLedgerStore.load()?.heldIDs ?? [] }

    // MARK: 1 — more than five at once: four banners and ONE "+N more" summary

    let eight = (1...8).map { item("p\($0)") }
    let split = BannerBatch.split(eight)
    check("past \(cap) new mails: the first \(cap - 1) post on their own, ONE summary takes the rest",
          split.each.map(\.id) == ["p1", "p2", "p3", "p4"] && split.more.map(\.id) == ["p5", "p6", "p7", "p8"])
    let five = BannerBatch.split(Array(eight.prefix(cap)))
    check("up to \(cap) new mails: each its own banner, no summary",
          five.each.count == cap && five.more.isEmpty && BannerBatch.split([]).each.isEmpty)
    let more = BannerBatch.moreSummary(for: split.more)
    check("the summary reads \"+N more need you\", names senders (no subject) and opens Today",
          more.title == L("push.moreSummary.title", 4) && more.title.contains("4") && !more.title.contains("%")
          && more.body == "Name-p5, Name-p6, Name-p7 +1" && !more.body.contains("s-p5")
          && more.identifier == PushNotifier.moreIdentifier(for: "p5")
          && PushNotifier.tapAction(identifier: more.identifier, isKnownItem: { _ in true }) == .openToday
          && PushNotifier.itemID(fromNotificationIdentifier: more.identifier) == nil)
    check("a MEETING mail past the cap is counted in the summary like PUSH",
          BannerBatch.split(eight.prefix(4) + [item("m9", "MEETING"), item("m10", "MEETING")]).more.map(\.id)
              == ["m9", "m10"])
    do {
        let model = AppModel(tokenStore: InMemoryTokenStore())
        let fake = FakePushNotifier()
        model.pushNotifier = fake
        var spoken: [String] = []
        let alerter = PushAlerter(model: model, announce: { spoken.append($0) })
        let wasEnabled = model.settings.notificationsEnabled
        model.settings.notificationsEnabled = true
        let posted = alerter.handleNewPush(eight)
        model.settings.notificationsEnabled = wasEnabled
        check("eight new mails post \(cap) banners: four mails, then the summary of the other four",
              posted == fake.posted && fake.posted.count == cap
              && fake.posted.prefix(4).map(\.identifier) == (1...4).map { PushNotifier.notificationIdentifier(for: "p\($0)") }
              && fake.posted.last == more)
        check("VoiceOver hears all eight, not only the ones with a banner", spoken == [L("push.announce", 8)])
    }
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: true)])
        wired(model, rec)
        await model.loadQueue()  // the silent baseline
        let burst = (2...9).map { "p\($0)" }
        Stub.set(S.firewall, lanes(push: ["p1"] + burst, meeting: ["m10"]))
        await model.loadQueue()
        check("a burst reaches the alerter whole: nothing past the cap is recorded without a banner",
              rec.announced == [burst + ["m10"]]
              && (burst + ["m10"]).allSatisfy { model.pushLedgerStore.load()?.notified.contains($0) == true })
        model.signOut()
    }

    // MARK: 2 — the permission request, whatever the launch mode

    check("the permission rule: signed in, not asked this session, and macOS has no answer yet",
          NotificationPermissionRules.shouldRequest(signedIn: true, alreadyRequested: false, status: .notDetermined)
          && !NotificationPermissionRules.shouldRequest(signedIn: true, alreadyRequested: false, status: .authorized)
          && !NotificationPermissionRules.shouldRequest(signedIn: true, alreadyRequested: false, status: .denied)
          && !NotificationPermissionRules.shouldRequest(signedIn: true, alreadyRequested: false, status: .unavailable)
          && !NotificationPermissionRules.shouldRequest(signedIn: false, alreadyRequested: false, status: .notDetermined)
          && !NotificationPermissionRules.shouldRequest(signedIn: true, alreadyRequested: true, status: .notDetermined))
    final class PromptState {
        var asked = false
    }
    func permissionModel(_ status: NotificationPermission, answer: NotificationPermission? = nil)
        -> (AppModel, FakePushNotifier, PromptState) {
        let model = S.model([S.firewall: lanes(push: ["p1"])])
        let fake = FakePushNotifier()
        fake.permissionAnswer = status
        fake.requestAnswer = answer
        model.pushNotifier = fake
        let state = PromptState()
        model.loginItemPrompt = LoginItemPromptEnvironment(
            asked: { state.asked }, markAsked: { state.asked = true },
            availability: { .available }, isEnabled: { false }, register: { nil })
        return (model, fake, state)
    }
    do {
        // A launch at login: no window the user opened, ever.
        let (model, fake, _) = permissionModel(.notDetermined, answer: .authorized)
        await model.loadQueue()
        let askedAtFirstSync = await S.waitUntil { fake.authorizationRequests == 1 }
            && model.notificationPermission == .authorized
        let sheetWhileUnseen = model.showLoginItemPrompt
        await model.loadQueue()
        await model.requestNotificationPermissionIfNeeded()
        check("a launch at login asks macOS at the first sync when it has no answer, once a session",
              askedAtFirstSync && fake.authorizationRequests == 1)
        // The user opens the window later: the question shows then, no second prompt.
        model.windowShownByUser = true
        await model.requestNotificationPermissionIfNeeded()
        check("the Open-at-login question still waits for a window the user opened",
              !sheetWhileUnseen && model.showLoginItemPrompt && fake.authorizationRequests == 1)
        model.signOut()
    }
    do {
        var neverAsked = true
        for decided in [NotificationPermission.denied, .authorized] {
            let (model, fake, _) = permissionModel(decided)
            await model.loadQueue()
            let read = await S.waitUntil { model.notificationPermission == decided }
            model.windowShownByUser = true
            await model.requestNotificationPermissionIfNeeded()
            await model.loadQueue()
            neverAsked = neverAsked && read && fake.authorizationRequests == 0
            model.signOut()
        }
        check("once the user decided (allowed or denied) Klorn never asks again", neverAsked)
    }
    check("the first sync is what asks: ensureActive, not only an activated window",
          text("AppModel.swift").contains("Task { await requestNotificationPermissionIfNeeded() }")
          && !text("Notifications.swift").contains("shownByUser"))

    // MARK: 3 — no answer from the gate: nothing rings unverified, nothing is lost

    check("no answer is unknown; a server answer without a gate for the kind (an older server) allows",
          ServerAlertGate.verdict(.emailUrgent, state: nil) == .unknown
          && ServerAlertGate.verdict(.meeting, state: nil) == .unknown
          && ServerAlertGate.verdict(.emailUrgent, state: wire("{}")) == .allowed
          && ServerAlertGate.verdict(.meeting, state: wire(#"{"alerts":{}}"#)) == .allowed
          && ServerAlertGate.verdict(.emailUrgent, state: AlertStateWire.noGate) == .allowed)
    let allowWire = wire(#"{"alerts":{"push":{"allowed":true},"meeting":{"allowed":true}}}"#)
    let quietWire = wire(#"{"alerts":{"push":{"allowed":false,"reason":"quiet_hours"}}}"#)
    check("while macOS has no answer an allowed banner waits; holds and no answer stay as they are",
          ServerAlertGate.verdict(.emailUrgent, state: allowWire, permission: .notDetermined) == .unknown
          && ServerAlertGate.verdict(.meeting, state: allowWire, permission: .notDetermined) == .unknown
          && ServerAlertGate.verdict(.emailUrgent, state: allowWire, permission: .authorized) == .allowed
          && ServerAlertGate.verdict(.emailUrgent, state: allowWire, permission: .unavailable) == .allowed
          && ServerAlertGate.verdict(.emailUrgent, state: quietWire, permission: .notDetermined) == .quietHours
          && ServerAlertGate.verdict(.emailUrgent, state: nil, permission: .authorized) == .unknown)
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: serverError])
        wired(model, rec)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"], meeting: ["m3"]))
        await model.loadQueue()
        let silent = !rec.anything
        let heldP2 = heldIDs(model) == ["p2"]
        let m3Unrecorded = model.pushLedgerStore.load()?.notified.contains("m3") == false
        Stub.set(alertState, gate(push: true))
        await model.loadQueue()  // the next poll, no five-minute wait
        check("no answer: nothing rings; the new PUSH mail is held, the MEETING mail left unrecorded",
              silent && heldP2 && m3Unrecorded)
        check("the next pass the server answers posts both at once: the held PUSH mail, then the MEETING mail",
              rec.announced == [["p2", "m3"]] && heldIDs(model).isEmpty && rec.delayed.isEmpty
              && model.pushLedgerStore.load()?.notified.contains("m3") == true)
        model.signOut()
    }
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: .init(cancelled: true)])
        wired(model, rec)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2", "p3"]))
        await model.loadQueue()
        let silent = !rec.anything
        Stub.set(alertState, gate(push: true))
        await model.loadQueue()
        check("two or more held without an answer: ONE \"N urgent emails need you\" summary, not \"quiet hours\"",
              silent && rec.delayed == [["p3", "p2"]] && rec.held.isEmpty && rec.announced.isEmpty)
        model.signOut()
    }
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: serverError])
        wired(model, rec)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2", "p3"]))
        await model.loadQueue()  // held, unconfirmed
        Stub.set(alertState, gate(push: false))
        await model.loadQueue()  // the server answers: quiet hours
        Stub.set(alertState, gate(push: true))
        rec.clock = t0.addingTimeInterval(HeldBanners.askAgainSeconds)
        await model.loadQueue()
        check("held without an answer, then quiet hours confirmed: the quiet-hours summary",
              rec.held == [["p3", "p2"]] && rec.delayed.isEmpty)
        model.signOut()
    }
    do {
        // A ledger a previous run left (p1 seen), then a launch with no answer.
        let first = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: true)])
        await first.loadQueue()
        let saved = first.pushLedgerStore.load()
        first.signOut()
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1", "p2", "p3"]), alertState: serverError],
                            pushLedgerStore: InMemoryPushLedgerStore(saved))
        wired(model, rec)
        await model.loadQueue()  // the first pass after launch
        let silent = !rec.anything && heldIDs(model) == ["p2", "p3"]
        Stub.set(alertState, gate(push: true))
        await model.loadQueue()
        check("no answer on the first pass after launch: the missed mail waits, then ONE \"while Klorn was closed\" summary",
              silent && rec.closed == [["p3", "p2"]] && rec.delayed.isEmpty && rec.announced.isEmpty)
        model.signOut()
    }
    do {
        // The permission prompt is on screen (or was ignored): macOS would refuse a banner.
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: true)])
        let fake = FakePushNotifier()
        fake.permissionAnswer = .notDetermined
        model.pushNotifier = fake
        wired(model, rec)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"], meeting: ["m3"]))
        await model.loadQueue()
        let waited = !rec.anything && heldIDs(model) == ["p2"]
            && model.pushLedgerStore.load()?.notified.contains("m3") == false
        fake.permissionAnswer = .authorized  // the user clicks Allow
        await model.loadQueue()
        check("while macOS's prompt is unanswered nothing is posted into the void; Allow brings it all back",
              waited && rec.announced == [["p2", "m3"]] && heldIDs(model).isEmpty)
        model.signOut()
    }
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: .init(status: 404, body: #"{"error":"not found"}"#)])
        wired(model, rec)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"]))
        await model.loadQueue()
        check("a server without the gate endpoint (404) gates nothing: the banner posts",
              rec.announced == [["p2"]] && heldIDs(model).isEmpty)
        model.signOut()
    }
    do {
        let rec = Recorder(t0)
        let hung = S.model([S.firewall: lanes(push: ["p1"])], hold: [alertState])
        hung.alertStateTimeout = 0.3
        wired(hung, rec)
        await hung.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"]))
        let started = Date()
        await hung.loadQueue()
        let elapsed = Date().timeIntervalSince(started)
        Stub.release(alertState)
        check("a hung gate read gives up after its timeout and holds the mail instead of ringing",
              !rec.anything && heldIDs(hung) == ["p2"] && elapsed < 5)
        hung.signOut()
    }
    let soonNow = ISO8601DateFormatter().date(from: "2026-11-07T09:02:00Z")!
    let standup = CalendarEventWire(
        id: "ev-1",
        title: "Standup", startTime: "2026-11-07T09:10:00Z", endTime: "2026-11-07T09:30:00Z",
        location: nil, meetingLink: nil, allDay: false)
    do {
        let down = S.model([alertState: .init(status: 503, body: "{}")])
        var shown: [String] = []
        down.onMeetingSoon = { shown.append($0.id); return true }
        await down.announceMeetingSoon(upcoming: [standup], now: soonNow, session: down.sessionGeneration)
        let notYet = shown.isEmpty && down.meetingAlertStore.load() == nil
        Stub.set(alertState, gate(push: true, meeting: true))
        await down.announceMeetingSoon(
            upcoming: [standup], now: soonNow.addingTimeInterval(60), session: down.sessionGeneration)
        check("no answer: a meeting reminder is neither posted nor recorded, and is offered again next tick",
              notYet && shown == ["ev-1"] && down.meetingAlertStore.load()?.notified == ["ev-1"])
        down.signOut()
    }
    do {
        let late = S.model([alertState: .init(status: 503, body: "{}")])
        var shown: [String] = []
        late.onMeetingSoon = { shown.append($0.id); return true }
        await late.announceMeetingSoon(upcoming: [standup], now: soonNow, session: late.sessionGeneration)
        Stub.set(alertState, gate(push: true, meeting: true))
        let afterStart = ISO8601DateFormatter().date(from: "2026-11-07T09:11:00Z")!
        await late.announceMeetingSoon(upcoming: [standup], now: afterStart, session: late.sessionGeneration)
        check("…but never once the meeting has started", shown.isEmpty)
        late.signOut()
    }

    // MARK: 4 — the Dock badge counts unread mail only

    do {
        let windowed = try? JSONDecoder().decode(FirewallResponse.self, from: Data(lanes(
            push: ["p1", "p2", "p3", "p4"], unread: ["p1": true, "p2": false, "p4": true],
            window: ["p1", "p2", "p3"]).body.utf8))
        check("badge: Today's Needs-you-now mail still unread; no claim counts as unread; outside the window is out",
              windowed.map { TodayRules.dockBadgeCount($0, opened: []) } == 2)
        check("badge: mail opened on this Mac leaves the count before the server says so",
              windowed.map { TodayRules.dockBadgeCount($0, opened: ["d-p1"]) } == 1
              && windowed.map { TodayRules.dockBadgeCount($0, opened: ["d-p1", "d-p3"]) } == 0)
        let wide = try? JSONDecoder().decode(FirewallResponse.self, from: Data(lanes(
            push: (1...20).map { "p\($0)" }, window: (1...20).map { "p\($0)" }).body.utf8))
        check("badge: every unread row counts, not only the \(TodayRules.expandedRowLimit) Today lists",
              wide.map { TodayRules.dockBadgeCount($0, opened: []) } == 20)
    }
    do {
        let model = S.model([
            S.firewall: lanes(push: ["p1", "p2"], unread: ["p1": true, "p2": true], window: ["p1", "p2"]),
            "GET /api/email/d-p1": .init(body: #"{"id":"d-p1"}"#),
        ])
        var counts: [Int] = []
        model.onDockBadgeCountChanged = { counts.append($0) }
        await model.loadQueue()
        await model.select(item("p1"))  // opened here: read on the server too
        let afterOpen = counts
        Stub.set(S.firewall, lanes(push: ["p1", "p2"], unread: ["p1": false, "p2": false], window: ["p1", "p2"]))
        await model.loadQueue()  // p2 read elsewhere
        model.signOut()
        check("the badge drops as soon as a mail is opened here, and when it is read elsewhere",
              afterOpen == [2, 1] && counts == [2, 1, 0] && model.dockBadgeCount == 0)
    }
    let app = text("KlornApp.swift")
    check("the app sets the Dock badge from the unread count",
          app.contains("count: model.dockBadgeCount, enabled: model.settings.showDockBadge)")
          && app.contains("model.onDockBadgeCountChanged = { _ in applyDockBadge() }"))

    // MARK: strings

    let keys = ["push.moreSummary.title", "push.delayedSummary.title"]
    check("the new titles exist in every locale, with %d and never %@",
          L10n.shipped.allSatisfy { locale in
              let strings = text("Resources/\(locale).lproj/Localizable.strings").split(separator: "\n")
              return keys.allSatisfy { key in
                  guard let line = strings.first(where: { $0.hasPrefix("\"\(key)\" = ") }) else { return false }
                  return line.contains("%d") && !line.contains("%@")
              }
          })
    check("the delayed summary title renders its count",
          HeldBanners.summaryBanner(for: ["p3", "p2"].map { item($0) }, kind: .delayed).title
              == L("push.delayedSummary.title", 2)
          && L("push.delayedSummary.title", 2).contains("2") && !L("push.delayedSummary.title", 2).contains("%"))
    check("the app wires the delayed summary to the alerter",
          app.contains("model.onDelayedSummary = { [weak alerter] items in alerter?.handleHeldSummary(items, kind: .delayed) }"))
    return results
}
