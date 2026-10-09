import Foundation
import os

// Self-check for session scope, run by `KlornMac --self-check`.
//
// Work started under one account can finish after that account signed out and
// another signed in. These scenarios drive the real model on an in-memory
// token store and a stubbed network that holds a request until the test lets
// it go, and assert that the late result writes nothing into the new session.

/// Answers the scenarios' URLSession, records every request, and can park a
/// request until `release` (a response "in flight" across a sign-out).
final class SessionStubProtocol: URLProtocol, @unchecked Sendable {
    struct Call: Sendable, Equatable {
        let method: String
        let path: String
        let bearer: String?
    }
    struct Reply: Sendable {
        var status = 200
        var body = "{}"
        /// Fail as a cancelled request does, with no HTTP answer.
        var cancelled = false
    }
    private struct State {
        /// The scenario in progress. Each one gets its own host, so a request
        /// a finished scenario left behind is answered but never counted.
        var scenario = 0
        var replies: [String: Reply] = [:]
        var held: Set<String> = []
        var parked: [String: [@Sendable () -> Void]] = [:]
        var calls: [Call] = []
    }

    private static let state = OSAllocatedUnfairLock(initialState: State())

    /// Start a scenario; returns the base URL its client must use.
    static func reset(_ replies: [String: Reply] = [:], hold: Set<String> = []) -> String {
        state.withLock { state in
            state = State(scenario: state.scenario + 1, replies: replies, held: hold)
            return "http://\(host(state.scenario))"
        }
    }
    private static func host(_ scenario: Int) -> String { "scenario-\(scenario).stub.test" }
    /// Change one reply while a scenario runs (the network "coming back").
    static func set(_ key: String, _ reply: Reply) { state.withLock { $0.replies[key] = reply } }
    static var calls: [Call] { state.withLock { $0.calls } }
    static func calls(_ key: String) -> [Call] { calls.filter { "\($0.method) \($0.path)" == key } }
    static func parked(_ key: String) -> Int { state.withLock { $0.parked[key]?.count ?? 0 } }

    /// Answer every request parked under `key`, and stop holding it.
    static func release(_ key: String) {
        let waiting: [@Sendable () -> Void] = state.withLock { state in
            state.held.remove(key)
            return state.parked.removeValue(forKey: key) ?? []
        }
        waiting.forEach { $0() }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        let method = request.httpMethod ?? "GET"
        let key = "\(method) \(url.path)"
        let call = Call(method: method, path: url.path, bearer: request.value(forHTTPHeaderField: "Authorization"))
        let answer: @Sendable () -> Void = { [self] in
            let reply = Self.state.withLock { $0.replies[key] ?? Reply() }
            self.answer(reply, url: url)
        }
        let parkedIt = Self.state.withLock { state in
            guard url.host == Self.host(state.scenario) else { return nil as Bool? }
            state.calls.append(call)
            guard state.held.contains(key) else { return false }
            state.parked[key, default: []].append(answer)
            return true
        }
        switch parkedIt {
        case nil: self.answer(Reply(), url: url)  // a finished scenario's leftover
        case false?: answer()
        case true?: break
        }
    }

    private func answer(_ reply: Reply, url: URL) {
        if reply.cancelled {
            client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
            return
        }
        let response = HTTPURLResponse(
            url: url, statusCode: reply.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])
        if let response { client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed) }
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
enum SessionScenarios {
    typealias Stub = SessionStubProtocol

