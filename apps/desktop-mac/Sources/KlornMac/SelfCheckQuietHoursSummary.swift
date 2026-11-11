import Foundation

// Self-check for the quiet-hours summary (2026-11-08), run by
// `KlornMac --self-check`.
//
// Windows holds urgent mail that arrives during quiet hours and shows it as one
// catch-up once they end (decision N6, LOCKED 2026-11-08, PR #1644:
// packages/web lib/native/desktop-push-catchup.ts). The Mac dropped a banner
// the server's gate held (#1639). It now does what Windows does:
//   - PUSH mail held for `quiet_hours` waits, recorded in the ledger (so it
//     survives a relaunch and is never announced twice);
//   - the first pass the server allows afterwards posts ONE banner: the mail
//     itself when one is waiting, else "N urgent emails during quiet hours"
//     naming up to three senders, which opens Today;
//   - only mail still in the PUSH lane, not opened on this Mac, from the last
//     72 hours (Windows' PUSH_CATCHUP_WINDOW_MS);
//   - a category opt-out (`user_preferences`) drops; no answer posts new mail
//     (fail-open) and keeps the held mail for a later pass;
//   - MEETING-lane mail and the calendar's meeting-soon banner held by quiet
//     hours stay dropped: N6 catches up PUSH mail only, and a reminder for a
//     meeting that already started is useless.
//
// Network is the session stub (URLProtocol); nothing here posts a real banner.

