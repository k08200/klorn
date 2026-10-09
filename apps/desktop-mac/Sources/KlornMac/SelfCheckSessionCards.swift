import Foundation

// Self-check for what lives outside the model when a session ends: the HUD
// push card, the meeting card, and sign-in itself. Run by `--self-check`
// through `sessionSelfChecks`; same stubbed network, in-memory token store.
// The cards run headless: their whole lifecycle, with no panel and no sound.

/// Holds a sign-in "in the browser" until the check lets it finish.
@MainActor
final class SignInGate {
    var isOpen = false
    var result: SignInResult = .success(token: "token-B")

    func runner() -> @MainActor (APIClient, String) async -> SignInResult {
        { [self] _, _ in
            // Yield too: a cancelled task's sleep returns at once, and this
            // loop must not starve the main actor while it waits.
            while !isOpen {
                await Task.yield()
                try? await Task.sleep(for: .milliseconds(5))
            }
            return result
        }
    }
}

@MainActor
enum CardScenarios {
    typealias Stub = SessionStubProtocol
    typealias S = SessionScenarios

    static let drafts = "POST /api/email/d1/reply-options"
    static let reply = "POST /api/email/d1/reply"
    static let snooze = "POST /api/inbox/firewall/p1/snooze"
    static let detail = "GET /api/email/d1"
    static let prepPack = "GET /api/calendar/ev-A/prep-pack"
    static let draftsBody = #"{"to":"a@a.example","subject":"s","options":[{"tone":"accept","body":"ok"}]}"#

    static func queue(_ id: String, email: String) -> String {
        #"{"tiers":{"PUSH":[{"id":"\#(id)","source":"email","sourceId":"e","type":"email","title":"t","tier":"PUSH","priority":9,"surfacedAt":"2026-07-29T08:12:00Z","email":{"emailDbId":"\#(email)","subject":"s","from":"a@a.example"},"hashStale":false}],"MEETING":[],"QUEUE":[],"INFO":[],"SILENT":[]},"summary":{"PUSH":1,"MEETING":0,"QUEUE":0,"INFO":0,"SILENT":0,"AUTO":0,"total":1}}"#
    }

    static func item(_ id: String, email: String) -> FirewallItem? {
        (try? JSONDecoder().decode(FirewallResponse.self, from: Data(queue(id, email: email).utf8)))?
            .items(for: .push).first
    }

    static let eventId = "ev-A"
    static let event = CalendarEventWire(
        id: eventId, title: eventId, startTime: "2026-07-29T08:00:00Z",
        endTime: "2026-07-29T09:00:00Z", location: nil, meetingLink: nil, allDay: false)

    /// A signed-in model with A's PUSH mail loaded, and a card showing it
    /// with its drafts fetched. `wired`: the card is torn down with the
    /// session, as in the app. Unwired is the teardown having been missed.
    static func presented(
        wired: Bool, hold: Set<String> = [], snoozeStatus: Int = 200
    ) async -> (model: AppModel, card: PushCardController, item: FirewallItem?) {
        let model = S.model(
            [drafts: .init(body: draftsBody), snooze: .init(status: snoozeStatus)], hold: hold)
        model.seedForPreview(firewallJSON: queue("p1", email: "d1"), emailJSON: "", selectedItemId: nil)
        let card = PushCardController(model: model, headless: true)
        if wired { model.onSessionEnded = { [weak card] in card?.reset() } }
        let item = item("p1", email: "d1")
        if let item { card.present([item]) }
        if !hold.contains(drafts) {
            _ = await S.waitUntil { if case .ready = card.state.drafts { true } else { false } }
        }
        return (model, card, item)
    }

    static func settle() async {
        for _ in 0..<10 {
            try? await Task.sleep(for: .milliseconds(5))
            await Task.yield()
        }
    }
}

