import Foundation

// Self-check: the delivery read's per-row 404 (contract
// NotificationDelivery), and the Mac mail banner's words match the server's ONE formatter,
// mailPushContent (packages/api/src/notify/mail-push-content.ts). Each case
// below is copied from packages/api/src/__tests__/mail-push-content.test.ts
// (the `describe("mailPushContent")` and `describe("… reason line (NC1)")`
// blocks), with the same inputs and the same expected strings. The localized
// no-subject stand-in is compared to the server's English
// notification-strings.ts noSubject, "(no subject)". Run by
// `KlornMac --self-check`; pure, no network.

@MainActor
func notificationContractSelfChecks() async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ cond: Bool) { results.append(("notification contract — \(name)", cond)) }
    typealias R = NotificationReason
    func reason(_ text: String, verified: Bool = false, quote: String? = nil) -> R {
        R(text: text, verified: verified, quote: quote, quoteIn: nil)
    }
    func compose(_ from: String, _ subject: String?, _ why: R? = nil) -> (title: String, body: String) {
        MailBannerContent.compose(from: from, subject: subject, reason: why)
    }
    func utf16(_ s: String) -> Int { s.utf16.count }
    let noSubject = L10n.value("banner.noSubject", language: "en") ?? ""
    check("the English stand-in is the server's \"(no subject)\"", noSubject == "(no subject)")
    let serverNoSubject = [
        "en": "(no subject)", "ko": "(제목 없음)", "ja": "(件名なし)", "zh": "（无主题）",
        "es": "(sin asunto)", "fr": "(sans objet)", "de": "(kein Betreff)",
    ]
    check("every language's stand-in is the server's notification-strings.ts noSubject",
          serverNoSubject.allSatisfy { L10n.value("banner.noSubject", language: $0.key) == $0.value })

    let a = compose("Alice Kim <alice@example.com>", "Contract", reason("Signature needed today"))
    check("titles the notification with the sender's name only, no app prefix",
          a.title == "Alice Kim" && !a.title.contains("Klorn"))
    check("puts the subject on line 1 and the reason on line 2",
          compose("Alice <alice@example.com>", "Contract", reason("Signature needed today")).body
              == "Contract\nSignature needed today")
    check("omits the reason line when there is no reason",
          [nil, reason(""), reason("   ")].allSatisfy { compose("a@b.c", "Hi", $0).body == "Hi" })
    check("an empty subject uses the localized stand-in",
          MailBannerContent.compose(from: "Bob <b@x.io>", subject: "", reason: nil).body == L("banner.noSubject"))
    check("falls back to the raw address when the From header has no display name",
          compose("b@x.io", "s").title == "b@x.io")
    let evil = compose("\"Evil\nKlorn Security\" <e@x.io>", "Pay now\r\nYour account is locked\u{0007}",
                       reason("line one\nline two"))
    check("keeps mail-authored text on one line each (no injected extra lines or control chars)",
          evil.title == "Evil Klorn Security"
          && evil.body.components(separatedBy: "\n") == ["Pay now Your account is locked", "line one line two"])
    check("drops bidi override marks that would reorder what the user reads",
          compose("a@b.c", "Invoice \u{202E}gnp.exe\u{202C}").body == "Invoice gnp.exe")
    let capped = compose("a@b.c", "s", reason(String(repeating: "x", count: 500)))
        .body.components(separatedBy: "\n").last ?? ""
    check("caps the reason line", utf16(capped) <= MailBannerContent.reasonMax && capped.hasSuffix("…"))
    let html = compose("<b>Mallory</b> <m@b.c>",
                       "Invoice <img src=x onerror=alert(1)> <a href=\"https://e.vil\">due</a>",
                       reason("<script>alert(1)</script>Pay today"))
    check("strips HTML from mail text: notifications are plain text and carry no markup",
          html.title == "Mallory" && html.body == "Invoice due\nalert(1) Pay today"
          && !(html.title + html.body).contains(where: { $0 == "<" || $0 == ">" }))
    let invisible = compose("\u{200B}\u{200B} <z@x.io>", "\u{200B}\u{2060}\u{00AD}", reason("Pay\u{200B} today\u{061C}"))
    check("drops invisible format characters: a zero-width-only field reads as empty",
          invisible.title == "z@x.io" && invisible.body == "\(L("banner.noSubject"))\nPay today")
    let huge = compose(String(repeating: "x", count: 200_000) + " <a@b.c>", "s")
    check("reads at most a bounded prefix of a huge From header", utf16(huge.title) <= MailBannerContent.titleMax)
    check("keeps a comparison that is not a tag",
          compose("a@b.c", "Q3: cost < 5% > plan").body == "Q3: cost < 5% > plan")
    check("a subject that is only markup reads as the localized no-subject stand-in",
          compose("a@b.c", "<div></div>").body == L("banner.noSubject"))
    check("titles a bare <address> From header with the address", compose("<b@x.io>", "s").title == "b@x.io")
    check("bounds the work on a huge subject before any pattern runs",
          utf16(compose("a@b.c", String(repeating: "<a ", count: 50_000) + "tail").body) <= MailBannerContent.subjectMax)

    // describe("mailPushContent — reason line (NC1)")
    check("a verified quote replaces the short reason, in curly quotes",
          compose("Alice <a@b.c>", "Contract",
                  R(text: "Signature needed today", verified: true, quote: "Please sign by 5pm today", quoteIn: "body"))
              .body == "Contract\n“Please sign by 5pm today”")
    check("quotation marks the quote already carries are not doubled",
          compose("a@b.c", "s", reason("t", verified: true, quote: "\"Please sign by 5pm\""))
              .body.components(separatedBy: "\n").last == "“Please sign by 5pm”")
    check("an unverified quote is never shown: the short reason is",
          compose("a@b.c", "s", reason("Looks urgent", quote: "wire the money now")).body == "s\nLooks urgent")
    check("a verified reason with an empty quote falls back to the text",
          compose("a@b.c", "s", reason("Looks urgent", verified: true, quote: "  ")).body == "s\nLooks urgent")
    let longQuote = compose("a@b.c", "s", reason("t", verified: true, quote: String(repeating: "y", count: 400)))
        .body.components(separatedBy: "\n").last ?? ""
    check("caps a long quote, marks included",
          utf16(longQuote) <= MailBannerContent.reasonMax && longQuote.hasPrefix("“") && longQuote.hasSuffix("…”"))

    // Mac-side: caps count UTF-16 units like JS `length`.
    let emoji = MailBannerContent.plainLine(String(repeating: "😀", count: 100), 10)
    check("caps count UTF-16 code units, as JavaScript's length does",
          utf16(emoji) == 10 && emoji.hasSuffix("…"))
    check("a From with no sender at all is titled Klorn (the server always has a From)",
          MailBannerContent.compose(from: nil, subject: "s", reason: nil).title == "Klorn")
    check("parseAddress refuses two angle-addrs and reads past a quoted <...> (email-address.ts)",
          MailAddressParser.parseAddress("\"<victim@target.com>\" <attacker@evil.co>") == "attacker@evil.co"
          && MailAddressParser.parseAddress("a <x@y.z> <q@r.s>") == ""
          && MailAddressParser.parseAddress("x@y.z") == "x@y.z")

    // MARK: delivery 404 — per row, unless the route itself is proven missing

    FilesStubProtocol.reset([
        "/api/notifications": FilesScenarios.ok(PreviewRender.notificationFixtureJSON),
        "/api/notifications/n1/delivery": .init(status: 404, body: #"{"error":"Notification not found"}"#),
        "/api/notifications/n3/delivery": FilesScenarios.ok(#"{"deliveredTo":["mac"],"channels":[]}"#),
    ])
    let perRow = NotificationCenterStore(api: FilesScenarios.api())
    perRow.runsTimer = false
    await perRow.refresh()
    await perRow.loadDelivery("n1")
    await perRow.loadDelivery("n3")
    check("a row's own 404 (not yours, or deleted after the list loaded) disables only that row",
          !perRow.deliveryRouteMissing && perRow.delivery["n1"] == [] && perRow.delivery["n3"] == ["mac"]
          && FilesStubProtocol.calls.contains(.init(path: "/api/notifications/n3/delivery", query: "")))
    FilesStubProtocol.reset([
        "/api/notifications": FilesScenarios.ok(PreviewRender.notificationFixtureJSON),
        "/api/notifications/n1/delivery": .init(status: 404, body:
            #"{"message":"Route GET:/api/notifications/n1/delivery not found","error":"Not Found","statusCode":404}"#),
    ])
    let missingRoute = NotificationCenterStore(api: FilesScenarios.api())
    missingRoute.runsTimer = false
    await missingRoute.refresh()
    await missingRoute.loadDelivery("n1")
    await missingRoute.loadDelivery("n3")
    check("only Fastify's route-not-found 404 stops every row's delivery read for the session",
          missingRoute.deliveryRouteMissing
          && !FilesStubProtocol.calls.contains(.init(path: "/api/notifications/n3/delivery", query: "")))
    check("DeliveryFailure: the route's own 404, a bare 404 and a stub 404 are per-row",
          DeliveryFailure.classify(APIError.http(404, "Notification not found")) == .rowGone
          && DeliveryFailure.classify(APIError.http(404, nil)) == .rowGone
          && DeliveryFailure.classify(APIError.http(404, "not found")) == .rowGone
          && DeliveryFailure.classify(APIError.http(404, "Route GET:/api/notifications/x/delivery not found"))
              == .routeMissing
          && DeliveryFailure.classify(APIError.unauthorized) == .unauthorized
          && DeliveryFailure.classify(APIError.http(500, nil)) == .other)
    missingRoute.reset()
    check("reset forgets the route-missing stop and the budget",
          !missingRoute.deliveryRouteMissing && missingRoute.budget == nil)

    // MARK: banner path — the bell row's verified quote, no network

    let item = parityItem("e1", reason: "Signature deadline today")
    let verifiedRow = parityRow(emailId: "e1", reason:
        #"{"text":"Signature deadline today","verified":true,"quote":"Please sign before 17:00","quoteIn":"body"}"#)
    let unverifiedRow = parityRow(emailId: "e1", reason: #"{"text":"Model words","verified":false,"quote":"x"}"#)
    check("a banner uses the bell row's verified quote when the store has the row",
          PushBanner.make(for: item, row: verifiedRow).body == "s-e1\n“Please sign before 17:00”")
    check("without a verified quote (no row, or unverified), the banner keeps the item's tier reason",
          PushBanner.make(for: item).body == "s-e1\nSignature deadline today"
          && PushBanner.make(for: item, row: unverifiedRow).body == "s-e1\nSignature deadline today")
    let banners = BannerBatch.banners(for: [item]) { $0.email?.emailDbId == "e1" ? verifiedRow : nil }
    check("BannerBatch passes each mail's row through", banners.first?.body == "s-e1\n“Please sign before 17:00”")
    let store = NotificationCenterStore(api: APIClient(base: "http://127.0.0.1:9", token: { nil }))
    store.seedForRender(rows: [verifiedRow].compactMap { $0 }, channels: nil)
    check("the store finds a mail's bell row by sourceEmailId, from memory",
          store.row(forEmail: "e1")?.id == "r1" && store.row(forEmail: "e2") == nil && store.row(forEmail: nil) == nil)
    let notifications = (try? String(
        contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Notifications.swift"),
        encoding: .utf8)) ?? ""
    check("the alerter reads rows from memory and only nudges (never awaits) an empty store",
          notifications.contains("BannerBatch.banners(for: items) { bell.row(forEmail: $0.email?.emailDbId) }")
          && notifications.contains("if bell.rows.isEmpty { bell.nudge() }"))
    return results
}

@MainActor
private func parityItem(_ dbId: String, reason: String) -> FirewallItem {
    let json = #"{"id":"i-\#(dbId)","source":"email","sourceId":"\#(dbId)","type":"email","title":"t","tier":"PUSH","tierReason":"\#(reason)","priority":9,"surfacedAt":"2026-07-29T08:00:00Z","email":{"emailDbId":"\#(dbId)","subject":"s-\#(dbId)","from":"kim <kim@co.example>"},"hashStale":false}"#
    return try! JSONDecoder().decode(FirewallItem.self, from: Data(json.utf8))
}

private func parityRow(emailId: String, reason: String) -> NotificationWire? {
    let json = #"{"notifications":[{"id":"r1","type":"email","sourceEmailId":"\#(emailId)","createdAt":"2026-07-29T08:00:00Z","reason":\#(reason)}]}"#
    return (try? JSONDecoder().decode(NotificationsResponse.self, from: Data(json.utf8)))?.notifications.first
}