@MainActor
func quietHoursSummarySelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ cond: Bool) { results.append((name, cond)) }

    typealias Stub = SessionStubProtocol
    typealias S = SessionScenarios
    let alertState = "GET /api/notifications/alert-state"
    let iso = ISO8601DateFormatter()
    let t0 = iso.date(from: "2026-11-08T00:00:00Z")!
    let later = t0.addingTimeInterval(HeldBanners.askAgainSeconds)

    func itemJSON(_ id: String, tier: String, at: String) -> String {
        #"{"id":"\#(id)","source":"email","sourceId":"\#(id)","type":"email","title":"t","tier":"\#(tier)","priority":9,"surfacedAt":"\#(at)","email":{"emailDbId":"d-\#(id)","subject":"s-\#(id)","from":"Name-\#(id) <\#(id)@a.example>"},"hashStale":false}"#
    }
    /// A fixture mail's arrival: "p7" arrived at 23:07, so a higher number is
    /// newer (the lane is listed as given; times decide the catch-up order).
    func arrivedAt(_ id: String) -> String {
        let minute = Int(id.drop { !$0.isNumber }) ?? 0
        return String(format: "2026-11-07T23:%02d:00Z", min(minute, 59))
    }
    func lanes(push: [String], meeting: [String] = [], at: [String: String] = [:]) -> Stub.Reply {
        let p = push.map { itemJSON($0, tier: "PUSH", at: at[$0] ?? arrivedAt($0)) }.joined(separator: ",")
        let m = meeting.map { itemJSON($0, tier: "MEETING", at: at[$0] ?? arrivedAt($0)) }.joined(separator: ",")
        return .init(body: #"{"tiers":{"PUSH":[\#(p)],"MEETING":[\#(m)],"QUEUE":[],"INFO":[],"SILENT":[]},"summary":{"PUSH":\#(push.count),"MEETING":\#(meeting.count),"QUEUE":0,"INFO":0,"SILENT":0,"AUTO":0,"total":\#(push.count + meeting.count)}}"#)
    }
    func gate(push: Bool, meeting: Bool = true, reason: String = "quiet_hours") -> Stub.Reply {
        func one(_ allowed: Bool) -> String {
            allowed ? #"{"allowed":true}"# : #"{"allowed":false,"reason":"\#(reason)"}"#
        }
        return .init(body: #"{"alerts":{"push":\#(one(push)),"meeting":\#(one(meeting))}}"#)
    }
    func item(_ id: String, _ tier: String = "PUSH", at: String = "2026-11-07T23:00:00Z") -> FirewallItem {
        try! JSONDecoder().decode(FirewallItem.self, from: Data(itemJSON(id, tier: tier, at: at).utf8))
    }
    /// A signed-in model whose banners are recorded, on the fixed clock.
    final class Recorder {
        var announced: [[String]] = []
        var summaries: [[String]] = []
        var clock: Date
        init(_ clock: Date) { self.clock = clock }
    }
    func wired(_ model: AppModel, _ rec: Recorder) {
        model.bannerClock = { rec.clock }
        model.onNewPush = { rec.announced.append($0.map(\.id)) }
        model.onHeldSummary = { rec.summaries.append($0.map(\.id)) }
    }
    func held(_ model: AppModel) -> [String] { model.pushLedgerStore.load()?.heldIDs ?? [] }

    // MARK: held during quiet hours, then exactly one summary
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: false)])
        wired(model, rec)
        await model.loadQueue()  // silent baseline
        Stub.set(S.firewall, lanes(push: ["p1", "p2", "p3"], meeting: ["m1"]))
        await model.loadQueue()
        let pendingInQuiet = rec.announced.isEmpty && rec.summaries.isEmpty && held(model) == ["p2", "p3"]
        Stub.set(alertState, gate(push: true))
        rec.clock = later
        await model.loadQueue()
        await model.loadQueue()
        rec.clock = later.addingTimeInterval(HeldBanners.askAgainSeconds)
        await model.loadQueue()
        let ledger = model.pushLedgerStore.load()
        check("quiet hours: new PUSH mail posts nothing and waits in the ledger (MEETING mail is not held)",
              pendingInQuiet)
        check("when the server allows again, ONE summary covers the held mail, newest first; never again",
              rec.summaries == [["p3", "p2"]] && rec.announced.isEmpty)
        check("after the summary the held list is empty and the ids stay recorded as announced",
              ledger?.heldIDs == [] && ["p2", "p3", "m1"].allSatisfy { ledger?.notified.contains($0) == true })
        model.signOut()
        check("sign-out takes the held mail with the ledger", model.pushLedgerStore.load() == nil)
    }
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: false)])
        wired(model, rec)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"]))
        await model.loadQueue()
        Stub.set(alertState, gate(push: true))
        rec.clock = later
        await model.loadQueue()
        check("one held mail comes back as that mail's own banner (as Windows toasts a lone missed mail)",
              rec.announced == [["p2"]] && rec.summaries.isEmpty && held(model).isEmpty)
        model.signOut()
    }
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: false)])
        wired(model, rec)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2", "p3"]))
        await model.loadQueue()
        Stub.set(alertState, gate(push: true))
        Stub.set(S.firewall, lanes(push: ["p1", "p2", "p3", "p4"]))
        rec.clock = t0.addingTimeInterval(60)  // inside the ask-again wait: a new mail asks anyway
        await model.loadQueue()
        check("quiet hours end as a new mail arrives: one summary for the held, the new one on its own",
              rec.summaries == [["p3", "p2"]] && rec.announced == [["p4"]])
        model.signOut()
    }

    // MARK: ask again later, not every poll
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: false)])
        wired(model, rec)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"]))
        await model.loadQueue()
        let afterHold = Stub.calls(alertState).count
        rec.clock = t0.addingTimeInterval(HeldBanners.askAgainSeconds - 1)
        await model.loadQueue()
        let insideWait = Stub.calls(alertState).count
        rec.clock = later
        await model.loadQueue()
        check("after a quiet-hours answer the held mail is asked about again only after \(Int(HeldBanners.askAgainSeconds)) s",
              afterHold == 1 && insideWait == 1 && Stub.calls(alertState).count == 2
              && held(model) == ["p2"] && rec.announced.isEmpty)
        model.signOut()
    }

    // MARK: a category opt-out drops
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]),
                             alertState: gate(push: false, reason: "user_preferences")])
        wired(model, rec)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"]))
        await model.loadQueue()
        let dropped = held(model).isEmpty
        Stub.set(alertState, gate(push: true))
        rec.clock = later
        await model.loadQueue()
        check("user_preferences (Urgent email off on the server): not posted, not held, never comes back",
              dropped && rec.announced.isEmpty && rec.summaries.isEmpty)
        model.signOut()
    }
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: false)])
        wired(model, rec)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"]))
        await model.loadQueue()
        let wasHeld = held(model) == ["p2"]
        Stub.set(alertState, gate(push: false, reason: "user_preferences"))
        Stub.set(S.firewall, lanes(push: ["p1", "p2", "p3"]))
        await model.loadQueue()
        Stub.set(alertState, gate(push: true))
        rec.clock = later
        await model.loadQueue()
        check("mail held for quiet hours is dropped once the category is turned off",
              wasHeld && held(model).isEmpty && rec.announced.isEmpty && rec.summaries.isEmpty)
        model.signOut()
    }
    do {
        let automations: Set<String> = ["GET /api/automations", "PATCH /api/automations"]
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: false)], hold: automations)
        wired(model, rec)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"]))
        await model.loadQueue()
        let wasHeld = held(model) == ["p2"]
        let readsWhileOn = Stub.calls(alertState).count
        model.updateAutomation { $0.notifyEmailUrgent = false }
        Stub.set(alertState, gate(push: true))
        rec.clock = later
        await model.loadQueue()
        check("with Urgent email turned off on this Mac the held mail is dropped, without a gate read",
              wasHeld && held(model).isEmpty && rec.announced.isEmpty && rec.summaries.isEmpty
              && Stub.calls(alertState).count == readsWhileOn)
        automations.forEach(Stub.release)
        model.signOut()
    }

    // MARK: fail-open
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]),
                             alertState: .init(status: 500, body: #"{"error":"x"}"#)])
        wired(model, rec)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"]))
        await model.loadQueue()
        check("fail-open: with no answer from alert-state a new mail still posts at once",
              rec.announced == [["p2"]] && held(model).isEmpty)
        model.signOut()
    }
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: false)])
        wired(model, rec)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2", "p3"]))
        await model.loadQueue()
        Stub.set(alertState, .init(cancelled: true))
        rec.clock = later
        await model.loadQueue()
        let keptOnFailure = held(model) == ["p2", "p3"] && rec.summaries.isEmpty && rec.announced.isEmpty
        Stub.set(alertState, gate(push: true))
        await model.loadQueue()
        check("held mail is kept, not posted, while alert-state cannot answer; the next allowed pass sums it up",
              keptOnFailure && rec.summaries == [["p3", "p2"]])
        model.signOut()
    }

    // MARK: no double post across a relaunch (the held list persists with the ledger)
    do {
        let rec = Recorder(t0)
        let first = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: false)])
        wired(first, rec)
        await first.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2", "p3"]))
        await first.loadQueue()
        let saved = first.pushLedgerStore.load()
        first.signOut()

        let relaunched = S.model([S.firewall: lanes(push: ["p1", "p2", "p3"]), alertState: gate(push: true)],
                                 pushLedgerStore: InMemoryPushLedgerStore(saved))
        let rec2 = Recorder(t0)
        wired(relaunched, rec2)
        await relaunched.loadQueue()
        let savedAgain = relaunched.pushLedgerStore.load()
        relaunched.signOut()

        let third = S.model([S.firewall: lanes(push: ["p1", "p2", "p3"]), alertState: gate(push: true)],
                            pushLedgerStore: InMemoryPushLedgerStore(savedAgain))
        let rec3 = Recorder(t0)
        wired(third, rec3)
        await third.loadQueue()
        check("held mail survives a relaunch and is summarized once; a second relaunch posts nothing",
              saved?.heldIDs == ["p2", "p3"] && rec2.summaries == [["p3", "p2"]] && rec2.announced.isEmpty
              && rec3.summaries.isEmpty && rec3.announced.isEmpty && Stub.calls(alertState).isEmpty)
        third.signOut()
    }
    do {
        let suiteName = "ai.klorn.selfcheck.heldbanners.\(UUID().uuidString)"
        var roundTrip: PushLedger?
        if let suite = UserDefaults(suiteName: suiteName) {
            let store = UserDefaultsPushLedgerStore(defaults: suite)
            store.save(PushLedger.fresh(owner: "u1").recording("a").holding(["a"]))
            roundTrip = store.load()
            suite.removePersistentDomain(forName: suiteName)
        }
        let legacy = try? JSONDecoder().decode(
            PushLedger.self, from: Data(#"{"owner":"u1","baselineEstablished":true,"notified":["a"]}"#.utf8))
        check("the held list persists in the ledger's own UserDefaults record; an older record reads as none held",
              roundTrip?.heldIDs == ["a"] && roundTrip?.notified == ["a"]
              && legacy?.held == nil && legacy?.heldIDs == [])
    }

    // MARK: mail opened (read) meanwhile, or gone from the lane, is left out
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: false),
                             "GET /api/email/d-p2": .init(body: #"{"id":"d-p2"}"#)])
        wired(model, rec)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2", "p3", "p4"]))
        await model.loadQueue()
        await model.select(item("p2"))  // read on this Mac during quiet hours
        Stub.set(S.firewall, lanes(push: ["p1", "p2", "p3"]))  // p4 handled elsewhere
        await model.loadQueue()
        let pruned = held(model) == ["p3"]
        Stub.set(alertState, gate(push: true))
        rec.clock = later
        await model.loadQueue()
        check("a held mail opened meanwhile, or no longer in the PUSH lane, is dropped from the catch-up",
              pruned && rec.announced == [["p3"]] && rec.summaries.isEmpty)
        model.signOut()
    }

    // MARK: recency and the cap
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: false)])
        wired(model, rec)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"]))
        await model.loadQueue()
        Stub.set(alertState, gate(push: true))
        rec.clock = iso.date(from: arrivedAt("p2"))!.addingTimeInterval(HeldBanners.windowSeconds + 1)
        let readsBefore = Stub.calls(alertState).count
        await model.loadQueue()
        check("held mail older than \(Int(HeldBanners.windowSeconds / 3600)) h is dropped without a banner or a gate read",
              rec.announced.isEmpty && rec.summaries.isEmpty && held(model).isEmpty
              && Stub.calls(alertState).count == readsBefore)
        model.signOut()
    }
    let window = HeldBanners.windowSeconds
    let edge = iso.string(from: t0.addingTimeInterval(-window))
    let stale = iso.string(from: t0.addingTimeInterval(-window - 1))
    let readMail = try! JSONDecoder().decode(FirewallItem.self, from: Data(
        #"{"id":"r1","source":"email","sourceId":"r1","type":"email","title":"t","tier":"PUSH","priority":9,"surfacedAt":"2026-11-07T23:00:00Z","email":{"emailDbId":"d-r1","subject":"s","from":"R <r@a.example>","unread":false},"hashStale":false}"#.utf8))
    check("eligible: inside the window (its edge included), unread, not opened; a bad time is out",
          HeldBanners.eligible(
              [item("e1", at: edge), item("s1", at: stale), item("f1"), item("o1"), readMail, item("b1", at: "nope")],
              opened: ["d-o1"], now: t0).map(\.id) == ["e1", "f1"]
          && readMail.email?.unread == false)
    let many = (1...(HeldBanners.maxHeld + 5)).map { "h\($0)" }
    let capped = PushLedger.fresh(owner: nil).holding(many)
    check("at most \(HeldBanners.maxHeld) mails wait, the newest kept; holding twice keeps one entry",
          capped.heldIDs == Array(many.suffix(HeldBanners.maxHeld))
          && PushLedger.fresh(owner: nil).holding(["a", "b"]).holding(["a"]).heldIDs == ["a", "b"])
    check("catch-up order: newest arrival first, a tie goes to the later hold; only held items",
          HeldBanners.due(
              [item("a", at: "2026-11-07T20:00:00Z"), item("b", at: "2026-11-07T22:00:00Z"),
               item("c", at: "2026-11-07T20:00:00Z"), item("x")],
              held: ["b", "a", "c"]).map(\.id) == ["b", "c", "a"])
    check("the summary names up to three distinct senders, then +k",
          HeldBanners.formatSenders(["A", "B", "A", " ", "C", "D", "E"]) == "A, B, C +2"
          && HeldBanners.formatSenders(["A", "B"]) == "A, B")
    let summary = HeldBanners.summaryBanner(for: ["p4", "p3", "p2", "p1"].map { item($0) })
    check("the summary banner: count title, senders body, no mail content, opens Today",
          summary.title == L("push.heldSummary.title", 4) && summary.title.contains("4")
          && summary.body == "Name-p4, Name-p3, Name-p2 +1" && summary.subtitle == nil
          && PushNotifier.tapAction(identifier: summary.identifier, isKnownItem: { _ in true }) == .openToday
          && PushNotifier.itemID(fromNotificationIdentifier: summary.identifier) == nil)
    check("a tapped summary opens the main window on Today",
          quietSourceText(sourceDir, "WindowRouter.swift").contains("case .openToday:")
          && quietSourceText(sourceDir, "WindowRouter.swift").contains("model.navigate(to: .today)"))

    // MARK: the catch-up's ledger edits, pure
    let quietBatch = HeldBanners.resolve(
        verdict: .quietHours, ledger: PushLedger.fresh(owner: nil),
        fresh: [], unseenPush: [item("n2", at: "2026-11-07T23:30:00Z"), item("n1", at: "2026-11-07T22:00:00Z")],
        eligible: [item("n2", at: "2026-11-07T23:30:00Z"), item("n1", at: "2026-11-07T22:00:00Z")])
    check("a batch the lane lists newest first is held oldest first",
          quietBatch.next.heldIDs == ["n1", "n2"] && quietBatch.post.isEmpty && quietBatch.summary.isEmpty)
    let overlapped = HeldBanners.resolve(
        verdict: .allowed, ledger: PushLedger.fresh(owner: nil).holding(["p2", "p3", "p9"]),
        fresh: [], unseenPush: [], eligible: [item("p2"), item("p3")])
    check("an allowed pass clears only the mail it shows; mail another pass held meanwhile still waits",
          overlapped.summary.map(\.id) == ["p3", "p2"] && overlapped.next.heldIDs == ["p9"])

    // MARK: more than the per-sync cap at once
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: false)])
        wired(model, rec)
        await model.loadQueue()
        let burst = (2...8).map { "p\($0)" }
        Stub.set(S.firewall, lanes(push: ["p1"] + burst))
        await model.loadQueue()
        let allHeld = Set(held(model)) == Set(burst)
        Stub.set(alertState, gate(push: true))
        let next = (9...15).map { "p\($0)" }
        Stub.set(S.firewall, lanes(push: ["p1"] + burst + next))
        rec.clock = later
        await model.loadQueue()
        check("quiet hours hold every new PUSH mail, past the \(PushLedger.maxBannersPerSync)-per-sync cap; the summary counts them all",
              allHeld && rec.summaries.first?.count == burst.count && rec.summaries.count == 1
              && rec.announced.first?.count == PushLedger.maxBannersPerSync)
        model.signOut()
    }

    // MARK: PushAlerter posts the summary
    do {
        let alertModel = AppModel(tokenStore: InMemoryTokenStore())
        let fake = FakePushNotifier()
        alertModel.pushNotifier = fake
        var spoken: [String] = []
        let alerter = PushAlerter(model: alertModel, announce: { spoken.append($0) })
        let wasEnabled = alertModel.settings.notificationsEnabled
        alertModel.settings.notificationsEnabled = true
        let posted = alerter.handleHeldSummary(["p3", "p2"].map { item($0) })
        let onOK = posted == fake.posted.first && fake.posted.count == 1
            && posted?.title == L("push.heldSummary.title", 2) && spoken == [L("push.heldSummary.title", 2)]
        alertModel.settings.notificationsEnabled = false
        let mutedPost = alerter.handleHeldSummary(["p5", "p4"].map { item($0) })
        let offOK = mutedPost == nil && fake.posted.count == 1 && spoken.count == 2
        let emptyOK = alerter.handleHeldSummary([]) == nil && spoken.count == 2
        alertModel.settings.notificationsEnabled = wasEnabled
        check("the summary posts one banner while the banner switch is on; VoiceOver hears it either way",
              onOK && offOK && emptyOK)
    }

    // MARK: the verdict, pure
    func wire(_ json: String) -> AlertStateWire? {
        try? JSONDecoder().decode(AlertStateWire.self, from: Data(json.utf8))
    }
    check("verdicts: allowed, quiet hours (held), any other hold (dropped), no answer (unknown)",
          ServerAlertGate.verdict(.emailUrgent, state: wire(#"{"alerts":{"push":{"allowed":true}}}"#)) == .allowed
          && ServerAlertGate.verdict(.emailUrgent, state: wire(#"{"alerts":{"push":{"allowed":false,"reason":"quiet_hours"}}}"#)) == .quietHours
          && ServerAlertGate.verdict(.emailUrgent, state: wire(#"{"alerts":{"push":{"allowed":false,"reason":"user_preferences"}}}"#)) == .refused
          && ServerAlertGate.verdict(.emailUrgent, state: wire(#"{"alerts":{"push":{"allowed":false}}}"#)) == .refused
          && ServerAlertGate.verdict(.emailUrgent, state: nil) == .unknown
          && ServerAlertGate.verdict(.emailUrgent, state: wire("{}")) == .unknown)

    // MARK: overlapping passes post one summary
    do {
        let owner = SessionIdentity.userId(fromToken: "token-A")
        let waiting = PushLedger.fresh(owner: owner)
            .plan(pushItems: ["p1", "p2", "p3"].map { item($0) }).next
            .holding(["p2", "p3"])
        let rec = Recorder(later)
        let model = S.model([S.firewall: lanes(push: ["p1", "p2", "p3"]), alertState: gate(push: true)],
                            hold: [alertState], pushLedgerStore: InMemoryPushLedgerStore(waiting))
        wired(model, rec)
        let a = Task { await model.loadQueue() }
        let b = Task { await model.loadQueue() }
        let bothWaiting = await S.waitUntil { Stub.parked(alertState) == 2 }
        Stub.release(alertState)
        await a.value
        await b.value
        check("two overlapping passes post the summary once", bothWaiting && rec.summaries == [["p3", "p2"]])
        model.signOut()
    }

    // MARK: the calendar's meeting-soon banner is unchanged
    let soonNow = iso.date(from: "2026-11-08T09:02:00Z")!
    let standup = CalendarEventWire(
        id: "ev-1",
        title: "Standup", startTime: "2026-11-08T09:10:00Z", endTime: "2026-11-08T09:30:00Z",
        location: nil, meetingLink: nil, allDay: false)
    do {
        let rec = Recorder(t0)
        let model = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: false, meeting: false)])
        wired(model, rec)
        var shown: [String] = []
        model.onMeetingSoon = { shown.append($0.id); return true }
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"]))
        await model.loadQueue()
        await model.announceMeetingSoon(upcoming: [standup], now: soonNow, session: model.sessionGeneration)
        Stub.set(alertState, gate(push: true, meeting: true))
        await model.announceMeetingSoon(upcoming: [standup], now: soonNow, session: model.sessionGeneration)
        check("a meeting-soon banner held by quiet hours is still dropped (not summarized), mail held apart",
              shown.isEmpty && model.meetingAlertStore.load()?.notified == ["ev-1"]
              && model.meetingAlertStore.load()?.heldIDs == [] && held(model) == ["p2"])
        model.signOut()
    }

    // MARK: copy
    check("the summary title exists in every locale, with %d and never %@",
          ["en", "ko", "de", "es", "fr", "ja", "zh"].allSatisfy { locale in
              let line = quietSourceText(sourceDir, "Resources/\(locale).lproj/Localizable.strings")
                  .split(separator: "\n").first { $0.hasPrefix("\"push.heldSummary.title\" = ") }
              return line?.contains("%d") == true && line?.contains("%@") == false
          }
          && !L("push.heldSummary.title", 3).contains("%") && L("push.heldSummary.title", 3).contains("3"))
    check("the app wires the summary to PushAlerter",
          quietSourceText(sourceDir, "KlornApp.swift").contains(
              "model.onHeldSummary = { [weak alerter] items in alerter?.handleHeldSummary(items) }"))

    return results
}

private func quietSourceText(_ sourceDir: URL, _ file: String) -> String {
    (try? String(contentsOf: sourceDir.appendingPathComponent(file), encoding: .utf8)) ?? ""
}
