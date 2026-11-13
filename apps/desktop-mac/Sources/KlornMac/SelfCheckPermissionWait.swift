import Foundation

// Self-check for the packaged-harness failure of desktop-v0.4.80120
// (2026-11-13), run by `KlornMac --self-check`.
//
// 1. The harness seam. The release workflow runs this harness through the
//    ASSEMBLED Klorn.app, which has a bundle identifier. Every harness model
//    was built with the real `SystemPushNotifier`, so there it read the CI
//    runner's real notification permission — never answered, `.notDetermined`
//    — while the unbundled `swift run` read `.unavailable`. Since #1718 an
//    unanswered prompt holds banners, so "the model's load path" check saw no
//    banner in the packaged run only. A model built with an injected token
//    store (every harness model) now gets `NoPushNotifier`: the same answer
//    packaged or not, and the harness never reads, prompts or clears the
//    notification center of the Mac it runs on.
// 2. VoiceOver. The same hold also silenced VoiceOver: announcements rode the
//    banner path, so while macOS's banner prompt had no answer a VoiceOver
//    user heard no new urgent mail (while a user who had DENIED banners heard
//    all of it). macOS's permission is about banners. Now, when only macOS
//    holds a banner back, VoiceOver hears the mail or meeting at once, once
//    per wait; the banner still waits for the answer.
//
// Network is the session stub; nothing here posts a real banner, raises a
// real permission prompt or speaks.