/// Cards, notifications and sign-in across a session change, as (name, passed).
@MainActor
func sessionCardSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    typealias Stub = SessionStubProtocol
    typealias S = SessionScenarios
    typealias C = CardScenarios
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }

    // MARK: the cards go with the session
    let shown = await C.presented(wired: true)
    let meeting = MeetingCardController(model: shown.model, headless: true, isSlotBusy: { false })
    let cardReset = shown.model.onSessionEnded
    shown.model.onSessionEnded = { [weak meeting] in
        cardReset?()
        meeting?.reset()
    }
    let meetingShown = meeting.present(C.event)
    let before = (item: shown.card.state.item?.id, drafts: shown.card.state.drafts, event: meeting.state.event?.id)
    shown.model.signOut()
    check("control: a card shows the mail and its drafts, the meeting card its event",
          before.item == "p1" && before.drafts != .loading && meetingShown && before.event == "ev-A")
    check("sign-out takes the push card down and empties it",
          shown.card.state.item == nil && shown.card.state.drafts == .loading
          && shown.card.state.detail == nil && shown.card.state.pendingCount == 0
          && shown.card.state.actionError == nil && shown.card.state.sendError == nil
          && !shown.card.state.keysArmed && !shown.card.isVisible)
    check("sign-out takes the meeting card down and empties it",
          meeting.state.event == nil && meeting.state.pack == nil && !meeting.isVisible)
    shown.model.beginSessionForCheck(token: "token-B")
    let itemB = C.item("b1", email: "d9")
    let presentedB = itemB.map { shown.card.present([$0]) } ?? false
    check("the next account's first PUSH presents normally, alone on the card",
          presentedB && shown.card.state.item?.id == "b1" && shown.card.state.pendingCount == 0)

    // MARK: a card whose teardown was missed still cannot act
    let stale = await C.presented(wired: false)
    var opened = 0
    stale.card.onOpenInApp = { _ in opened += 1 }
    stale.model.signOut()
    stale.model.beginSessionForCheck(token: "token-B")
    let stillShowingA = stale.card.state.item?.id == "p1"
    let actions = stale.card.actionsForCheck()
    actions.onSend(0)
    let resetOnFirstTouch = stale.card.state.item == nil
    actions.onSnooze(.tomorrow)
    actions.onRetry()
    actions.onOpen()
    await C.settle()
    check("a card left over from the previous session sends, snoozes, retries and opens nothing",
          stillShowingA && resetOnFirstTouch && opened == 0
          && Stub.calls(C.reply).isEmpty && Stub.calls(C.snooze).isEmpty
          && Stub.calls(C.drafts).count == 1)

    // MARK: the model refuses a stale stamp before any request
    let stamped = await C.presented(wired: false)
    let oldStamp = stamped.model.sessionGeneration
    stamped.model.signOut()
    stamped.model.beginSessionForCheck(token: "token-B")
    stamped.model.seedForPreview(firewallJSON: C.queue("p1", email: "d1"), emailJSON: "", selectedItemId: nil)
    let callsBefore = Stub.calls.count
    var refused = false
    if let item = stamped.item {
        let sent = await stamped.model.sendReply(item, body: "hello", session: oldStamp)
        let snoozed = await stamped.model.snooze(item, session: oldStamp)
        let options = await stamped.model.fetchReplyOptions(item, session: oldStamp)
        let detail = await stamped.model.fetchEmailDetail(item, session: oldStamp)
        let pack = await stamped.model.fetchPrepPack(eventId: "ev-A", session: oldStamp)
        var optionsRefused = false
        if case .failed = options { optionsRefused = true }
        refused = sent != nil && snoozed == nil && optionsRefused && detail == nil && pack == nil
    }
    check("reply, snooze, drafts, detail and prep pack stamped with an ended session issue no request",
          refused && Stub.calls.count == callsBefore
          && stamped.model.queue?.items(for: .push).map(\.id) == ["p1"])
    var sentNow: String? = "not run"
    if let item = stamped.item {
        sentNow = await stamped.model.sendReply(
            item, body: "hello", session: stamped.model.sessionGeneration)
    }
    check("control: the same reply stamped with the live session is sent, with its token",
          sentNow == nil && Stub.calls(C.reply).map(\.bearer) == ["Bearer token-B"])

    // MARK: late results on a card
    let drafting = await C.presented(wired: false, hold: [C.drafts])
    _ = await S.waitUntil { Stub.parked(C.drafts) == 1 }
    drafting.model.signOut()
    Stub.release(C.drafts)
    await C.settle()
    check("drafts that arrive after sign-out are not shown, and neither is a session-expired line",
          drafting.card.state.drafts == .loading && drafting.card.state.sendError == nil)

    let restoring = await C.presented(wired: true, hold: [C.snooze], snoozeStatus: 500)
    restoring.card.actionsForCheck().onSnooze(.tomorrow)
    _ = await S.waitUntil { Stub.parked(C.snooze) == 1 }
    restoring.model.signOut()
    restoring.model.beginSessionForCheck(token: "token-B")
    if let itemB { restoring.card.present([itemB]) }
    Stub.release(C.snooze)
    await C.settle()
    check("a snooze that fails after the account changed never puts that mail back on the card",
          restoring.card.state.item?.id == "b1" && restoring.card.state.actionError == nil
          && restoring.card.state.pendingCount == 0)
    let failing = await C.presented(wired: true, snoozeStatus: 500)
    failing.card.actionsForCheck().onSnooze(.tomorrow)
    let restored = await S.waitUntil { failing.card.state.actionError != nil }
    check("control: within one session a failed snooze brings the mail back with the reason",
          restored && failing.card.state.item?.id == "p1")

    // MARK: sign-in is not undone by a stray 401
    let gate = SignInGate()
    let signing = S.model([S.sentFolder: .init(status: 401), S.firewall: .init(status: 500)], token: nil)
    let store = S.store
    signing.signInRunner = gate.runner()
    let generationBefore = signing.sessionGeneration
    signing.signOut()
    check("signing out with no session is a no-op: the generation stays put",
          signing.sessionGeneration == generationBefore && signing.phase == .signedOut)
    let attempt = Task { await signing.signIn() }
    _ = await S.waitUntil { signing.phase == .signingIn }
    await signing.loadMailbox(.sent)  // answered 401: there is no token yet
    let during = (phase: signing.phase, generation: signing.sessionGeneration)
    gate.isOpen = true
    await attempt.value
    check("a 401 that arrives while signing in ends nothing, and the sign-in completes",
          Stub.calls(S.sentFolder).count == 1 && during.phase == .signingIn
          && during.generation == generationBefore
          && signing.phase == .signedIn && store.load() == "token-B")
    signing.signOut()

    let backingOut = SignInGate()
    let abandoned = S.model(token: nil)
    let abandonedStore = S.store
    abandoned.signInRunner = backingOut.runner()
    let abandonedAttempt = Task { await abandoned.signIn() }
    _ = await S.waitUntil { abandoned.phase == .signingIn }
    abandoned.signOut()
    backingOut.isOpen = true
    await abandonedAttempt.value
    check("signing out during a sign-in is the user backing out: the attempt is abandoned",
          abandoned.phase == .signedOut && abandonedStore.load() == nil)

    // MARK: the poll starts with the session
    let open = SignInGate()
    open.isOpen = true
    let recovering = S.model([S.firewall: .init(status: 500)], token: nil)
    recovering.signInRunner = open.runner()
    recovering.pollInterval = .milliseconds(20)
    await recovering.signIn()
    let firstLoadFailed = recovering.queue == nil && recovering.loadError != nil
    Stub.set(S.firewall, .init(body: S.emptyQueue))
    let recovered = await S.waitUntil { recovering.queue != nil && recovering.loadError == nil }
    check("a sign-in whose first load fails recovers on the next poll, with no Retry",
          firstLoadFailed && recovered && recovering.loadError == nil
          && recovering.surfaceState == .ready)
    recovering.signOut()  // stops the fast poll

    // MARK: source pins
    let files = swiftSources(under: sourceDir)
    func text(_ name: String) -> String {
        files.first { $0.lastPathComponent == name }
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
    check("the app tears the cards and the OS banners down with the session",
          text("KlornApp.swift").contains(
              "model.onSessionEnded = { [weak card, weak meetingCard] in\n            card?.reset()\n            meetingCard?.reset()\n            PushNotifier.clearAll()\n        }")
          && text("Notifications.swift").contains("center.removeAllDeliveredNotifications()\n        center.removeAllPendingNotificationRequests()")
          && text("AppModel.swift").components(separatedBy: "onSessionEnded?()").count == 3)
    let goneTap = PushNotifier.tapAction(
        identifier: PushNotifier.notificationIdentifier(for: "p1"), isKnownItem: { _ in false })
    check("a banner tap opens only mail that is in the current queue",
          goneTap == .expand
          && text("KlornApp.swift").contains("let queue = model.queue\n")
          && text("KlornApp.swift").contains("found = queue?.item(id: id)"))
    let cardSource = text("PushCardController.swift")
    check("every card request carries the card's session stamp",
          ["fetchEmailDetail(item, session: stamp)", "fetchReplyOptions(item, session: stamp)",
           "item, body: options[index].body, session: stamp)",
           "item, until: option.resurface(), session: stamp)"].allSatisfy { cardSource.contains($0) }
          && !cardSource.contains("model.sendReply(item, body: options[index].body)")
          && text("MeetingCardController.swift").contains("fetchPrepPack(eventId: event.id, session: stamp)"))
    return results
}
