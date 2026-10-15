import AppKit
import Foundation

// Self-check for the 2026-10-15 founder decision (LOCKED): no pill, no
// expanded panel — Klorn on Mac is a standard app (main window + Dock icon)
// and PUSH mail is announced with macOS notification banners. Run by
// `KlornMac --self-check`. The meeting card went too: no floating Klorn
// surfaces at all. Nothing here posts a real banner, raises a real
// permission prompt, opens a window or touches the Keychain: the window and
// the notification center sit behind seams with fakes below.

/// Records what would have been posted.
@MainActor
final class FakePushNotifier: PushNotifying {
    var permissionAnswer: NotificationPermission = .authorized
    private(set) var posted: [PushBanner] = []
    private(set) var authorizationRequests = 0
    private(set) var clearCount = 0

    func requestAuthorization() async -> NotificationPermission {
        authorizationRequests += 1
        return permissionAnswer
    }
    func permission() async -> NotificationPermission { permissionAnswer }
    func post(_ banner: PushBanner) { posted.append(banner) }
    func clearAll() { clearCount += 1 }
}

/// Records open/close requests instead of drawing a window.
@MainActor
final class FakeMainWindow: MainWindowPresenting {
    var isFrontmost = false
    private(set) var opens: [Bool] = []  // the `activate` argument of each open
    private(set) var closes = 0
    func open(activate: Bool) { opens.append(activate) }
    func close() { closes += 1 }
}

@MainActor
final class FakeOnboarding: OnboardingPresenting {
    private(set) var opens = 0
    func open() { opens += 1 }
}