@MainActor
func permissionWaitSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ cond: Bool) { results.append((name, cond)) }
    func text(_ file: String) -> String {
        (try? String(contentsOf: sourceDir.appendingPathComponent(file), encoding: .utf8)) ?? ""
    }
    typealias Stub = SessionStubProtocol
    typealias S = SessionScenarios
    let alertState = "GET /api/notifications/alert-state"
    let t0 = ISO8601DateFormatter().date(from: "2026-11-08T00:00:00Z")!

    func itemJSON(_ id: String, tier: String) -> String {
        #"{"id":"\#(id)","source":"email","sourceId":"\#(id)","type":"email","title":"t","tier":"\#(tier)","priority":9,"surfacedAt":"2026-11-07T23:00:00Z","email":{"emailDbId":"d-\#(id)","subject":"s-\#(id)","from":"Name-\#(id) <\#(id)@a.example>"},"hashStale":false}"#
    }
    func item(_ id: String, _ tier: String = "PUSH") -> FirewallItem {
        try! JSONDecoder().decode(FirewallItem.self, from: Data(itemJSON(id, tier: tier).utf8))
    }
    func lanes(push: [String], meeting: [String] = []) -> Stub.Reply {
        let p = push.map { itemJSON($0, tier: "PUSH") }.joined(separator: ",")
        let m = meeting.map { itemJSON($0, tier: "MEETING") }.joined(separator: ",")
        return .init(body: #"{"tiers":{"PUSH":[\#(p)],"MEETING":[\#(m)],"QUEUE":[],"INFO":[],"SILENT":[]},"summary":{"PUSH":\#(push.count),"MEETING":\#(meeting.count),"QUEUE":0,"INFO":0,"SILENT":0,"AUTO":0,"total":\#(push.count + meeting.count)}}"#)
    }
    func gate(push: Bool, meeting: Bool = true) -> Stub.Reply {
        func one(_ allowed: Bool) -> String {
            allowed ? #"{"allowed":true}"# : #"{"allowed":false,"reason":"quiet_hours"}"#
        }
        return .init(body: #"{"alerts":{"push":\#(one(push)),"meeting":\#(one(meeting))}}"#)
    }
    func wire(_ json: String) -> AlertStateWire? {
        try? JSONDecoder().decode(AlertStateWire.self, from: Data(json.utf8))
    }
    final class Recorder {
        var banners: [[String]] = []
        var summaries: [[String]] = []
        var spoken: [String] = []
    }
    /// A harness model on the stub, with macOS answering `permission`.
    func waitingModel(_ replies: [String: Stub.Reply], permission: NotificationPermission)
        -> (AppModel, FakePushNotifier, Recorder) {
        let model = S.model(replies)
        let fake = FakePushNotifier()
        fake.permissionAnswer = permission
        model.pushNotifier = fake
        let rec = Recorder()
        model.bannerClock = { t0 }
        model.onNewPush = { rec.banners.append($0.map(\.id)) }
        model.onHeldSummary = { rec.summaries.append($0.map(\.id)) }
        model.onClosedSummary = { rec.summaries.append($0.map(\.id)) }
        model.onDelayedSummary = { rec.summaries.append($0.map(\.id)) }
        model.onVoiceOverOnly = { rec.spoken.append($0) }
        return (model, fake, rec)
    }

    // MARK: 1 — the harness never uses the real notification center

    let bare = AppModel(tokenStore: InMemoryTokenStore())
    let stubbed = S.model()
    check("a harness model (injected token store) gets the stand-in notifier, packaged or not",
          bare.pushNotifier is NoPushNotifier && stubbed.pushNotifier is NoPushNotifier)
    let standIn = NoPushNotifier()
    let asked = await standIn.requestAuthorization()
    let read = await standIn.permission()
    standIn.post(PushBanner.make(for: item("x")))
    standIn.clearAll()
    check("the stand-in answers as an unbundled run does: unavailable, and it posts nothing",
          asked == .unavailable && read == .unavailable)
    check("the shipped app (Keychain token) still posts through the system notifier",
          text("AppModel.swift").contains(
              "self.pushNotifier = persists ? SystemPushNotifier(receipts: receipts) : NoPushNotifier()"))
    do {
        // The packaged run on CI, made explicit: macOS never answered there.
        let (model, _, rec) = waitingModel([S.firewall: lanes(push: ["p1"]), alertState: gate(push: true)],
                                           permission: .notDetermined)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"]))
        await model.loadQueue()
        check("macOS's prompt unanswered (the CI runner): the banner waits, VoiceOver hears the new mail",
              rec.banners.isEmpty && rec.spoken == [PushAlerter.announcement(for: [item("p2")])]
              && model.pushLedgerStore.load()?.heldIDs == ["p2"])
        model.signOut()
    }

    // MARK: 2 — VoiceOver does not wait for macOS's banner permission

    let allowWire = wire(#"{"alerts":{"push":{"allowed":true},"meeting":{"allowed":true}}}"#)
    let quietWire = wire(#"{"alerts":{"push":{"allowed":false,"reason":"quiet_hours"},"meeting":{"allowed":false,"reason":"quiet_hours"}}}"#)
    check("only macOS waits when the server allows and macOS has no answer",
          ServerAlertGate.waitsForMacOSOnly(.emailUrgent, state: allowWire, permission: .notDetermined)
          && ServerAlertGate.waitsForMacOSOnly(.meeting, state: allowWire, permission: .notDetermined)
          && ServerAlertGate.waitsForMacOSOnly(.emailUrgent, state: AlertStateWire.noGate, permission: .notDetermined))
    check("…and never when macOS answered, the server holds, or the server gave no answer",
          !ServerAlertGate.waitsForMacOSOnly(.emailUrgent, state: allowWire, permission: .authorized)
          && !ServerAlertGate.waitsForMacOSOnly(.emailUrgent, state: allowWire, permission: .denied)
          && !ServerAlertGate.waitsForMacOSOnly(.emailUrgent, state: allowWire, permission: .unavailable)
          && !ServerAlertGate.waitsForMacOSOnly(.emailUrgent, state: quietWire, permission: .notDetermined)
          && !ServerAlertGate.waitsForMacOSOnly(.meeting, state: quietWire, permission: .notDetermined)
          && !ServerAlertGate.waitsForMacOSOnly(.emailUrgent, state: nil, permission: .notDetermined))
    let firstHeard = PermissionWaitVoiceOver.unheard(["a", "b", "a"], key: { $0 }, heard: [])
    let againHeard = PermissionWaitVoiceOver.unheard(["b", "c"], key: { $0 }, heard: firstHeard.heard)
    check("each mail or meeting is heard once per wait, duplicates included",
          firstHeard.items == ["a", "b"] && againHeard.items == ["c"] && againHeard.heard == ["a", "b", "c"])
    do {
        let (model, fake, rec) = waitingModel([S.firewall: lanes(push: ["p1"]), alertState: gate(push: true)],
                                              permission: .notDetermined)
        await model.loadQueue()  // the silent baseline
        Stub.set(S.firewall, lanes(push: ["p1", "p2"], meeting: ["m3"]))
        await model.loadQueue()
        await model.loadQueue()  // m3 is offered again each pass, p2 stays held
        await model.loadQueue()
        let waited = rec.banners.isEmpty && rec.summaries.isEmpty
        check("while macOS waits VoiceOver hears PUSH and MEETING mail once, though both are offered again",
              waited && rec.spoken == [PushAlerter.announcement(for: [item("p2"), item("m3", "MEETING")])])
        fake.permissionAnswer = .authorized  // the user clicks Allow
        await model.loadQueue()
        check("the user clicks Allow: the waiting banners come back",
              rec.banners == [["p2", "m3"]] && model.pushLedgerStore.load()?.heldIDs.isEmpty == true)
        model.signOut()
    }
    do {
        let (model, _, rec) = waitingModel([S.firewall: lanes(push: ["p1"]), alertState: gate(push: false)],
                                           permission: .notDetermined)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"]))
        await model.loadQueue()
        check("quiet hours with macOS waiting: VoiceOver stays quiet too (the server's hold, as before)",
              rec.spoken.isEmpty && rec.banners.isEmpty)
        model.signOut()
    }
    do {
        let (model, _, rec) = waitingModel(
            [S.firewall: lanes(push: ["p1"]), alertState: .init(status: 500, body: #"{"error":"x"}"#)],
            permission: .notDetermined)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"]))
        await model.loadQueue()
        check("no answer from the server with macOS waiting: nothing is heard (fail closed, as before)",
              rec.spoken.isEmpty && rec.banners.isEmpty)
        model.signOut()
    }
    do {
        let (model, _, rec) = waitingModel([S.firewall: lanes(push: ["p1"]), alertState: gate(push: true)],
                                           permission: .denied)
        await model.loadQueue()
        Stub.set(S.firewall, lanes(push: ["p1", "p2"]))
        await model.loadQueue()
        check("macOS denied banners: the alerter is called as before (VoiceOver there), nothing extra",
              rec.banners == [["p2"]] && rec.spoken.isEmpty)
        model.signOut()
    }
    let soonNow = ISO8601DateFormatter().date(from: "2026-11-07T09:02:00Z")!
    let standup = CalendarEventWire(
        id: "ev-1",
        title: "Standup", startTime: "2026-11-07T09:10:00Z", endTime: "2026-11-07T09:30:00Z",
        location: nil, meetingLink: nil, allDay: false)
    do {
        let (model, fake, rec) = waitingModel([alertState: gate(push: true, meeting: true)], permission: .notDetermined)
        var shown: [String] = []
        model.onMeetingSoon = { shown.append($0.id); return true }
        await model.announceMeetingSoon(upcoming: [standup], now: soonNow, session: model.sessionGeneration)
        await model.announceMeetingSoon(
            upcoming: [standup], now: soonNow.addingTimeInterval(60), session: model.sessionGeneration)
        check("a meeting reminder waiting for macOS: VoiceOver hears it once, the banner waits unrecorded",
              rec.spoken == [MeetingBanner.make(for: standup, now: soonNow).title]
              && shown.isEmpty && model.meetingAlertStore.load() == nil)
        fake.permissionAnswer = .authorized
        await model.announceMeetingSoon(
            upcoming: [standup], now: soonNow.addingTimeInterval(120), session: model.sessionGeneration)
        check("…and once macOS answers, the reminder posts as before",
              shown == ["ev-1"] && model.meetingAlertStore.load()?.notified == ["ev-1"] && rec.spoken.count == 1)
        model.signOut()
    }
    check("the app wires the VoiceOver-only announcement to the alerter",
          text("KlornApp.swift").contains(
              "model.onVoiceOverOnly = { [weak alerter] message in alerter?.announceOnly(message) }"))
    do {
        let model = AppModel(tokenStore: InMemoryTokenStore())
        var spoken: [String] = []
        let alerter = PushAlerter(model: model, announce: { spoken.append($0) })
        let wasEnabled = model.settings.notificationsEnabled
        model.settings.notificationsEnabled = false
        alerter.announceOnly(L("push.announce", 1))
        model.settings.notificationsEnabled = wasEnabled
        check("the VoiceOver-only announcement speaks whatever the banner switch says",
              spoken == [L("push.announce", 1)])
    }
    return results
}
