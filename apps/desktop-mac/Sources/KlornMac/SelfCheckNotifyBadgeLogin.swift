import Foundation

// Self-check for N4 (Dock badge), N5 ("Open at login" question) and N6
// (closed-app catch-up), 2026-11-11, run by `KlornMac --self-check`.
//
// - N4: the Dock icon shows Today's "Needs you now" mail (PUSH ≤ 72 h,
//   open) still unread (since 2026-11-12, SelfCheckNotificationDrops.swift),
//   nil at 0, "99+" above 99; a Settings switch, ON by default; quiet hours
//   never hide it; sign-out clears it.
// - N5: once, after sign-in, when notifications are first authorized (or
//   macOS already had an answer), "Keep Klorn running in the background?";
//   only "Open at login" registers the login item; never when it is already
//   on or unavailable.
// - N6: urgent mail that arrived while Klorn was quit comes back on the
//   first pass after launch as ONE banner: the mail itself when one, else
//   "N urgent emails while Klorn was closed" naming up to three senders,
//   opening Today; quiet hours hold it until they end (Windows: PR #1644,
//   packages/web lib/native/desktop-push-catchup.ts).
//
// Network is the session stub; nothing here posts a real banner, touches the
// Dock tile, the login item, or the app's real preferences.

@MainActor
func notifyBadgeLoginSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ cond: Bool) { results.append((name, cond)) }
    func text(_ file: String) -> String {
        (try? String(contentsOf: sourceDir.appendingPathComponent(file), encoding: .utf8)) ?? ""
    }
    typealias Stub = SessionStubProtocol
    typealias S = SessionScenarios
    let alertState = "GET /api/notifications/alert-state"
    let iso = ISO8601DateFormatter()
    let t0 = iso.date(from: "2026-11-08T00:00:00Z")!

    func itemJSON(_ id: String, tier: String, at: String) -> String {
        #"{"id":"\#(id)","source":"email","sourceId":"\#(id)","type":"email","title":"t","tier":"\#(tier)","priority":9,"surfacedAt":"\#(at)","email":{"emailDbId":"d-\#(id)","subject":"s-\#(id)","from":"Name-\#(id) <\#(id)@a.example>"},"hashStale":false}"#
    }
    func arrivedAt(_ id: String) -> String {
        let minute = Int(id.drop { !$0.isNumber }) ?? 0
        return String(format: "2026-11-07T23:%02d:00Z", min(minute, 59))
    }
    func lanes(push: [String], meeting: [String] = [], at: [String: String] = [:], window: [String]? = nil) -> Stub.Reply {
        let p = push.map { itemJSON($0, tier: "PUSH", at: at[$0] ?? arrivedAt($0)) }.joined(separator: ",")
        let m = meeting.map { itemJSON($0, tier: "MEETING", at: at[$0] ?? arrivedAt($0)) }.joined(separator: ",")
        let todayPush = window.map { ids in
            #","todayPush":{"windowHours":72,"since":"2026-11-05T00:00:00Z","ids":[\#(ids.map { "\"\($0)\"" }.joined(separator: ","))]}"#
        } ?? ""
        return .init(body: #"{"tiers":{"PUSH":[\#(p)],"MEETING":[\#(m)],"QUEUE":[],"INFO":[],"SILENT":[]},"summary":{"PUSH":\#(push.count),"MEETING":\#(meeting.count),"QUEUE":0,"INFO":0,"SILENT":0,"AUTO":0,"total":\#(push.count + meeting.count)}\#(todayPush)}"#)
    }
    func gate(push: Bool, reason: String = "quiet_hours") -> Stub.Reply {
        let one = push ? #"{"allowed":true}"# : #"{"allowed":false,"reason":"\#(reason)"}"#
        return .init(body: #"{"alerts":{"push":\#(one),"meeting":{"allowed":true}}}"#)
    }
    func item(_ id: String) -> FirewallItem {
        try! JSONDecoder().decode(FirewallItem.self, from: Data(itemJSON(id, tier: "PUSH", at: arrivedAt(id)).utf8))
    }
    final class Recorder {
        var announced: [[String]] = []
        var held: [[String]] = []
        var closed: [[String]] = []
        var clock: Date
        init(_ clock: Date) { self.clock = clock }
    }
    func wired(_ model: AppModel, _ rec: Recorder) {
        model.bannerClock = { rec.clock }
        model.onNewPush = { rec.announced.append($0.map(\.id)) }
        model.onHeldSummary = { rec.held.append($0.map(\.id)) }
        model.onClosedSummary = { rec.closed.append($0.map(\.id)) }
    }

    // MARK: N4 — the Dock badge

    check("badge label: nil at 0 (and below), the count up to 99, then \"99+\"",
          DockBadge.label(count: 0) == nil && DockBadge.label(count: -1) == nil
          && DockBadge.label(count: 1) == "1" && DockBadge.label(count: 99) == "99"
          && DockBadge.label(count: 100) == "99+" && DockBadge.label(count: 12_345) == "99+")
    check("badge label: the Settings switch off hides it",
          DockBadge.label(count: 5, enabled: false) == nil && DockBadge.label(count: 5, enabled: true) == "5")
    check("\"Show count on Dock icon\" is ON unless turned off",
          AppSettings.resolveDockBadge(nil) && AppSettings.resolveDockBadge(true)
          && !AppSettings.resolveDockBadge(false) && AppSettings.resolveDockBadge("junk"))
    do {
        let windowed = try? JSONDecoder().decode(
            FirewallResponse.self, from: Data(lanes(push: ["p1", "p2", "p3", "p4"], window: ["p2", "p4"]).body.utf8))
        let unwindowed = try? JSONDecoder().decode(
            FirewallResponse.self, from: Data(lanes(push: ["p1", "p2", "p3"]).body.utf8))
        let todayCount = { (q: FirewallResponse) in TodayRules.lanes(q).first { $0.tier == .push }?.count ?? 0 }
        let badge = { (q: FirewallResponse) in TodayRules.dockBadgeCount(q, opened: []) }
        check("with no mail read, the badge count is Today's \"Needs you now\" count (the 72 h window when sent)",
              windowed.map(badge) == 2 && windowed.map(todayCount) == 2
              && unwindowed.map(badge) == 3 && unwindowed.map(todayCount) == 3)
    }
    do {
        let model = S.model([S.firewall: lanes(push: ["p1", "p2", "p3"], window: ["p1", "p2", "p3"])])
        var counts: [Int] = []
        model.onDockBadgeCountChanged = { counts.append($0) }
        await model.loadQueue()
        let afterLoad = counts
        Stub.set(S.firewall, lanes(push: ["p1", "p2"], window: ["p1", "p2"]))
        await model.loadQueue()
        await model.loadQueue()  // unchanged: no repeat
        model.signOut()
        check("the model reports the count when the list changes, once per change, and 0 at sign-out",
              afterLoad == [3] && counts == [3, 2, 0] && model.dockBadgeCount == 0)
    }
    let app = text("KlornApp.swift")
    check("the app sets the Dock badge from the count and the switch (0 at sign-out clears it)",
          app.contains("NSApp.dockTile.badgeLabel = DockBadge.label(")
          && app.contains("model.onDockBadgeCountChanged = { _ in applyDockBadge() }")
          && app.contains("model.settings.onDockBadgeChanged = { _ in applyDockBadge() }")
          && text("AppModel.swift").contains("tokenStore.clear()\n        queue = nil"))
    check("quiet hours never reach the badge (it reads no alert gate)",
          !text("DockBadge.swift").contains("alertState") && !text("DockBadge.swift").contains("ServerAlertGate"))
    check("Settings ▸ Notifications has the Dock-badge switch",
          text("PreferencesView.swift").contains("$settings.showDockBadge")
          && text("PreferencesView.swift").contains("L(\"prefs.dockBadge\")"))

    // MARK: N5 — the "Open at login" question

    let available = LoginItem.Availability.available
    let unavailable = LoginItem.Availability.unavailable(reason: "x")
    check("the question: authorized now after asking, never asked, available, not on",
          LoginItemPrompt.shouldShow(asked: false, availability: available, enabled: false,
                                     before: .notDetermined, after: .authorized)
          && !LoginItemPrompt.shouldShow(asked: true, availability: available, enabled: false,
                                         before: .notDetermined, after: .authorized)
          && !LoginItemPrompt.shouldShow(asked: false, availability: unavailable, enabled: false,
                                         before: .notDetermined, after: .authorized)
          && !LoginItemPrompt.shouldShow(asked: false, availability: available, enabled: true,
                                         before: .notDetermined, after: .authorized))
    check("the question: macOS already had an answer (either way) shows it right after sign-in",
          LoginItemPrompt.shouldShow(asked: false, availability: available, enabled: false,
                                     before: .authorized, after: .authorized)
          && LoginItemPrompt.shouldShow(asked: false, availability: available, enabled: false,
                                        before: .denied, after: .denied))
    check("the question: not when banners were just denied, still undecided, or unavailable",
          !LoginItemPrompt.shouldShow(asked: false, availability: available, enabled: false,
                                      before: .notDetermined, after: .denied)
          && !LoginItemPrompt.shouldShow(asked: false, availability: available, enabled: false,
                                         before: .notDetermined, after: .notDetermined)
          && !LoginItemPrompt.shouldShow(asked: false, availability: available, enabled: false,
                                         before: .unavailable, after: .unavailable))

    final class LoginState {
        var asked = false
        var enabled = false
        var availability = LoginItem.Availability.available
        var registers = 0
        var refuse: String?
    }
    func promptModel(_ state: LoginState, permission: NotificationPermission) -> (AppModel, FakePushNotifier) {
        let model = AppModel(tokenStore: InMemoryTokenStore(token: "t"))
        let fake = FakePushNotifier()
        fake.permissionAnswer = permission
        model.pushNotifier = fake
        model.loginItemPrompt = LoginItemPromptEnvironment(
            asked: { state.asked }, markAsked: { state.asked = true },
            availability: { state.availability }, isEnabled: { state.enabled },
            register: {
                state.registers += 1
                if state.refuse == nil { state.enabled = true }
                return state.refuse
            })
        model.windowShownByUser = true
        return (model, fake)
    }
    do {
        let state = LoginState()
        let (model, _) = promptModel(state, permission: .authorized)
        await model.requestNotificationPermissionIfNeeded()
        let shown = model.showLoginItemPrompt && model.activeMainSheet == .loginItemPrompt
        let silent = state.registers == 0 && !state.enabled
        model.answerLoginItemPrompt(openAtLogin: true)
        check("after sign-in and permission, the question shows once, and shows before enabling anything",
              shown && silent)
        check("\"Open at login\" registers the login item, closes the sheet and is remembered",
              state.registers == 1 && state.enabled && state.asked && !model.showLoginItemPrompt)
        let (again, _) = promptModel(state, permission: .authorized)
        state.enabled = false
        await again.requestNotificationPermissionIfNeeded()
        check("once answered it never shows again", !again.showLoginItemPrompt)
    }
    do {
        let state = LoginState()
        let (model, _) = promptModel(state, permission: .authorized)
        await model.requestNotificationPermissionIfNeeded()
        model.dismiss(.loginItemPrompt)  // Esc
        check("\"Not now\" (and Esc) registers nothing and is remembered",
              state.registers == 0 && !state.enabled && state.asked && !model.showLoginItemPrompt)
    }
    do {
        let state = LoginState()
        state.refuse = "no"
        let (model, _) = promptModel(state, permission: .authorized)
        await model.requestNotificationPermissionIfNeeded()
        model.answerLoginItemPrompt(openAtLogin: true)
        check("macOS refusing keeps the sheet up with the reason",
              state.registers == 1 && model.showLoginItemPrompt && model.loginItemPromptError != nil)
        model.answerLoginItemPrompt(openAtLogin: false)
        check("…and \"Not now\" then closes it", !model.showLoginItemPrompt && model.loginItemPromptError == nil)
    }
    do {
        let on = LoginState()
        on.enabled = true
        let (enabledModel, _) = promptModel(on, permission: .authorized)
        await enabledModel.requestNotificationPermissionIfNeeded()
        let off = LoginState()
        off.availability = unavailable
        let (unbundled, _) = promptModel(off, permission: .authorized)
        await unbundled.requestNotificationPermissionIfNeeded()
        check("skipped when the login item is already on or unavailable (and nothing is recorded)",
              !enabledModel.showLoginItemPrompt && !unbundled.showLoginItemPrompt
              && !on.asked && !off.asked && on.registers == 0 && off.registers == 0)
    }
    do {
        let state = LoginState()
        let (model, _) = promptModel(state, permission: .authorized)
        model.windowShownByUser = false
        await model.requestNotificationPermissionIfNeeded()
        check("no question on a login launch (no window the user opened)", !model.showLoginItemPrompt)
    }
    check("the question waits behind every other sheet",
          MainSheetRules.active(showTierGuide: false, showEventEditor: false, showPurposePrompt: false,
                                showLoginItemPrompt: true) == .loginItemPrompt
          && MainSheetRules.active(showTierGuide: false, showEventEditor: false, showPurposePrompt: true,
                                   showLoginItemPrompt: true) == .purposePrompt
          && MainSheetRules.blocksSurface(showTierGuide: false, showEventEditor: false, showPurposePrompt: false,
                                          showLoginItemPrompt: true))
    let sheets = text("Shell/MainSheets.swift")
    let enStrings = text("Resources/en.lproj/Localizable.strings")
    check("the sheet: \"Open at login\" is Return, \"Not now\" is Esc",
          sheets.contains("Button(L(\"loginPrompt.openAtLogin\")) { model.answerLoginItemPrompt(openAtLogin: true) }\n                    .keyboardShortcut(.defaultAction)")
          && sheets.contains("Button(L(\"loginPrompt.notNow\")) { model.answerLoginItemPrompt(openAtLogin: false) }\n                    .keyboardShortcut(.cancelAction)"))
    check("the approved copy, word for word",
          enStrings.contains(#""loginPrompt.title" = "Keep Klorn running in the background?";"#)
          && enStrings.contains(#""loginPrompt.body" = "Klorn can only alert you about urgent mail while it's running. Open it when you log in so you don't miss anything after a restart.";"#)
          // Lowercased: the two button labels are short enough to read as
          // stray prose to the catalogue guard.
          && enStrings.lowercased().contains(#""loginprompt.notnow" = "not now";"#)
          && enStrings.lowercased().contains(#""loginprompt.openatlogin" = "open at login";"#)
          && enStrings.contains(#""push.closedSummary.title" = "%d urgent emails while Klorn was closed";"#))

    // MARK: N6 — mail that arrived while Klorn was quit

    /// A ledger as a previous run left it: p1 seen (the baseline).
    func previousRun() async -> PushLedger? {
        let first = S.model([S.firewall: lanes(push: ["p1"]), alertState: gate(push: true)])
        first.bannerClock = { t0 }
        await first.loadQueue()
        let saved = first.pushLedgerStore.load()
        first.signOut()
        return saved
    }
    func relaunch(push: [String], gate g: Stub.Reply, at: [String: String] = [:], meeting: [String] = [])
        async -> (AppModel, Recorder) {
        let saved = await previousRun()
        let model = S.model([S.firewall: lanes(push: push, meeting: meeting, at: at), alertState: g],
                            pushLedgerStore: InMemoryPushLedgerStore(saved))
        let rec = Recorder(t0)
        wired(model, rec)
        await model.loadQueue()
        return (model, rec)
    }
    do {
        let (model, rec) = await relaunch(push: ["p1", "p2"], gate: gate(push: true))
        check("one mail missed while quit: that mail's own banner",
              rec.announced == [["p2"]] && rec.closed.isEmpty && rec.held.isEmpty)
        model.signOut()
    }
    do {
        let (model, rec) = await relaunch(push: ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"], gate: gate(push: true))
        check("two or more missed while quit: ONE summary, newest first — not up to five banners",
              rec.closed == [["p8", "p7", "p6", "p5", "p4", "p3", "p2"]] && rec.announced.isEmpty && rec.held.isEmpty)
        Stub.set(S.firewall, lanes(push: ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p11"]))
        await model.loadQueue()
        check("after the launch pass, new mail is announced one by one again",
              rec.announced == [["p9", "p10", "p11"]] && rec.closed.count == 1)
        model.signOut()
    }
    do {
        let old = ["p2": "2026-11-04T23:59:00Z"]  // > 72 h before t0
        let (model, rec) = await relaunch(push: ["p1", "p2", "p3"], gate: gate(push: true), at: old)
        check("only mail from the last 72 hours counts (older is recorded silently)",
              rec.announced == [["p3"]] && rec.closed.isEmpty
              && model.pushLedgerStore.load()?.notified.contains("p2") == true)
        model.signOut()
    }
    do {
        let (model, rec) = await relaunch(push: ["p1", "p2", "p3"], gate: gate(push: false))
        let heldDuringQuiet = rec.announced.isEmpty && rec.closed.isEmpty && rec.held.isEmpty
            && model.pushLedgerStore.load()?.heldIDs == ["p2", "p3"]
        Stub.set(alertState, gate(push: true))
        rec.clock = t0.addingTimeInterval(HeldBanners.askAgainSeconds)
        await model.loadQueue()
        check("quiet hours at launch hold the missed mail; when they end, ONE \"while Klorn was closed\" summary",
              heldDuringQuiet && rec.closed == [["p3", "p2"]] && rec.held.isEmpty && rec.announced.isEmpty)
        model.signOut()
    }
    do {
        let (model, rec) = await relaunch(push: ["p1", "p2", "p3"], gate: gate(push: false, reason: "user_preferences"))
        check("Urgent email off on the server: the missed mail is dropped",
              rec.announced.isEmpty && rec.closed.isEmpty && model.pushLedgerStore.load()?.heldIDs == [])
        model.signOut()
    }
    do {
        let (model, rec) = await relaunch(push: ["p1", "p2", "p3"], gate: gate(push: true), meeting: ["m4"])
        check("MEETING mail missed while quit keeps its own banner beside the PUSH summary",
              rec.closed == [["p3", "p2"]] && rec.announced == [["m4"]])
        model.signOut()
    }
    do {
        let summary = HeldBanners.summaryBanner(for: ["p3", "p2", "p1"].map(item), kind: .whileClosed)
        check("the closed-app summary: count title, senders body, and a tap opens Today",
              summary.title == L("push.closedSummary.title", 3) && summary.title.contains("3")
              && !summary.title.contains("%") && summary.body == "Name-p3, Name-p2, Name-p1"
              && PushNotifier.tapAction(identifier: summary.identifier, isKnownItem: { _ in true }) == .openToday)
    }
    check("the app wires the closed-app summary to the alerter",
          app.contains("model.onClosedSummary = { [weak alerter] items in alerter?.handleHeldSummary(items, kind: .whileClosed) }"))
    return results
}
