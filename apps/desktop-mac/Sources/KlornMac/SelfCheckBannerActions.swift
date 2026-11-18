import Foundation
import UserNotifications

// Self-check for banner action buttons and the NT3 banner layout
// (founder decision 2026-11-17), run by `KlornMac --self-check`.
//
// A mail banner reads sender / subject / reason and offers Reply, Later and
// Done on hover. Reply only brings Klorn forward on that mail with the
// composer open: nothing is sent from a notification, the user sees the
// whole draft before Send. Later and Done run in the background through the
// same API paths the app uses. A meeting reminder offers Join only when the
// event already carries a safe https link.
//
// Nothing here posts a banner or touches the notification center: categories
// and content are built and inspected, responses are routed through the pure
// rules and a router on a stubbed network.

@MainActor
func bannerActionSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ cond: Bool) { results.append((name, cond)) }
    func text(_ file: String) -> String {
        (try? String(contentsOf: sourceDir.appendingPathComponent(file), encoding: .utf8)) ?? ""
    }
    func item(_ id: String, _ tier: String, from: String = "Kim &amp; Co <kim@co.example>",
              subject: String = "Q4 budget", reason: String? = "asks you to sign today") -> FirewallItem {
        let why = reason.map { #","tierReason":"\#($0)""# } ?? ""
        let json = #"{"id":"\#(id)","source":"email","sourceId":"\#(id)","type":"email","title":"t","tier":"\#(tier)","priority":9,"surfacedAt":"2026-11-17T08:00:00Z"\#(why),"email":{"emailDbId":"d-\#(id)","subject":"\#(subject)","from":"\#(from)"},"hashStale":false}"#
        return try! JSONDecoder().decode(FirewallItem.self, from: Data(json.utf8))
    }

    // MARK: categories registered at launch

    let categories = BannerActions.categories()
    let mail = categories.first { $0.identifier == BannerCategory.mail.rawValue }
    let join = categories.first { $0.identifier == BannerCategory.meetingJoin.rawValue }
    check("two categories: mail (Reply, Later, Done) and meeting join (Join)",
          categories.count == 2
          && mail?.actions.map(\.identifier) == [BannerAction.reply, .later, .done].map(\.rawValue)
          && join?.actions.map(\.identifier) == [BannerAction.join.rawValue])
    check("Reply brings Klorn forward; Later, Done and Join run in the background",
          mail?.actions.first?.options.contains(.foreground) == true
          && mail?.actions.dropFirst().allSatisfy { !$0.options.contains(.foreground) } == true
          && join?.actions.first?.options.contains(.foreground) == false)
    check("no button sends anything: no text-input reply action exists",
          !categories.flatMap(\.actions).contains { $0 is UNTextInputNotificationAction }
          && !text("Notifications.swift").contains("UNTextInputNotificationAction")
          && !text("BannerActions.swift").contains("UNTextInputNotificationAction"))
    check("button titles are localized strings",
          mail?.actions.map(\.title) == [L("banner.action.reply"), L("banner.action.later"), L("banner.action.done")]
          && join?.actions.first?.title == L("banner.action.join"))
    let ko = text("Resources/ko.lproj/Localizable.strings")
    let en = text("Resources/en.lproj/Localizable.strings")
    check("Korean buttons read 답장 / 나중에 / 완료 / 참가; English Reply / Later / Done / Join",
          ko.contains(#""banner.action.reply" = "답장";"#) && ko.contains(#""banner.action.later" = "나중에";"#)
          && ko.contains(#""banner.action.done" = "완료";"#) && ko.contains(#""banner.action.join" = "참가";"#)
          && en.contains(#""banner.action.reply" = "Reply";"#) && en.contains(#""banner.action.later" = "Later";"#)
          && en.contains(#""banner.action.done" = "Done";"#) && en.contains(#""banner.action.join" = "Join";"#))
    let newKeys = ["banner.action.reply", "banner.action.later", "banner.action.done",
                   "banner.action.join", "meeting.banner.soon", "meeting.provider.meet",
                   "meeting.provider.zoom", "meeting.provider.teams", "meeting.provider.webex"]
    check("the new strings exist in every locale; the retired meeting body is gone",
          ["en", "ko", "de", "es", "fr", "ja", "zh"].allSatisfy { locale in
              let strings = text("Resources/\(locale).lproj/Localizable.strings")
              return newKeys.allSatisfy { strings.contains("\"\($0)\" = ") }
                  && !strings.contains("\"meeting.banner.body\" = ")
          })
    check("the categories are registered once at launch, through the notifier",
          text("KlornApp.swift").contains("SystemPushNotifier.registerCategories()")
          && text("Notifications.swift").contains(
              "UNUserNotificationCenter.current().setNotificationCategories(BannerActions.categories())"))

    // MARK: the mail banner (NT3): sender / subject / reason

    let push = PushBanner.make(for: item("p1", "PUSH"))
    check("a mail banner: title = sender name, subtitle = subject, body = the reason line",
          push.title == "Kim & Co" && push.subtitle == "Q4 budget" && push.body == "asks you to sign today")
    let verifiedJSON = #"{"notifications":[{"id":"r1","type":"email","sourceEmailId":"d-p1","createdAt":"2026-11-17T08:00:00Z","reason":{"text":"Sign","verified":true,"quote":"Please sign by 5pm","quoteIn":"body"}}]}"#
    let verified = (try? JSONDecoder().decode(NotificationsResponse.self, from: Data(verifiedJSON.utf8)))?
        .notifications.first
    check("a verified quote is the body, in curly quotes",
          PushBanner.make(for: item("p1", "PUSH"), row: verified).body == "“Please sign by 5pm”")
    let bare = PushBanner.make(for: item("p2", "PUSH", reason: nil))
    check("no reason: the subject is the body and there is no subtitle (never an empty banner)",
          bare.subtitle == nil && bare.body == "Q4 budget")
    check("an address-only sender is titled with the address, never with contact tags",
          PushBanner.make(for: item("p3", "PUSH", from: "kim@co.example")).title == "kim@co.example"
          && !push.title.contains("auto-added") && !push.title.contains("<"))
    let meetingMail = PushBanner.make(for: item("m1", "MEETING"))
    check("a MEETING-lane mail keeps its lane name ahead of the subject",
          meetingMail.subtitle == "\(Tier.meeting.label) · Q4 budget" && meetingMail.body == "asks you to sign today"
          && PushBanner.make(for: item("m2", "MEETING", reason: nil)).subtitle == Tier.meeting.label)
    check("mail banners carry the mail category, their own thread and the mail id",
          push.category == .mail && meetingMail.category == .mail
          && push.thread == PushNotifier.mailThreadIdentifier(for: "d-p1")
          && push.userInfo == [BannerActions.emailIDKey: "d-p1"])
    let content = SystemPushNotifier.content(for: push, entitled: false)
    check("the posted content carries the category, thread, subtitle and mail id",
          content.categoryIdentifier == BannerCategory.mail.rawValue
          && content.threadIdentifier == "klorn-mail-d-p1"
          && content.subtitle == "Q4 budget" && content.body == "asks you to sign today"
          && content.userInfo[BannerActions.emailIDKey] as? String == "d-p1")
    let summary = BannerBatch.moreSummary(for: (1...3).map { item("s\($0)", "PUSH") })
    let held = HeldBanners.summaryBanner(for: [item("h1", "PUSH"), item("h2", "PUSH")])
    check("summaries have no buttons, share one summary thread and carry no ids",
          [summary, held].allSatisfy {
              $0.category == nil && $0.thread == PushNotifier.threadIdentifier && $0.userInfo.isEmpty
          }
          && SystemPushNotifier.content(for: summary, entitled: true).categoryIdentifier.isEmpty)

    // MARK: the meeting reminder

    let now = ISO8601DateFormatter().date(from: "2026-11-17T09:02:00Z")!
    func event(_ link: String?) -> CalendarEventWire {
        let name = "Standup"
        return CalendarEventWire(id: "ev-1", title: name, startTime: "2026-11-17T09:10:00Z",
                          endTime: "2026-11-17T09:30:00Z", location: "Room 4", meetingLink: link, allDay: false)
    }
    let meet = MeetingBanner.make(for: event("https://meet.google.com/abc-defg-hij"), now: now)
    check("a meeting reminder: title = event title, body = minutes · provider",
          meet.title == "Standup"
          && meet.body == L("meeting.banner.soon", 8) + " · " + L("meeting.provider.meet")
          && !meet.body.contains("http") && !meet.body.contains("Room"))
    check("a safe join link gives the Join button and travels with the banner",
          meet.category == .meetingJoin
          && meet.userInfo == [BannerActions.meetingLinkKey: "https://meet.google.com/abc-defg-hij"]
          && meet.thread == PushNotifier.meetingThreadIdentifier)
    let noLink = MeetingBanner.make(for: event(nil), now: now)
    let unsafe = MeetingBanner.make(for: event("http://meet.google.com/x"), now: now)
    check("no link, or one that is not safe https: no buttons, no link, minutes only",
          [noLink, unsafe].allSatisfy { $0.category == nil && $0.userInfo.isEmpty }
          && noLink.body == L("meeting.banner.soon", 8) && unsafe.body == L("meeting.banner.soon", 8))
    check("an imminent meeting is Time Sensitive",
          meet.interruption == .timeSensitive && noLink.interruption == .timeSensitive)
    check("providers are named from the link's host only",
          MeetingProvider.name(for: URL(string: "https://us02web.zoom.us/j/1")!) == L("meeting.provider.zoom")
          && MeetingProvider.name(for: URL(string: "https://teams.microsoft.com/l/x")!) == L("meeting.provider.teams")
          && MeetingProvider.name(for: URL(string: "https://evilmeet.google.com.example/x")!) == nil
          && MeetingProvider.name(for: URL(string: "https://example.com/meet.google.com")!) == nil)
    check("the minutes render as an integer", !L("meeting.banner.soon", 8).contains("%")
          && L("meeting.banner.soon", 8).contains("8"))

    // MARK: routing a response (pure)

    let pushID = PushNotifier.notificationIdentifier(for: "p1")
    let meetingID = PushNotifier.meetingIdentifier(for: "ev-1")
    let mailInfo = [BannerActions.emailIDKey: "d-p1"]
    func route(_ id: String, _ action: String, _ info: [String: String] = [:]) -> NotificationResponseAction {
        PushNotifier.responseAction(identifier: id, actionIdentifier: action, info: info, isKnownItem: { $0 == "p1" })
    }
    check("the banner body itself still routes as a tap",
          route(pushID, UNNotificationDefaultActionIdentifier, mailInfo) == .tap(.open(itemID: "p1"))
          && route(meetingID, UNNotificationDefaultActionIdentifier) == .tap(.openMeeting(eventID: "ev-1")))
    check("Reply, Later and Done on a mail banner name that mail",
          route(pushID, BannerAction.reply.rawValue, mailInfo) == .reply(itemID: "p1")
          && route(pushID, BannerAction.later.rawValue, mailInfo) == .later(itemID: "p1", emailID: "d-p1")
          && route(pushID, BannerAction.done.rawValue, mailInfo) == .done(itemID: "p1"))
    check("a Later without a usable mail id falls back to opening the mail",
          route(pushID, BannerAction.later.rawValue) == .tap(.open(itemID: "p1"))
          && route(pushID, BannerAction.later.rawValue, [BannerActions.emailIDKey: "../x"]) == .tap(.open(itemID: "p1"))
          && route(pushID, BannerAction.later.rawValue, [BannerActions.emailIDKey: String(repeating: "a", count: 129)])
              == .tap(.open(itemID: "p1")))
    check("Join opens the re-checked https link; anything else opens Calendar",
          route(meetingID, BannerAction.join.rawValue, [BannerActions.meetingLinkKey: "https://meet.google.com/a"])
              == .join(URL(string: "https://meet.google.com/a")!)
          && route(meetingID, BannerAction.join.rawValue, [BannerActions.meetingLinkKey: "javascript:alert(1)"])
              == .tap(.openMeeting(eventID: "ev-1"))
          && route(meetingID, BannerAction.join.rawValue) == .tap(.openMeeting(eventID: "ev-1")))
    check("a button on the wrong kind, or on another app's notification, is only a tap",
          route(meetingID, BannerAction.done.rawValue) == .tap(.openMeeting(eventID: "ev-1"))
          && route(pushID, BannerAction.join.rawValue, [BannerActions.meetingLinkKey: "https://meet.google.com/a"])
              == .tap(.open(itemID: "p1"))
          && route("someone-else-1", BannerAction.done.rawValue) == .tap(.ignore)
          && route(PushNotifier.moreIdentifier(for: "p1"), BannerAction.done.rawValue) == .tap(.openToday))
    check("a userInfo dictionary is read as strings only",
          BannerActions.stringInfo([BannerActions.emailIDKey: "d-1", "n": 3, 4: "x"]) == [BannerActions.emailIDKey: "d-1"])

    // MARK: the router, on a stubbed network

    typealias Stub = SessionStubProtocol
    let later = "POST /api/email/d-p1/later"
    let dismiss = "POST /api/inbox/firewall/p1/dismiss"
    func signedInRouter(_ replies: [String: Stub.Reply] = [:]) async -> (WindowRouter, FakeMainWindow, AppModel) {
        let model = SessionScenarios.model([SessionScenarios.firewall: .init(body: SessionScenarios.pushQueue)]
            .merging(replies) { $1 })
        await model.loadQueue()
        let window = FakeMainWindow()
        let router = WindowRouter(model: model, mainWindow: window)
        router.onboarding = FakeOnboarding()
        return (router, window, model)
    }
    do {
        let (r, w, m) = await signedInRouter()
        r.handleNotificationResponse(identifier: pushID, actionIdentifier: BannerAction.reply.rawValue, info: mailInfo)
        let selected = await SessionScenarios.waitUntil { m.selectedItemId == "p1" }
        check("Reply opens that mail in the main window and asks for the composer — nothing is sent",
              selected && w.opens == [true] && m.replyRequest?.itemId == "p1"
              && Stub.calls.allSatisfy { !$0.path.hasPrefix("/api/email/send") })
    }
    do {
        let (r, w, _) = await signedInRouter()
        r.handleNotificationResponse(identifier: pushID, actionIdentifier: BannerAction.later.rawValue, info: mailInfo)
        let sent = await SessionScenarios.waitUntil { Stub.calls(later).count == 1 }
        check("Later sets the web's later-today reminder in the background", sent && w.opens.isEmpty)
    }
    do {
        let (r, w, m) = await signedInRouter([later: .init(status: 500, body: #"{"error":"could not set the reminder"}"#)])
        r.handleNotificationResponse(identifier: pushID, actionIdentifier: BannerAction.later.rawValue, info: mailInfo)
        let shown = await SessionScenarios.waitUntil { m.actionError != nil && !w.opens.isEmpty }
        check("a failed Later is shown: the window opens with the error notice", shown)
    }
    do {
        let (r, w, m) = await signedInRouter()
        r.handleNotificationResponse(identifier: pushID, actionIdentifier: BannerAction.done.rawValue, info: mailInfo)
        let sent = await SessionScenarios.waitUntil { Stub.calls(dismiss).count == 1 }
        check("a Done clears the mail through the app's own dismiss, in the background",
              sent && w.opens.isEmpty && m.queue?.item(id: "p1") == nil && m.actionError == nil)
    }
    do {
        let (r, w, m) = await signedInRouter([dismiss: .init(status: 500, body: "{}")])
        r.handleNotificationResponse(identifier: pushID, actionIdentifier: BannerAction.done.rawValue, info: mailInfo)
        let shown = await SessionScenarios.waitUntil {
            m.actionError != nil && !w.opens.isEmpty && m.queue?.item(id: "p1") != nil
        }
        check("a failed Done is shown and the mail comes back", shown && Stub.calls(dismiss).count == 1)
    }
    do {
        let model = SessionScenarios.model(token: nil)
        let window = FakeMainWindow()
        let onboarding = FakeOnboarding()
        let router = WindowRouter(model: model, mainWindow: window)
        router.onboarding = onboarding
        router.handleNotificationResponse(identifier: pushID, actionIdentifier: BannerAction.done.rawValue, info: mailInfo)
        try? await Task.sleep(for: .milliseconds(50))
        check("signed out, a button calls nothing and opens Klorn instead",
              Stub.calls.isEmpty && (onboarding.opens + window.opens.count) == 1)
    }
    do {
        let (r, w, _) = await signedInRouter()
        var opened: [URL] = []
        r.openURL = { opened.append($0) }
        r.handleNotificationResponse(
            identifier: meetingID, actionIdentifier: BannerAction.join.rawValue,
            info: [BannerActions.meetingLinkKey: "https://meet.google.com/abc"])
        check("a Join opens the meeting link and nothing else", opened == [URL(string: "https://meet.google.com/abc")!]
              && w.opens.isEmpty)
    }
    check("the delegate hands every response, with its button and ids, to the router",
          text("KlornApp.swift").contains("self?.router?.handleNotificationResponse(")
          && text("KlornApp.swift").contains("BannerActions.stringInfo(response.notification.request.content.userInfo)"))
    return results
}
