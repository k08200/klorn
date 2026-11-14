import Foundation

// Self-check for the toolbar bell's notification center (NC2-A, founder
// decision 2026-11-13) and the mail banner's words (N1), run by
// `KlornMac --self-check`. Network is the Files stub URLProtocol; nothing
// reaches a server, no window opens, no banner posts.

@MainActor
func notificationCenterSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ cond: Bool) { results.append(("notification center — \(name)", cond)) }
    func text(_ file: String) -> String {
        (try? String(contentsOf: sourceDir.appendingPathComponent(file), encoding: .utf8)) ?? ""
    }
    func rows(_ json: String) -> [NotificationWire] {
        (try? JSONDecoder().decode(NotificationsResponse.self, from: Data(json.utf8)))?.notifications ?? []
    }
    func row(_ fields: String) -> NotificationWire? {
        rows(#"{"notifications":[{"id":"r","createdAt":"2026-07-29T08:00:00Z",\#(fields)}]}"#).first
    }

    // MARK: decoding — with and without the optional contract

    let today = rows(#"""
    {"notifications":[{"id":"a","type":"email","title":"t","message":"m","isRead":false,"link":null,
      "conversationId":null,"sourceEmailId":"d1","pendingActionId":null,"pendingActionStatus":null,
      "createdAt":"2026-07-29T08:00:00.000Z"}],"count":1,"unread":1}
    """#)
    check("today's server shape decodes; the optional fields read as absent",
          today.count == 1 && today[0].lane == nil && today[0].reason == nil && !today[0].held
          && today[0].group == nil && today[0].deliveredTo.isEmpty && today[0].sourceEmailId == "d1")
    let fixture = rows(PreviewRender.notificationFixtureJSON)
    check("the full contract decodes (lane, reason, held, group, deliveredTo)",
          fixture.count == 7 && fixture[0].lane == .push && fixture[0].reason?.verified == true
          && fixture[0].reason?.quoteIn == "body" && fixture[1].held
          && fixture[4].group == .reply && fixture[0].deliveredTo == ["mac", "chrome"])
    let odd = rows(#"""
    {"notifications":[
      {"id":"x","type":"email","lane":"LOUD","group":"someday","held":"yes","reason":"plain","deliveredTo":"mac"},
      {"type":"email","title":"no id"},
      {"id":"y","lane":"meeting","group":"LATER","deliveredTo":["mac",7,{"a":1}],"reason":{"verified":"x","text":5}}]}
    """#)
    check("a shape this build cannot read drops the field, never the list; a row without an id drops alone",
          odd.count == 2 && odd[0].lane == nil && odd[0].group == nil && !odd[0].held && odd[0].reason == nil
          && odd[0].deliveredTo == ["mac"] && odd[1].lane == .meeting && odd[1].group == .later
          && odd[1].deliveredTo == ["mac"] && odd[1].reason?.verified == false && odd[1].reason?.text == nil)
    check("a missing title, message or read flag defaults instead of failing",
          row(#""type":"briefing""#).map { $0.title.isEmpty && $0.message.isEmpty && !$0.isRead } == true)
    func delivery(_ json: String) -> [String]? {
        (try? JSONDecoder().decode(NotificationDelivery.self, from: Data(json.utf8)))?.channels
    }
    check("the lazy delivery read accepts an object list, a string list or a bare array",
          delivery(#"{"deliveredTo":["mac","chrome"]}"#) == ["mac", "chrome"]
          && delivery(#"{"channels":[{"channel":"mac"},{"name":"phone"},{"x":1}]}"#) == ["mac", "phone"]
          && delivery(#"[{"kind":"telegram"},"web"]"#) == ["telegram", "web"]
          && delivery(#"{"other":true}"#) == [])
    let health = try? JSONDecoder().decode(
        AlertChannelHealth.self, from: Data(PreviewRender.notificationChannelsJSON.utf8))
    check("the channel health decodes; an empty object is no channels",
          health?.webPushState == "live" && health?.desktop.first?.running == true
          && health?.mobileRegistered == false
          && (try? JSONDecoder().decode(AlertChannelHealth.self, from: Data("{}".utf8)))
              == AlertChannelHealth(webPushState: nil, desktop: [], telegramLinked: false, mobileRegistered: false))

    // MARK: groups — the server's group, else the web's fallback

    func group(_ fields: String) -> NotificationGroup? { row(fields).map(NotificationFeedRules.group) }
    check("fallback: read → done; reminder → later; meeting → today; unread mail → now",
          group(#""type":"email","isRead":true"#) == .done
          && group(#""type":"reminder""#) == .later
          && group(#""type":"meeting""#) == .today && group(#""type":"calendar""#) == .today
          && group(#""type":"email""#) == .now)
    check("fallback: a PENDING proposal → now, a resolved one → today; anything else unread → today",
          group(#""type":"agent_proposal","pendingActionStatus":"PENDING""#) == .now
          && group(#""type":"agent_proposal","pendingActionStatus":"EXECUTED""#) == .today
          && group(#""type":"briefing""#) == .today)
    check("the server's group wins over the fallback",
          group(#""type":"email","isRead":true,"group":"reply""#) == .reply
          && group(#""type":"reminder","group":"now""#) == .now)
    let grouped = NotificationFeedRules.grouped(fixture)
    check("groups come in order now, today, reply, later, done, empty ones left out, server order kept",
          grouped.map(\.group) == [.now, .today, .reply, .later, .done]
          && grouped[0].rows.map(\.id) == ["n1", "n2", "n3"]
          && NotificationFeedRules.grouped(Array(fixture.prefix(2))).map(\.group) == [.now])

    // MARK: badge

    check("the badge counts unread now + today only",
          NotificationFeedRules.badgeCount(fixture) == 4
          && NotificationFeedRules.badgeCount(fixture.map { $0.markedRead() }) == 0
          && NotificationFeedRules.badgeCount([]) == 0)
    check("the badge text: none at zero, the number, 99+ past 99",
          NotificationFeedRules.badgeText(0) == nil && NotificationFeedRules.badgeText(7) == "7"
          && NotificationFeedRules.badgeText(99) == "99"
          && NotificationFeedRules.badgeText(100) == L("nc.badge.overflow"))
    check("the toolbar's VoiceOver label carries the count",
          BellToolbar.accessibilityLabel(count: 0) == L("nc.toolbar.label")
          && BellToolbar.accessibilityLabel(count: 3) == L("nc.toolbar.a11y.unread", 3))

    // MARK: why it rang

    typealias R = NotificationReason
    let quoteLine = NotificationFeedRules.reasonLine(R(text: "t", verified: true, quote: " “sign\n today” ", quoteIn: "body"))
    check("a verified quote is shown, in quotation marks, plain and on one line",
          quoteLine == .quote("sign today")
          && NotificationFeedRules.reasonText(.quote("sign today")) == L("nc.reason.quote", "sign today"))
    check("an unverified quote is never shown as a quote: the judgment text instead",
          NotificationFeedRules.reasonLine(R(text: "urgent", verified: false, quote: "q", quoteIn: nil))
              == .judgment("urgent")
          && NotificationFeedRules.reasonText(.judgment("urgent")) == L("nc.reason.judgment", "urgent"))
    check("no reason text falls back to the mail's lane reason, then to nothing",
          NotificationFeedRules.reasonLine(nil, fallback: "payment due") == .judgment("payment due")
          && NotificationFeedRules.reasonLine(R(text: "  ", verified: true, quote: "", quoteIn: nil)) == nil
          && NotificationFeedRules.reasonLine(nil) == nil)
    check("reason text is plain: control characters and newlines collapse",
          NotificationFeedRules.plain("a\u{0007}\n\n b\t") == "a b" && NotificationFeedRules.plain("\n") == nil)
    check("the row draws server text verbatim (no markdown), as plain Text",
          !text("NotificationCenter/NotificationRow.swift").contains("AttributedString")
          && !text("NotificationCenter/NotificationRow.swift").contains("markdown"))

    // MARK: who and what, actions, targets

    let urgent = row(#""type":"email","title":"u","message":"kim: q4 budget [18c3a]""#)
    check("an urgent-mail row without its mail loaded reads sender and subject off the message",
          urgent.map { NotificationFeedRules.display($0, mail: nil) }
              == NotificationFeedRules.Display(who: "kim", subject: "q4 budget", faceKey: "kim"))
    let replied = row(#""type":"email","title":"auto","message":"re: lunch""#)
    check("a mail row without the marker keeps its message as the subject",
          replied.map { NotificationFeedRules.display($0, mail: nil) }
              == NotificationFeedRules.Display(who: "auto", subject: "re: lunch", faceKey: nil))
    check("the dedup marker strips only at the end",
          NotificationFeedRules.strippingDedupMarker("a [b] c [x,y]") == "a [b] c"
          && NotificationFeedRules.strippingDedupMarker("plain") == "plain")
    let mail = item("d1")
    let queue = queueWith(mail)
    let n1 = fixture[0]
    check("the mail a row is about is found in the queue by its EmailMessage id",
          NotificationFeedRules.mail(for: n1, in: queue)?.id == mail.id
          && NotificationFeedRules.mail(for: fixture[1], in: queue) == nil
          && NotificationFeedRules.display(n1, mail: mail).who == "kim")
    check("loaded mail offers Reply then Later; done mail and unloaded mail offer nothing",
          NotificationFeedRules.actions(n1, mail: mail, group: .now) == [.reply(mail), .later(mail)]
          && NotificationFeedRules.actions(n1, mail: mail, group: .done).isEmpty
          && NotificationFeedRules.actions(fixture[1], mail: nil, group: .now).isEmpty)
    check("a meeting offers Join only for a safe https link",
          NotificationFeedRules.actions(fixture[3], mail: nil, group: .today).count == 1
          && row(#""type":"meeting","link":"zoommtg://x""#).map {
              NotificationFeedRules.actions($0, mail: nil, group: .today).isEmpty } == true
          && row(#""type":"meeting","link":"/calendar""#).map {
              NotificationFeedRules.actions($0, mail: nil, group: .today).isEmpty } == true)
    check("a PENDING proposal offers Open (to the proposals list), no approve in the bell",
          NotificationFeedRules.actions(fixture[2], mail: nil, group: .now) == [.open]
          && !text("NotificationCenter/NotificationRow.swift").contains("resolvePendingAction")
          && !text("NotificationCenter/NotificationCenterStore.swift").contains("api.post"))
    check("a click opens the mail, Mail, the proposals or the calendar; other rows only mark read",
          NotificationFeedRules.target(n1, mail: mail) == .mail(mail)
          && NotificationFeedRules.target(fixture[1], mail: nil) == .mailbox
          && NotificationFeedRules.target(fixture[2], mail: nil) == .proposals
          && NotificationFeedRules.target(fixture[3], mail: nil) == .calendar
          && NotificationFeedRules.target(fixture[5], mail: nil) == .none)
    check("received-on names known channels once, in order, and skips unknown ones",
          NotificationFeedRules.deliveredText(["mac", "desktop_mac", "chrome", "pager"])
              == L("nc.meta.delivered", "Mac · Chrome")
          && NotificationFeedRules.deliveredText(["pager"]) == nil
          && NotificationFeedRules.deliveredText([]) == nil)
    check("the footer lists this Mac app first, then what the server reports",
          NotificationChannelRules.channels(nil).map(\.name) == [L("nc.channel.macApp")]
          && NotificationChannelRules.channels(health).map(\.state) == [.ok, .ok, .off]
          && NotificationChannelRules.channels(AlertChannelHealth(
              webPushState: "needs_resubscribe", desktop: [.init(app: "windows", running: false)],
              telegramLinked: true, mobileRegistered: true)).map(\.state) == [.ok, .off, .attention, .ok, .ok])
    let now = NotificationFeedRules.parseISO("2026-07-29T08:30:00Z") ?? Date()
    check("time: relative in the app language; a malformed time is empty",
          !NotificationFeedRules.timeLabel("2026-07-29T08:27:00.000Z", now: now).isEmpty
          && NotificationFeedRules.timeLabel("nope", now: now).isEmpty
          && NotificationFeedRules.timeLabel("2026-07-29T08:31:00Z", now: now)
              == NotificationFeedRules.timeLabel("2026-07-29T08:30:00Z", now: now))

    // MARK: panel geometry — inside the window, below the title bar

    let sizes: [CGSize] = [880, 1000, 1180, 1600, 2400].flatMap { width in
        [520, 640, 900].map { CGSize(width: width, height: $0) }
    } + [CGSize(width: 300, height: 200), CGSize(width: 10, height: 10)]
    let inside = sizes.allSatisfy { size in
        let r = NotificationPanelGeometry.frame(in: size)
        return r.minX >= 0 && r.maxX <= size.width && r.minY >= 0 && r.maxY <= size.height
            && r.width <= NotificationPanelGeometry.preferredWidth
    }
    check("the panel stays inside the content area at every width and height", inside)
    check("from the window's floor up the panel is 420pt wide, anchored top right below the title bar",
          [880, 1180, 1600].allSatisfy { width in
              let r = NotificationPanelGeometry.frame(in: CGSize(width: width, height: 640))
              return r.width == 420 && r.maxX == CGFloat(width) - NotificationPanelGeometry.margin
                  && r.minY == NotificationPanelGeometry.top
          }
          && NotificationPanelGeometry.frame(in: CGSize(width: 1180, height: 2000)).height
              == NotificationPanelGeometry.maxHeight)
    let shell = text("Shell/MainShell.swift")
    check("the panel layer sits on the shell inside the safe area, over the assistant, closing on an outside click",
          shell.contains(".overlay(alignment: .topTrailing) {")
          && shell.contains("NotificationPanelLayer(actions: actions)")
          && !text("NotificationCenter/NotificationPanel.swift").contains("ignoresSafeArea")
          && text("NotificationCenter/NotificationPanel.swift")
              .contains(".onTapGesture { model.notificationCenter.panelOpen = false }"))
    check("the panel uses the editorial card tokens and the content-card radius",
          text("NotificationCenter/NotificationPanel.swift").contains("Theme.Radius.contentCard")
          && text("NotificationCenter/NotificationPanel.swift").contains("Theme.todayRaised"))
    check("Esc closes the panel (kVK_Escape), through a monitor held only while it is open",
          NotificationPanelKeys.closes(keyCode: 53) && !NotificationPanelKeys.closes(keyCode: 36)
          && text("MainWindow.swift").contains("NSEvent.removeMonitor(monitor)"))
    check("toolbar order: theme, bell, Assistant, then the trailing space",
          MainWindowRules.toolbarItems == [
              .flexibleSpace, ThemeToolbar.itemIdentifier, BellToolbar.itemIdentifier,
              AssistantToolbar.itemIdentifier, .space,
          ])

    // MARK: store — requests, optimistic marks, timer, session

    FilesStubProtocol.reset([
        "/api/notifications": FilesScenarios.ok(PreviewRender.notificationFixtureJSON),
        "/api/notifications/alert-endpoints/health": FilesScenarios.ok(PreviewRender.notificationChannelsJSON),
        "/api/notifications/n1/read": .init(status: 204, body: ""),
        "/api/notifications/read-all": .init(status: 204, body: ""),
    ])
    let store = NotificationCenterStore(api: FilesScenarios.api())
    store.runsTimer = false
    await store.refresh()
    let fetched = FilesStubProtocol.calls
    check("refresh reads the latest 50 and the channel health",
          store.rows.count == 7 && store.phase == .loaded && store.channels?.webPushState == "live"
          && fetched.contains(.init(path: "/api/notifications", query: "limit=50"))
          && fetched.contains(.init(path: "/api/notifications/alert-endpoints/health", query: "")))
    await store.markRead("n1")
    check("mark read patches that row and drops the badge by one",
          store.rows.first { $0.id == "n1" }?.isRead == true && store.badgeCount == 3
          && FilesStubProtocol.calls.contains(.init(path: "/api/notifications/n1/read", query: "")))
    await store.markAllRead()
    check("mark all read patches read-all and clears the badge",
          store.badgeCount == 0 && !store.hasUnread
          && FilesStubProtocol.calls.contains(.init(path: "/api/notifications/read-all", query: "")))
    FilesStubProtocol.reset([
        "/api/notifications": FilesScenarios.ok(PreviewRender.notificationFixtureJSON),
        "/api/notifications/n2/read": .init(status: 500, body: "{}"),
    ])
    let rollback = NotificationCenterStore(api: FilesScenarios.api())
    rollback.runsTimer = false
    await rollback.refresh()
    await rollback.markRead("n2")
    check("a refused mark read rolls back to the server's state; a failed health read keeps no channels",
          rollback.rows.first { $0.id == "n2" }?.isRead == false && rollback.channels == nil)
    await rollback.loadDelivery("n2")
    check("a 404 on the lazy delivery read is tolerated: nothing shown, asked once",
          rollback.delivery["n2"] == [] && rollback.deliveredTo(rollback.rows[1]) == ["mac"]
          && FilesStubProtocol.calls.filter { $0.path == "/api/notifications/n2/delivery" }.count == 1)
    await rollback.loadDelivery("n2")
    check("the delivery read is not repeated for the same row",
          FilesStubProtocol.calls.filter { $0.path == "/api/notifications/n2/delivery" }.count == 1)
    check("a row id is one escaped path segment",
          NotificationCenterStore.readPath("a/../b") == "/api/notifications/a%2F%2E%2E%2Fb/read")
    FilesStubProtocol.reset(["/api/notifications": .init(status: 500, body: "{}")])
    let failing = NotificationCenterStore(api: FilesScenarios.api())
    failing.runsTimer = false
    await failing.refresh()
    check("a first load that fails shows the failed state", failing.phase == .failed && failing.rows.isEmpty)
    FilesStubProtocol.reset([:])
    let timed = NotificationCenterStore(api: FilesScenarios.api())
    timed.usesNetwork = false
    timed.panelOpen = true
    let runningWhileOpen = timed.isTimerRunning
    timed.panelOpen = false
    check("the 60 s timer runs only while the panel is open",
          runningWhileOpen && !timed.isTimerRunning && NotificationCenterStore.refreshSeconds == 60)
    store.usesNetwork = false
    store.panelOpen = true
    store.reset()
    check("reset (sign-out, a new sign-in) drops the rows, the channels and the panel",
          store.rows.isEmpty && store.channels == nil && !store.panelOpen && store.phase == .idle
          && store.delivery.isEmpty)
    check("the model resets the bell with the session and nudges it on the realtime wake",
          text("AppModel.swift").contains("notificationCenter.reset()")
          && text("AppModel.swift").contains("if isCurrent(session), opensRealtime { notificationCenter.nudge() }"))

    // MARK: banner words (N1)

    let words = MailBannerContent.compose(
        from: "kim <kim@co.example>", subject: "q4 budget", reason: "payment due today")
    check("a mail banner: title = sender, body = subject, then the reason on a second line",
          words.title == "kim" && words.body == "q4 budget\npayment due today")
    check("no reason: the subject alone; no subject: the no-subject line; no sender: the address or Klorn",
          MailBannerContent.compose(from: "kim <k@x.example>", subject: "s", reason: nil).body == "s"
          && MailBannerContent.compose(from: "k@x.example", subject: "", reason: "  ").body == L("mail.noSubjectParen")
          && MailBannerContent.compose(from: nil, subject: "s", reason: nil).title == "Klorn")
    let messy = MailBannerContent.compose(
        from: "kim\u{202E} <k@x.example>", subject: "a\nb", reason: String(repeating: "r", count: 200))
    check("each part is one line, without bidi marks, capped like the server (140 for the reason)",
          messy.title == "kim" && messy.body.hasPrefix("a b\n")
          && messy.body.split(separator: "\n").last?.count == MailBannerContent.reasonMax
          && messy.body.hasSuffix("…"))
    let banner = PushBanner.make(for: item("d9", reason: "you replied 6 times"))
    check("a PUSH banner carries the reason line; a meeting reminder keeps its own words",
          banner.title == "kim" && banner.body == "s-d9\nyou replied 6 times"
          && text("Notifications.swift").contains("body: L(\"meeting.banner.body\", minutes))"))
    check("the banner composition lives in one function, and banners still add no actions",
          text("Notifications.swift").components(separatedBy: "MailBannerContent.compose(").count == 2
          && !text("Notifications.swift").contains("UNNotificationAction"))

    // MARK: strings

    let keys = [
        "nc.title", "nc.unread", "nc.markAllRead", "nc.group.now", "nc.group.today", "nc.group.reply",
        "nc.group.later", "nc.group.done", "nc.group.count", "nc.reason.quote", "nc.reason.judgment",
        "nc.meta.delivered", "nc.meta.held", "nc.action.reply", "nc.action.later", "nc.action.join",
        "nc.action.open", "nc.channels.title", "nc.channels.settings", "nc.toolbar.label",
        "nc.toolbar.help", "nc.toolbar.a11y.unread", "nc.badge.overflow", "nc.empty", "nc.failed",
    ]
    let missing = L10n.shipped.flatMap { language in
        keys.filter { L10n.value($0, language: language) == nil }.map { "\(language):\($0)" }
    }
    check("every bell string exists in all seven languages", missing.isEmpty)
    for entry in missing.prefix(6) { print("      missing \(entry)") }
    check("counts are %d, never %@",
          L10n.shipped.allSatisfy { language in
              ["nc.unread", "nc.toolbar.a11y.unread"].allSatisfy {
                  L10n.value($0, language: language)?.contains("%d") == true
              }
              && L10n.value("nc.group.count", language: language)?.hasSuffix("%d") == true
          })
    check("the toolbar bell is in Korean what the board says (알림, 모두 읽음, 지금 확인)",
          L10n.value("nc.title", language: "ko") == "알림"
          && L10n.value("nc.markAllRead", language: "ko") == "모두 읽음"
          && L10n.value("nc.group.now", language: "ko") == "지금 확인"
          && L10n.value("nc.reason.judgment", language: "ko") == "Klorn 판단 · %@")
    return results
}

/// A queue mail with sender "kim".
@MainActor
private func item(_ dbId: String, reason: String? = nil) -> FirewallItem {
    let why = reason.map { #","tierReason":"\#($0)""# } ?? ""
    let json = #"{"id":"i-\#(dbId)","source":"email","sourceId":"\#(dbId)","type":"email","title":"t","tier":"PUSH"\#(why),"priority":9,"surfacedAt":"2026-07-29T08:00:00Z","email":{"emailDbId":"\#(dbId)","subject":"s-\#(dbId)","from":"kim <kim@co.example>"},"hashStale":false}"#
    return try! JSONDecoder().decode(FirewallItem.self, from: Data(json.utf8))
}

@MainActor
private func queueWith(_ item: FirewallItem) -> FirewallResponse? {
    let encoded = (try? JSONEncoder().encode(item)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    let json = #"{"tiers":{"PUSH":[\#(encoded)]},"summary":{"SILENT":0,"QUEUE":0,"PUSH":1,"total":1}}"#
    return try? JSONDecoder().decode(FirewallResponse.self, from: Data(json.utf8))
}