    static let send = "POST /api/email/send"
    static let firewall = "GET /api/inbox/firewall"
    static let liveDraft = "GET /api/email/live/draft-A"
    static let sentFolder = "GET /api/email/mailbox/sent"
    static let emptyQueue = #"{"tiers":{"PUSH":[],"MEETING":[],"QUEUE":[],"INFO":[],"SILENT":[]},"summary":{"PUSH":0,"MEETING":0,"QUEUE":0,"INFO":0,"SILENT":0,"AUTO":0,"total":0}}"#
    static let pushQueue = #"{"tiers":{"PUSH":[{"id":"p1","source":"email","sourceId":"e1","type":"email","title":"t","tier":"PUSH","priority":9,"surfacedAt":"2026-07-29T08:12:00Z","hashStale":false}],"MEETING":[],"QUEUE":[],"INFO":[],"SILENT":[]},"summary":{"PUSH":1,"MEETING":0,"QUEUE":0,"INFO":0,"SILENT":0,"AUTO":0,"total":1}}"#
    static let draftDetail = #"{"success":true,"data":{"gmailId":"draft-A","threadId":null,"subject":"A subject","from":"a@a.example","to":"Peer <peer@a.example>","cc":"","snippet":"","body":"A body","renderHtml":null,"receivedAt":"2026-07-29T08:12:00Z","isRead":true}}"#
    static let draftItem = MailboxItem(
        gmailId: "draft-A", threadId: nil, subject: "A subject", from: "a@a.example",
        to: "peer@a.example", snippet: "", receivedAt: "2026-07-29T08:12:00Z", isRead: true,
        inbox: "primary")

    /// The token store of the last model made, for checks on what was saved.
    static var store = InMemoryTokenStore()

    /// A model whose every request goes to the stub: signed in as account A,
    /// or signed out with `token: nil`. It never opens the wake socket.
    static func model(
        _ replies: [String: Stub.Reply] = [:], hold: Set<String> = [], token: String? = "token-A"
    ) -> AppModel {
        let base = Stub.reset(replies, hold: hold)
        let store = InMemoryTokenStore(token: token)
        Self.store = store
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Stub.self]
        let api = APIClient(
            base: base, session: URLSession(configuration: configuration),
            token: { store.load() })
        let model = AppModel(tokenStore: store, api: api)
        model.updateCheck = { .unknown }  // never GitHub from a harness
        model.opensRealtime = false
        return model
    }

    static func waitUntil(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<1000 {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return condition()
    }

    static func fillComposer(_ model: AppModel, account: String) {
        model.composeTo = "to@\(account).example"
        model.composeSubject = "subject \(account)"
        model.composeBody = "body \(account)"
        model.seedEditingDraftForCheck(gmailId: "draft-\(account)", inbox: "primary")
        model.showCompose = true
    }

    static func composerIsUntouched(_ model: AppModel, account: String) -> Bool {
        model.composeTo == "to@\(account).example" && model.composeSubject == "subject \(account)"
            && model.composeBody == "body \(account)" && model.editingDraftGmailId == "draft-\(account)"
            && model.showCompose && model.composeError == nil && !model.composeSending
    }

    /// A's send is in flight; A signs out, B signs in and starts a draft;
    /// then A's send answers with `reply`.
    static func sendAcrossAccounts(_ reply: Stub.Reply) async -> (model: AppModel, sentAs: String?) {
        let model = model([send: reply], hold: [send])
        fillComposer(model, account: "A")
        let sending = Task { await model.submitCompose() }
        _ = await waitUntil { Stub.parked(send) == 1 }
        model.signOut()
        model.beginSessionForCheck(token: "token-B")
        fillComposer(model, account: "B")
        Stub.release(send)
        await sending.value
        return (model, Stub.calls(send).first?.bearer)
    }

    static func draftDeletes() -> [Stub.Call] {
        Stub.calls.filter { $0.method == "DELETE" && $0.path.hasPrefix("/api/email/draft/") }
    }
}