@MainActor
func noPillSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let files = swiftSources(under: sourceDir)
    let shipping = files.filter { !$0.lastPathComponent.hasPrefix("SelfCheck") }
    func text(_ name: String) -> String {
        files.first { $0.lastPathComponent == name }
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
    func users(of needle: String) -> [String] {
        shipping.filter { (try? String(contentsOf: $0, encoding: .utf8))?.contains(needle) ?? false }
            .map(\.lastPathComponent).sorted()
    }

    // MARK: nothing of the pill or the panel remains
    let retiredNames = shipping.map(\.lastPathComponent).filter {
        ["TopBarController.swift", "TopBarRoot.swift", "CollapsedPill.swift",
         "ExpandedDashboard.swift", "AccountColumn.swift", "StatusItemController.swift",
         "PushCard.swift", "PushCardController.swift", "PushCardSupport.swift"].contains($0)
    }
    check("the pill, panel, menu-bar anchor and urgent-mail card files are gone",
          retiredNames.isEmpty && !shipping.contains { $0.path.contains("/Pill/") })
    // Split so this file's own literals never match.
    let retiredTypeNames: [String] = [
        "TopBar" + "Controller", "TopBar" + "Root", "TopBar" + "Actions", "TopBar" + "Metrics",
        "Bar" + "State", "Collapsed" + "Bar", "Expanded" + "Panel", "Keyable" + "Panel",
        "StatusItem" + "Controller", "PushCard" + "Controller", "PushCard" + "Metrics",
        "mainWindow" + "OffHint", "MainWindow" + "Toggle",
    ]
    // The retired settings: no property, no read. Their old keys are named
    // only in `AppSettings.retiredKeys`, which deletes them.
    var retiredSettingUses: [String] = []
    for name in ["pill" + "Visible", "show" + "InDock", "mac" + "MainWindow"] {
        let capitalized = name.prefix(1).uppercased() + name.dropFirst()
        retiredSettingUses.append("var " + name)
        retiredSettingUses.append("settings." + name)
        retiredSettingUses.append("resolve" + capitalized)
    }
    let retiredTypes = retiredTypeNames + retiredSettingUses
    let typeOffenders = retiredTypes.filter { !users(of: $0).isEmpty }
    check("no TopBar / pill / panel types or settings remain in the shipping sources",
          typeOffenders.isEmpty)
    if !typeOffenders.isEmpty { print("    still referenced: \(typeOffenders)") }

    // MARK: activation is always .regular
    check("activation policy is always .regular (Dock + Cmd+Tab)",
          AppRules.activationPolicy == .regular)
    let policyCalls = shipping.flatMap { url in
        ((try? String(contentsOf: url, encoding: .utf8)) ?? "").split(separator: "\n")
            .filter { $0.contains("setActivationPolicy(") }
    }
    check("every activation-policy call uses the one rule, and none asks for .accessory",
          !policyCalls.isEmpty
          && policyCalls.allSatisfy { $0.contains("setActivationPolicy(AppRules.activationPolicy)") }
          && users(of: ".accessory").isEmpty)

    // MARK: window open / close / reopen routing
    func router(
        signedIn: Bool, openAtQuit: Bool = false
    ) -> (WindowRouter, FakeMainWindow, FakeOnboarding, AppModel) {
        let model = AppModel(tokenStore: InMemoryTokenStore(token: signedIn ? "t" : nil))
        model.settings.mainWindowOpenAtQuit = openAtQuit
        let window = FakeMainWindow()
        let onboarding = FakeOnboarding()
        let router = WindowRouter(model: model, mainWindow: window)
        router.onboarding = onboarding
        return (router, window, onboarding, model)
    }
    do {
        let (r, w, o, _) = router(signedIn: true)
        r.launch(loginLaunch: false)
        check("a normal launch, signed in, opens and focuses the main window",
              w.opens == [true] && o.opens == 0)
    }
    do {
        let (r, w, o, _) = router(signedIn: false)
        r.launch(loginLaunch: false)
        check("a normal launch, signed out, opens onboarding (not a logged-out window)",
              w.opens.isEmpty && o.opens == 1)
    }
    do {
        let (r, w, o, _) = router(signedIn: true, openAtQuit: false)
        r.launch(loginLaunch: true)
        check("a login launch opens nothing and steals no focus",
              w.opens.isEmpty && o.opens == 0)
    }
    do {
        let (r, w, _, _) = router(signedIn: true, openAtQuit: true)
        r.launch(loginLaunch: true)
        check("a login launch brings the window back, unfocused, if it was open at quit",
              w.opens == [false])
    }
    check("a login launch never opens onboarding",
          AppRules.launchAction(signedIn: false, loginLaunch: true, mainWindowOpenAtQuit: true) == .none)
    check("the login-item launch event is recognised, and nothing else is",
          AppRules.isLoginLaunch(
              eventID: AEEventID(kAEOpenApplication), propData: OSType(keyAELaunchedAsLogInItem))
          && !AppRules.isLoginLaunch(eventID: AEEventID(kAEOpenApplication), propData: nil)
          && !AppRules.isLoginLaunch(eventID: nil, propData: nil))
    do {
        let (r, w, o, m) = router(signedIn: true)
        r.reopen()
        let mainFirst = w.opens == [true] && o.opens == 0
        m.onboardingWindowOpen = true
        r.reopen()
        check("a Dock click or reopen shows the main window, or onboarding while it is open",
              mainFirst && w.opens == [true] && o.opens == 1)
    }
    do {
        let (r, w, _, _) = router(signedIn: true)
        var hidden = 0
        r.hideApp = { hidden += 1 }
        r.handleHotKey()
        let raised = w.opens == [true] && hidden == 0
        w.isFrontmost = true
        r.handleHotKey()
        check("⌥⌘K raises and focuses the window; when it is already frontmost it hides Klorn",
              raised && w.opens == [true] && hidden == 1
              && AppRules.hotKeyAction(mainWindowFrontmost: false) == .raise
              && AppRules.hotKeyAction(mainWindowFrontmost: true) == .hide)
    }
    let app = text("KlornApp.swift")
    check("closing the main window keeps Klorn running; ⌘Q is the way to quit",
          !AppRules.terminatesAfterLastWindowClosed
          && app.contains("AppRules.terminatesAfterLastWindowClosed")
          && text("MainWindow.swift").contains("window.isReleasedWhenClosed = false"))
    check("a Dock reopen, the hotkey and banner taps all route through WindowRouter",
          app.contains("router?.reopen()")
          && app.contains("router?.handleHotKey()")
          && app.contains("router?.handleNotificationTap(identifier: identifier)"))
    check("whether the window was open is recorded at quit, for the next login launch",
          app.contains("model.settings.mainWindowOpenAtQuit = model.mainWindowOpen"))

    // MARK: PUSH notifications — dedupe and first-sync suppression
    func push(_ id: String, from: String = "Boss <boss@co.example>", subject: String = "invoice due")
        -> FirewallItem
    {
        let json = #"{"id":"\#(id)","source":"email","sourceId":"\#(id)","type":"email","title":"t","tier":"PUSH","priority":9,"surfacedAt":"2026-10-15T08:00:00Z","email":{"emailDbId":"d-\#(id)","subject":"\#(subject)","from":"\#(from)","snippet":"the private body text"},"hashStale":false}"#
        return try! JSONDecoder().decode(FirewallItem.self, from: Data(json.utf8))
    }
    let first = PushLedger.fresh(owner: "u1").plan(pushItems: [push("a"), push("b")])
    check("the first sync for an account is a silent baseline",
          first.toNotify.isEmpty && first.next.baselineEstablished && first.next.notified == ["a", "b"])
    let second = first.next.plan(pushItems: [push("a"), push("b"), push("c")])
    check("only PUSH mail never announced before gets a banner",
          second.toNotify.map(\.id) == ["c"] && second.next.notified == ["a", "b", "c"])
    check("the same lane again announces nothing",
          second.next.plan(pushItems: [push("a"), push("b"), push("c")]).toNotify.isEmpty)
    check("a duplicate id within one sync is announced once",
          second.next.plan(pushItems: [push("d"), push("d")]).toNotify.map(\.id) == ["d"])
    // Relaunch: the ledger outlives the process.
    let store = InMemoryPushLedgerStore()
    store.save(second.next)
    let relaunched = PushLedger.resolve(stored: store.load(), owner: "u1")
    check("after a relaunch, already-announced mail stays quiet",
          relaunched.plan(pushItems: [push("a"), push("b"), push("c")]).toNotify.isEmpty)
    check("after a relaunch, PUSH mail that arrived while Klorn was quit is announced",
          relaunched.plan(pushItems: [push("a"), push("e")]).toNotify.map(\.id) == ["e"])
    check("another account's ledger is never reused: it starts a silent baseline",
          PushLedger.resolve(stored: store.load(), owner: "u2")
              .plan(pushItems: [push("z")]).toNotify.isEmpty)
    let flood = (1...8).map { push("f\($0)") }
    let floodPlan = relaunched.plan(pushItems: flood)
    check("a burst is capped at \(PushLedger.maxBannersPerSync) banners, and the rest are still recorded",
          floodPlan.toNotify.count == PushLedger.maxBannersPerSync
          && flood.allSatisfy { floodPlan.next.notified.contains($0.id) })
    let huge = PushLedger(owner: "u1", baselineEstablished: true,
                          notified: (0..<PushLedger.cap).map { "old\($0)" })
    let trimmed = huge.plan(pushItems: [push("new")]).next.notified
    check("the ledger keeps the newest \(PushLedger.cap) ids",
          trimmed.count == PushLedger.cap && trimmed.last == "new" && trimmed.first == "old1")
    // The real persistence, on a throwaway defaults suite (never the app's).
    let suiteName = "klorn.selfcheck.pushledger.\(UUID().uuidString)"
    if let suite = UserDefaults(suiteName: suiteName) {
        let defaultsStore = UserDefaultsPushLedgerStore(defaults: suite)
        defaultsStore.save(second.next)
        let roundTrip = UserDefaultsPushLedgerStore(defaults: suite).load()
        defaultsStore.clear()
        check("the ledger round-trips through UserDefaults and clears",
              roundTrip == second.next && defaultsStore.load() == nil)
        suite.removePersistentDomain(forName: suiteName)
    } else {
        check("the ledger round-trips through UserDefaults and clears", false)
    }
    // End to end through the model's own load path, on stubbed network.
    typealias Stub = SessionStubProtocol
    typealias S = SessionScenarios
    func lane(_ ids: [String]) -> String {
        let items = ids.map { id in
            #"{"id":"\#(id)","source":"email","sourceId":"\#(id)","type":"email","title":"t","tier":"PUSH","priority":9,"surfacedAt":"2026-10-15T08:00:00Z","email":{"emailDbId":"d-\#(id)","subject":"s","from":"a@a.example"},"hashStale":false}"#
        }.joined(separator: ",")
        return #"{"tiers":{"PUSH":[\#(items)],"MEETING":[],"QUEUE":[],"INFO":[],"SILENT":[]},"summary":{"PUSH":\#(ids.count),"MEETING":0,"QUEUE":0,"INFO":0,"SILENT":0,"AUTO":0,"total":\#(ids.count)}}"#
    }
    let live = S.model([S.firewall: .init(body: lane(["p1"]))])
    var announced: [[String]] = []
    live.onNewPush = { announced.append($0.map(\.id)) }
    await live.loadQueue()
    Stub.set(S.firewall, .init(body: lane(["p1", "p2"])))
    await live.loadQueue()
    await live.loadQueue()
    check("the model's load path: silent first sync, one announcement per new PUSH",
          announced == [["p2"]])
    live.signOut()
    check("sign-out forgets the ledger (the next account starts a silent baseline)",
          live.pushLedgerStore.load() == nil)

    // MARK: banners — content, the switch, the permission seam
    let alertModel = AppModel(tokenStore: InMemoryTokenStore())
    let fake = FakePushNotifier()
    alertModel.pushNotifier = fake
    var spoken: [String] = []
    let alerter = PushAlerter(model: alertModel, announce: { spoken.append($0) })
    alertModel.settings.notificationsEnabled = true
    alerter.handleNewPush([push("x1", from: "Kim &amp; Co <kim@co.example>", subject: "Q4 &amp; budget")])
    let banner = fake.posted.first
    check("a banner names the sender and the subject, and carries no body text",
          fake.posted.count == 1 && banner?.title == "Kim & Co" && banner?.body == "Q4 & budget"
          && !(banner?.body.contains("private body") ?? true)
          && banner?.identifier == PushNotifier.notificationIdentifier(for: "x1"))
    check("SystemPushNotifier sets title and body only (no snippet, no actions)",
          !text("Notifications.swift").contains("snippet")
          && !text("Notifications.swift").contains("UNNotificationAction")
          && !text("Notifications.swift").contains("categoryIdentifier"))
    alertModel.settings.notificationsEnabled = false
    alerter.handleNewPush([push("x2")])
    check("Settings ▸ Notifications OFF posts no banner, but VoiceOver still hears it",
          fake.posted.count == 1 && spoken.count == 2)
    alertModel.settings.notificationsEnabled = true
    alerter.handleNewPush([])
    check("nothing new: no banner and no announcement", fake.posted.count == 1 && spoken.count == 2)
    check("the app wires new PUSH to the alerter, which posts through the model's seam",
          app.contains("model.onNewPush = { [weak alerter] items in alerter?.handleNewPush(items) }")
          && text("Notifications.swift").contains("model.pushNotifier.post($0)"))
    check("the permission request goes through the seam, once a session is active",
          text("AppModel.swift").contains("await self.pushNotifier.requestAuthorization()")
          && users(of: "requestAuthorization(options:").sorted() == ["Notifications.swift"])
    check("UNUserNotificationCenter is touched only by the notifier and the tap delegate",
          users(of: "UNUserNotificationCenter.current()") == ["KlornApp.swift", "Notifications.swift"])
    check("the Settings hint points to System Settings only when macOS denied banners",
          NotificationHint.showsDeniedHint(.denied)
          && ![NotificationPermission.authorized, .notDetermined, .unavailable]
              .contains(where: NotificationHint.showsDeniedHint)
          && NotificationHint.systemSettingsURL.scheme == "x-apple.systempreferences"
          && text("PreferencesView.swift").contains("await model.refreshNotificationPermission()"))
    check("macOS permission states map onto ours",
          PushNotifier.permission(for: .denied) == .denied
          && PushNotifier.permission(for: .authorized) == .authorized
          && PushNotifier.permission(for: .provisional) == .authorized
          && PushNotifier.permission(for: .notDetermined) == .notDetermined)

    // MARK: notification click routing
    do {
        let (r, w, _, m) = router(signedIn: true)
        m.seedForPreview(firewallJSON: lane(["p1"]), emailJSON: "", selectedItemId: nil)
        m.navigate(to: .today)
        r.handleNotificationTap(identifier: PushNotifier.notificationIdentifier(for: "p1"))
        let openedLive = w.opens == [true] && m.mainNav.section == .mail
        r.handleNotificationTap(identifier: PushNotifier.notificationIdentifier(for: "gone"))
        let openedGone = w.opens == [true, true]
        r.handleNotificationTap(identifier: "com.other.app-1")
        check("a banner tap opens the main window on that mail in Mail",
              openedLive)
        check("a tap on mail no longer in the queue still opens the main window",
              openedGone)
        check("another app's notification is never claimed", w.opens.count == 2)
    }

    // MARK: every item that only the panel had has a home
    let prefs = text("PreferencesView.swift")
    check("sign out → Settings ▸ Accounts", prefs.contains("model.signOut()"))
    check("reconnect Google → Settings ▸ Accounts", prefs.contains("await model.reconnectPrimary()"))
    check("add Google account → Settings ▸ Accounts", prefs.contains("await model.addAccount()"))
    check("today's AI usage meter → Settings ▸ Accounts",
          prefs.contains("AIUsageMeter(used: usage.dailyUsed, cap: usage.dailyCap)")
          && users(of: "AIUsageMeter(") == ["PreferencesView.swift"])
    check("app management & support → Settings ▸ General ▸ App & support",
          prefs.contains("SupportSection()")
          && SettingsTab.general.sections.contains(.support)
          && ["openSupportMail()", "AppRestart.relaunch()", "await model.runDiagnostics()",
              "DiagnosticsBlock()", "UpdateRow(version: version)"]
              .allSatisfy { text("SupportTools.swift").contains($0) })
    check("check for updates → Settings ▸ General (Updates row)",
          prefs.contains("await UpdateCheck.run()"))
    check("briefing card → main window ▸ Assistant",
          users(of: "BriefingCard(briefing:") == ["AssistantSection.swift", "BriefingCard.swift"]
          && text("BriefingCard.swift").contains("struct BriefingCardRenderProbe"))
    check("recent PUSH → main window ▸ Mail's PUSH lane, plus the banners",
          LaneFilter.allCases.compactMap(\.tier).contains(.push)
          && text("WindowRouter.swift").contains("self.model.showTier(tier)"))
    check("Settings → the sidebar footer and ⌘,",
          text("NavSidebar.swift").contains("Button(action: actions.onOpenPreferences)"))
    check("the support tools' strings are still localized",
          ["account.maintenance", "menu.restart", "menu.diagnostics", "menu.contactSupport",
           "account.reconnectPrimary", "section.aiToday", "prefs.section.support"]
              .allSatisfy { L($0) != $0 })

    // MARK: retired settings
    let settingsSuite = "klorn.selfcheck.settings.\(UUID().uuidString)"
    if let suite = UserDefaults(suiteName: settingsSuite) {
        suite.set(false, forKey: "macMainWindow")
        suite.set(true, forKey: "klorn.pillVisible")
        suite.set(true, forKey: "klorn.showInDock")
        _ = AppSettings(defaults: suite)
        check("stored values of the retired settings are ignored and removed",
              AppSettings.retiredKeys.allSatisfy { suite.object(forKey: $0) == nil })
        suite.removePersistentDomain(forName: settingsSuite)
    } else {
        check("stored values of the retired settings are ignored and removed", false)
    }
    check("the main-window switch is gone from Settings",
          !prefs.contains("MainWindowToggle") && !text("MainWindow.swift").contains("MainWindowToggle"))

    // MARK: no floating Klorn surfaces (meeting card removed too)
    // Type scan: the only windows the app may create are the main window
    // (and its sheets), onboarding and compose; Settings is the SwiftUI
    // scene. No NSPanel, no floating level, no all-Spaces overlay.
    var windowMakers: Set<String> = []
    var floatingOffenders: Set<String> = []
    for url in shipping {
        let source = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        let name = url.lastPathComponent
        if source.contains("NSWin" + "dow(") || source.contains(": NS" + "Window {")
            || source.contains("NSPanel")
        {
            windowMakers.insert(name)
        }
        if ["NSPanel", ".floating", "isFloatingPanel", "canJoinAllSpaces",
            "nonactivatingPanel", "orderFrontRegardless"].contains(where: source.contains)
        {
            floatingOffenders.insert(name)
        }
    }
    check("only the main, onboarding and compose windows are ever created (Settings is a scene)",
          windowMakers == ["MainWindow.swift", "OnboardingWindow.swift", "ComposeWindow.swift"])
    check("no NSPanel, floating level or all-Spaces overlay anywhere", floatingOffenders.isEmpty)
    if !floatingOffenders.isEmpty { print("    floating: \(floatingOffenders.sorted())") }
    check("the meeting card files are gone",
          !shipping.contains { ["MeetingCard.swift", "MeetingCardController.swift"].contains($0.lastPathComponent) }
          && users(of: "MeetingCard").isEmpty && users(of: "GlassPanel").isEmpty)

    // MARK: meeting banners
    let meetingStartISO = "2026-10-15T09:10:00Z"
    let meetingNow = ISO8601DateFormatter().date(from: "2026-10-15T09:02:00Z")!
    let standup = CalendarEventWire(
        id: "ev-9",
        title: "Standup", startTime: meetingStartISO, endTime: "2026-10-15T09:30:00Z",
        location: "Room 4", meetingLink: "https://meet.example/x", allDay: false)
    let meetingBanner = MeetingBanner.make(for: standup, now: meetingNow, time: { _ in "9:10" })
    check("a meeting banner says the title and start time, and the minutes left",
          meetingBanner.title == "Standup · 9:10"
          && meetingBanner.body == L("meeting.banner.body", 8)
          && meetingBanner.identifier == PushNotifier.meetingIdentifier(for: "ev-9"))
    check("a meeting banner carries no location, link or description",
          !meetingBanner.body.contains("Room") && !meetingBanner.body.contains("http")
          && !meetingBanner.title.contains("Room"))
    let meetingModel = AppModel(tokenStore: InMemoryTokenStore())
    let meetingFake = FakePushNotifier()
    meetingModel.pushNotifier = meetingFake
    let meetingAlerter = PushAlerter(model: meetingModel, announce: { _ in })
    meetingModel.settings.notificationsEnabled = true
    let handledOn = meetingAlerter.handleMeetingSoon(standup, now: meetingNow)
    meetingModel.settings.notificationsEnabled = false
    let handledOff = meetingAlerter.handleMeetingSoon(standup, now: meetingNow)
    meetingModel.settings.notificationsEnabled = true
    check("the banner switch gates meeting banners too; a muted one is still handled once",
          handledOn && handledOff && meetingFake.posted.map(\.identifier) == [meetingBanner.identifier])
    let meetingLedger = PushLedger.fresh(owner: "u1").recording("ev-9")
    check("each meeting is announced once per account, across launches",
          meetingAlertPlan(now: meetingNow, events: [standup], leadMinutes: 10,
                           shown: Set(meetingLedger.notified)) == nil
          && meetingAlertPlan(now: meetingNow, events: [standup], leadMinutes: 10, shown: [])?.id == "ev-9"
          && meetingLedger.recording("ev-9").notified == ["ev-9"]
          && UserDefaultsPushLedgerStore.meetingKey != UserDefaultsPushLedgerStore.key)
    check("the meeting ledger is saved only after the banner is handled, and the Meetings category gates it",
          text("AppModel.swift").contains("onMeetingSoon?(due) == true\n        {\n            meetingAlertStore.save(announced.recording(due.id))")
          && text("AppModel.swift").contains("if automation.allowsInterrupt(for: .meeting),")
          && app.contains("model.onMeetingSoon = { [weak alerter] event in alerter?.handleMeetingSoon(event) ?? false }"))
    check("a meeting banner tap opens the main window on Calendar",
          PushNotifier.tapAction(identifier: PushNotifier.meetingIdentifier(for: "ev-9"), isKnownItem: { _ in true })
              == .openMeeting(eventID: "ev-9"))
    do {
        let (r, w, _, m) = router(signedIn: true)
        m.navigate(to: .today)
        r.handleNotificationTap(identifier: PushNotifier.meetingIdentifier(for: "ev-9"))
        check("routing a meeting tap: window opened, Calendar showing",
              w.opens == [true] && m.mainNav.section == .calendar)
    }
    do {
        let signedOutModel = AppModel(tokenStore: InMemoryTokenStore(token: "t"))
        signedOutModel.signOut()
        check("sign-out forgets the meeting ledger", signedOutModel.meetingAlertStore.load() == nil)
    }

    // MARK: strings
    let newKeys = ["push.announce", "prefs.section.support", "prefs.banners.denied",
                   "prefs.banners.openSystemSettings", "meeting.banner.body"]
    check("new strings exist in every locale",
          ["en", "ko", "de", "es", "fr", "ja", "zh"].allSatisfy { locale in
              let strings = (try? String(
                  contentsOf: sourceDir.appendingPathComponent("Resources/\(locale).lproj/Localizable.strings"),
                  encoding: .utf8)) ?? ""
              return newKeys.allSatisfy { strings.contains("\"\($0)\" = ") }
          })
    check("the announcement count renders as an integer",
          L("push.announce", 4).contains("4") && !L("push.announce", 4).contains("%"))
    return results
}
