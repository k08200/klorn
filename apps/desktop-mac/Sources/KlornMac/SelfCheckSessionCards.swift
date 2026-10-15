import Foundation

// Self-check for what lives outside the model when a session ends: the
// banners (PUSH and meetings), and sign-in itself. Run by `--self-check`
// through `sessionSelfChecks`; same stubbed network, in-memory token store.
// (The urgent-mail and meeting cards were removed, 2026-10-15.)

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
    static let draftsBody = #"{"to":"a@a.example","subject":"s","options":[{"tone":"accept","body":"ok"}]}"#

    static func queue(_ id: String, email: String) -> String {
        #"{"tiers":{"PUSH":[{"id":"\#(id)","source":"email","sourceId":"e","type":"email","title":"t","tier":"PUSH","priority":9,"surfacedAt":"2026-07-29T08:12:00Z","email":{"emailDbId":"\#(email)","subject":"s","from":"a@a.example"},"hashStale":false}],"MEETING":[],"QUEUE":[],"INFO":[],"SILENT":[]},"summary":{"PUSH":1,"MEETING":0,"QUEUE":0,"INFO":0,"SILENT":0,"AUTO":0,"total":1}}"#
    }

    static func item(_ id: String, email: String) -> FirewallItem? {
        (try? JSONDecoder().decode(FirewallResponse.self, from: Data(queue(id, email: email).utf8)))?
            .items(for: .push).first
    }

    /// A signed-in model with A's PUSH mail loaded.
    static func seeded(snoozeStatus: Int = 200) -> (model: AppModel, item: FirewallItem?) {
        let model = S.model([drafts: .init(body: draftsBody), snooze: .init(status: snoozeStatus)])
        model.seedForPreview(firewallJSON: queue("p1", email: "d1"), emailJSON: "", selectedItemId: nil)
        return (model, item("p1", email: "d1"))
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

    // MARK: the banners go with the session
    let shown = C.seeded()
    let notifier = FakePushNotifier()
    shown.model.pushNotifier = notifier
    shown.model.onSessionEnded = { [weak model = shown.model] in model?.pushNotifier.clearAll() }
    shown.model.signOut()
    check("sign-out clears the previous account's banners from Notification Center",
          notifier.clearCount == 1)

    // MARK: the model refuses a stale stamp before any request
    let stamped = C.seeded()
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
        var optionsRefused = false
        if case .failed = options { optionsRefused = true }
        refused = sent != nil && snoozed == nil && optionsRefused
    }
    check("reply, snooze and drafts stamped with an ended session issue no request",
          refused && Stub.calls.count == callsBefore
          && stamped.model.queue?.items(for: .push).map(\.id) == ["p1"])
    var sentNow: String? = "not run"
    if let item = stamped.item {
        sentNow = await stamped.model.sendReply(
            item, body: "hello", session: stamped.model.sessionGeneration)
    }
    check("control: the same reply stamped with the live session is sent, with its token",
          sentNow == nil && Stub.calls(C.reply).map(\.bearer) == ["Bearer token-B"])

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
    check("the app tears the OS banners down with the session",
          text("KlornApp.swift").contains(
              "model.onSessionEnded = { [weak model] in\n            model?.pushNotifier.clearAll()\n        }")
          && text("Notifications.swift").contains("center.removeAllDeliveredNotifications()\n        center.removeAllPendingNotificationRequests()")
          && text("AppModel.swift").components(separatedBy: "onSessionEnded?()").count == 3)
    let goneTap = PushNotifier.tapAction(
        identifier: PushNotifier.notificationIdentifier(for: "p1"), isKnownItem: { _ in false })
    check("a banner tap opens only mail that is in the current queue",
          goneTap == .openApp
          && text("WindowRouter.swift").contains("found = self.model.knownItem(id: id)")
          && text("AppModel.swift").contains("queue?.item(id: id) ?? queueCache[\"all\"]?.item(id: id)"))
    return results
}