/// Every session-scope check, as (name, passed).
@MainActor
func sessionSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    typealias Stub = SessionStubProtocol
    typealias S = SessionScenarios
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }

    // MARK: the generation
    let counted = S.model()
    let first = counted.sessionGeneration
    counted.signOut()
    let afterSignOut = counted.sessionGeneration
    counted.beginSessionForCheck(token: "token-B")
    check("sign-out and sign-in each start a new session generation",
          afterSignOut != first && counted.sessionGeneration != afterSignOut
          && counted.sessionGeneration != first
          && !counted.isCurrent(first) && counted.isCurrent(counted.sessionGeneration)
          && counted.phase == .signedIn)

    // MARK: compose
    let sent = await S.sendAcrossAccounts(.init())
    check("a send that lands after another account signed in leaves that account's composer alone",
          sent.sentAs == "Bearer token-A" && S.composerIsUntouched(sent.model, account: "B"))
    check("and deletes no draft: not the sender's under the new token, not the new account's",
          S.draftDeletes().isEmpty)
    let failed = await S.sendAcrossAccounts(.init(status: 500, body: #"{"message":"boom"}"#))
    check("a send that fails after another account signed in writes no error into its composer",
          S.composerIsUntouched(failed.model, account: "B"))
    let expired = await S.sendAcrossAccounts(.init(status: 401))
    check("a 401 for the account that left does not sign the new account out",
          expired.model.phase == .signedIn && S.composerIsUntouched(expired.model, account: "B"))

    // Control: with no account change the same send clears the composer and
    // deletes the draft it was started from.
    let same = S.model()
    S.fillComposer(same, account: "A")
    await same.submitCompose()
    check("control: a send within one session clears the composer and deletes its draft",
          same.composeTo.isEmpty && same.editingDraftGmailId == nil && !same.showCompose
          && S.draftDeletes().map(\.path) == ["/api/email/draft/by-message/draft-A"]
          && S.draftDeletes().first?.bearer == "Bearer token-A")

    // MARK: draft open
    let opened = S.model([S.liveDraft: .init(body: S.draftDetail)])
    await opened.loadDraftForEditing(S.draftItem)
    check("control: opening a draft fills the composer",
          opened.composeTo == "peer@a.example" && opened.composeBody == "A body"
          && opened.editingDraftGmailId == "draft-A" && opened.showCompose)
    let late = S.model([S.liveDraft: .init(body: S.draftDetail)], hold: [S.liveDraft])
    let opening = Task { await late.loadDraftForEditing(S.draftItem) }
    _ = await S.waitUntil { Stub.parked(S.liveDraft) == 1 }
    late.signOut()
    Stub.release(S.liveDraft)
    await opening.value
    check("a draft that arrives after sign-out is not put in the composer",
          late.composeTo.isEmpty && late.composeSubject.isEmpty && late.composeBody.isEmpty
          && late.editingDraftGmailId == nil && late.editingDraftInbox == nil
          && !late.showCompose && late.mailboxError == nil)

    // MARK: queue
    let queued = S.model([S.firewall: .init(body: S.emptyQueue)], hold: [S.firewall])
    let loading = Task { await queued.loadQueue() }
    _ = await S.waitUntil { Stub.parked(S.firewall) == 1 }
    queued.signOut()
    Stub.release(S.firewall)
    await loading.value
    check("a queue that arrives after sign-out reaches neither the cache nor the screen",
          Stub.calls(S.firewall).first?.bearer == "Bearer token-A"
          && queued.queue == nil && queued.queueCacheIsEmpty && queued.loadError == nil
          && !queued.isLoadingQueue && queued.phase == .signedOut)

    // A folder listing answered 401 for A after B signed in.
    let folder = S.model([S.sentFolder: .init(status: 401)], hold: [S.sentFolder])
    let listing = Task { await folder.loadMailbox(.sent) }
    let folderParked = await S.waitUntil { Stub.parked(S.sentFolder) == 1 }
    folder.signOut()
    folder.beginSessionForCheck(token: "token-B")
    Stub.release(S.sentFolder)
    await listing.value
    check("a late 401 on any request leaves the new session signed in, with nothing written",
          folderParked && folder.phase == .signedIn && folder.mailboxItems.isEmpty
          && folder.mailboxError == nil && folder.mailboxLoading == nil)

    // MARK: realtime and the poll
    let woken = S.model([S.firewall: .init(status: 500)])
    let wakeSession = woken.sessionGeneration
    let delivered = woken.realtimeDidWake(session: wakeSession)
    _ = await S.waitUntil { woken.loadError != nil }
    check("control: a wake in its own session refetches the queue",
          delivered && Stub.calls(S.firewall).count == 1)
    woken.signOut()
    let fetchesAtSignOut = Stub.calls(S.firewall).count
    let afterSignOutWake = woken.realtimeDidWake(session: wakeSession)
    woken.beginSessionForCheck(token: "token-B")
    let afterSignInWake = woken.realtimeDidWake(session: wakeSession)
    for _ in 0..<20 { await Task.yield() }
    check("a realtime wake from the session that signed out is ignored, before and after the next sign-in",
          !afterSignOutWake && !afterSignInWake && Stub.calls(S.firewall).count == fetchesAtSignOut)

    // MARK: actions
    let snoozing = S.model(["POST /api/inbox/firewall/p1/snooze": .init(status: 500, body: #"{"message":"boom"}"#)])
    snoozing.seedForPreview(firewallJSON: S.pushQueue, emailJSON: "", selectedItemId: nil)
    let pushItem = snoozing.queue?.items(for: .push).first
    var refusal: String?
    if let pushItem { refusal = await snoozing.snooze(pushItem) }
    check("a failed snooze reports its message to the caller and raises the action notice",
          pushItem != nil && refusal == "boom" && snoozing.actionError == "boom")
    let lateSnooze = S.model(
        ["POST /api/inbox/firewall/p1/snooze": .init(status: 500)],
        hold: ["POST /api/inbox/firewall/p1/snooze"])
    lateSnooze.seedForPreview(firewallJSON: S.pushQueue, emailJSON: "", selectedItemId: nil)
    let lateItem = lateSnooze.queue?.items(for: .push).first
    let lateTask = Task { () -> String? in
        guard let lateItem else { return "no item" }
        return await lateSnooze.snooze(lateItem)
    }
    _ = await S.waitUntil { Stub.parked("POST /api/inbox/firewall/p1/snooze") == 1 }
    lateSnooze.signOut()
    lateSnooze.beginSessionForCheck(token: "token-B")
    Stub.release("POST /api/inbox/firewall/p1/snooze")
    let lateRefusal = await lateTask.value
    check("a snooze that fails after the account changed rolls nothing back and shows nothing",
          lateRefusal == nil && lateSnooze.actionError == nil && lateSnooze.queue == nil)
    var cards = PushCardQueue()
    cards.enqueue([lateItem, pushItem].compactMap { $0 })
    let cardItem = cards.current
    cards.advance()
    if let cardItem {
        cards.restore(cardItem)
        cards.restore(cardItem)
    }
    check("the card queue takes a failed item back at the front, once",
          cardItem != nil && cards.items.map(\.id) == ["p1"] && cards.current?.id == "p1")

    // MARK: a cancelled first load
    typealias Rules = SurfaceStateRules
    check("a cancelled load needs recovery only with nothing loaded and no error showing",
          Rules.cancelledLoadRecovery(hasQueue: true, hasError: false, retried: false) == .none
          && Rules.cancelledLoadRecovery(hasQueue: false, hasError: true, retried: false) == .none
          && Rules.cancelledLoadRecovery(hasQueue: false, hasError: false, retried: false) == .retry
          && Rules.cancelledLoadRecovery(hasQueue: false, hasError: false, retried: true) == .fail)
    let cancelled = S.model([S.firewall: .init(cancelled: true)])
    await cancelled.loadQueue()
    let resolved = await S.waitUntil { cancelled.surfaceState != .loading }
    for _ in 0..<20 { await Task.yield() }
    check("a cancelled first load retries once, then shows the failed state instead of loading forever",
          resolved && cancelled.surfaceState == .failed(L("error.unreachable"))
          && Stub.calls(S.firewall).count == 2 && cancelled.connectionNotice == nil)

    // MARK: what sign-out leaves behind
    // One list drives the reset and this check (`AppModel.accountFields`).
    let leaving = S.model()
    let fields = AppModel.accountFields()
    leaving.dirtyAccountStateForCheck()
    let dirtied = fields.filter { $0.dirty != nil }
    let wasDirty = dirtied.filter { !$0.isClean(leaving) }.map(\.name)
    leaving.signOut()
    let stillSet = fields.filter { !$0.isClean(leaving) }.map(\.name)
    check("sign-out resets every per-account field on the model's list", stillSet.isEmpty)
    if !stillSet.isEmpty { print("      not reset: \(stillSet.joined(separator: ", "))") }
    check("and the check is not vacuous: each field it can set was set first",
          wasDirty == dirtied.map(\.name) && Set(fields.map(\.name)).count == fields.count)
    // Fields whose values are too costly to build here are checked clean
    // only. Named, so a new field does not join them unnoticed.
    check("the fields checked without being set first are the known few",
          fields.filter { $0.dirty == nil }.map(\.name).sorted() == [
              "agentToday", "automation", "calendarRangeEvents", "diagnostics", "editingEvent",
              "imapAccounts", "mailboxDetail", "pendingActions", "purposePromptTarget",
              "selectedMailboxItem", "teamAvailability", "teams", "waitingOn",
          ])

    // MARK: source pins
    let files = swiftSources(under: sourceDir)
    func text(_ name: String) -> String {
        files.first { $0.lastPathComponent == name }
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
    let appModel = text("AppModel.swift")
    let staleClause = "} catch _ where !isCurrent(session) {"
    // Exact pairing: each 401 handler sits right behind the clause that
    // drops a result from a session that has ended, and its first statement
    // is `sessionRejected()`, which signs out only a live session.
    let unauthorized = appModel.components(separatedBy: "} catch APIError.unauthorized {")
    check("every 401 handler in the model is behind the stale-session clause",
          unauthorized.count > 1
          && unauthorized.dropLast().allSatisfy { before in
              before.components(separatedBy: "\n").suffix(3).first?.hasSuffix(staleClause) == true
          })
    check("every 401 handler ends the session through sessionRejected, never signOut directly",
          unauthorized.dropFirst().allSatisfy {
              $0.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("sessionRejected()")
          }
          && !appModel.contains("            signOut()")
          && appModel.components(separatedBy: "\n        signOut()\n").count == 2
          && appModel.contains("guard phase == .signedIn else { return }\n        signOut()\n"))
    check("sign-out ends the session before anything else, and stops the poll and the socket",
          appModel.contains("guard phase != .signedOut else { return }\n        signInTask?.cancel()\n        // First: from here on, nothing the leaving session started is current.\n        sessionGeneration += 1\n        stopPolling()")
          && appModel.contains("realtime?.stop()\n        realtime = nil\n        seenPush = []"))
    check("the poll loop and the wake channel are bound to the session that started them",
          appModel.contains("guard !Task.isCancelled, let self, self.isCurrent(session) else { break }")
          && appModel.contains("self?.realtimeDidWake(session: session)")
          && text("RealtimeClient.swift").contains("if stopped || Task.isCancelled { break }\n                    backoff = 1"))
    check("the failed-action notice is drawn on the expanded panel and the HUD card too",
          files.map(\.lastPathComponent)
              .filter { !$0.hasPrefix("SelfCheck") && !$0.hasPrefix("PreviewRender") }
              .filter { text($0).contains("ActionErrorBanner(message: message)") }.sorted()
              == ["ExpandedDashboard.swift", "FullView.swift", "MainShell.swift"]
          && text("PushCard.swift").contains("if let message = state.actionError { actionErrorRow(message) }")
          && text("PushCardController.swift").contains("self.restore(item, failure: failure, stamp: stamp)"))
    for result in await sessionCardSelfChecks(sourceDir: sourceDir) { results.append(result) }
    return results
}
