import Foundation

// Self-check for FREE-plan refusals (2026-10-30), run by `KlornMac --self-check`.
//
// Every signup starts on FREE and Pro is bought on the web (founder decision
// 2026-10-24). With the server paywall on, a paid route answers 403 and the
// assistant can hit the free daily AI cap. These checks pin that each refusal
// reads as needs-Pro (never "try again"), carries the one upgrade link-out to
// <web>/billing, and that the cap reads as one localized line. Pure, stubbed
// network and source scans only: no window, no browser, no real server.

/// Every plan-refusal check, as (name, passed).
@MainActor
func planUpgradeSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results = planUpgradePureChecks()
    results += chatCapChecks()
    results += await planRefusalModelChecks()
    results += planUpgradeStringChecks()
    results += planUpgradeWiringChecks(sourceDir: sourceDir)
    return results
}

private func planUpgradePureChecks() -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }

    check("the upgrade link opens <web base>/billing",
          PlanUpgrade.billingURL(webBase: "https://app.klorn.ai")?.absoluteString
              == "https://app.klorn.ai/billing")
    check("and follows the configured web base by default",
          PlanUpgrade.billingURL()?.absoluteString == Config.webBaseURL + "/billing")
    check("every needs-Pro notice offers the upgrade",
          !PlanUpgrade.needsProKeys.isEmpty
              && PlanUpgrade.needsProKeys.allSatisfy { PlanUpgrade.offersUpgrade(for: L($0)) })
    check("the notices the app shows today are all on the list",
          Set(["error.needsPro", "reply.needsPro", "compose.needsPro", "proposals.needsPro"])
              .isSubset(of: Set(PlanUpgrade.needsProKeys)))
    check("a plain failure, a settings refusal or no notice offers nothing",
          !PlanUpgrade.offersUpgrade(for: nil)
              && !PlanUpgrade.offersUpgrade(for: L("mail.summarizeFailed"))
              && !PlanUpgrade.offersUpgrade(for: L("auto.error.forbidden"))
              && !PlanUpgrade.offersUpgrade(for: L("error.generic")))
    check("a 403 is a plan refusal; anything else is a failure",
          ActionFailure.classify(APIError.forbidden) == .needsPro
              && ActionFailure.classify(APIError.http(500, nil)) == .failed
              && ActionFailure.classify(APIError.transport("x")) == .failed
              && ActionFailure.classify(APIError.decoding("x")) == .failed)
    return results
}

private func turn(_ json: String) -> ChatTurnResponse? {
    try? JSONDecoder().decode(ChatTurnResponse.self, from: Data(json.utf8))
}

private func chatCapChecks() -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }

    check("the cap codes map to the free and the paid notice",
          ChatCapNotice(errorCode: "DAILY_COST_CAP_FREE") == .free
              && ChatCapNotice(errorCode: "DAILY_COST_CAP") == .paid
              && ChatCapNotice(errorCode: nil) == nil
              && ChatCapNotice(errorCode: "SOMETHING_ELSE") == nil)

    let free = turn(#"{"reply":"quota","error":"capped","errorCode":"DAILY_COST_CAP_FREE"}"#)
    let freeBubbles = free.map(chatTurnBubbles) ?? []
    check("at the free cap: one localized line with the upgrade, no raw second bubble",
          freeBubbles.count == 1 && freeBubbles.first?.role == .failure
              && freeBubbles.first?.text == L("chat.cap.free")
              && freeBubbles.first?.offersUpgrade == true)

    let paid = turn(#"{"reply":"quota","error":"capped","errorCode":"DAILY_COST_CAP"}"#)
    let paidBubbles = paid.map(chatTurnBubbles) ?? []
    check("at the paid cap: the same kind of line without the upgrade",
          paidBubbles.count == 1 && paidBubbles.first?.text == L("chat.cap.daily")
              && paidBubbles.first?.offersUpgrade == false)
    check("the paid line does not call the allowance free",
          L("chat.cap.daily") != L("chat.cap.free"))

    let old = turn(#"{"reply":"sorry","error":"capped"}"#)
    let oldBubbles = old.map(chatTurnBubbles) ?? []
    check("an older server without errorCode keeps the reply plus its error bubble",
          old != nil && oldBubbles.map(\.role) == [.assistant, .failure]
              && oldBubbles.map(\.text) == ["sorry", "capped"]
              && oldBubbles.allSatisfy { !$0.offersUpgrade })
    let unknown = turn(#"{"reply":"hi","error":null,"errorCode":"NEW_CODE"}"#)
    check("an unknown errorCode is the normal turn",
          unknown.map(chatTurnBubbles)?.map(\.text) == ["hi"])
    return results
}

@MainActor
private func planRefusalModelChecks() async -> [(String, Bool)] {
    typealias S = SessionScenarios
    typealias Reply = SessionStubProtocol.Reply
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let refused = Reply(status: 403, body: #"{"error":"x","code":"ENTITLEMENT_REQUIRED"}"#)
    let down = Reply(status: 500, body: "{}")

    // Summarize ("AI 정리") is entitlement-gated: a retry never works for FREE.
    let summarize = "POST /api/email/e1/summarize"
    let free = S.model([summarize: refused])
    free.seedForPreview(firewallJSON: "", emailJSON: #"{"id":"e1"}"#, selectedItemId: nil)
    await free.summarizeOpenedEmail()
    check("a refused summarize is needs-Pro, not 'try again'",
          free.openedEmail?.id == "e1" && free.summarizeFailure == .needsPro)
    let broken = S.model([summarize: down])
    broken.seedForPreview(firewallJSON: "", emailJSON: #"{"id":"e1"}"#, selectedItemId: nil)
    await broken.summarizeOpenedEmail()
    check("a summarize that failed is still the retry state",
          broken.summarizeFailure == .failed)

    // Approvals: their own needs-Pro sentence, never the settings one.
    let action = try? JSONDecoder().decode(
        PendingActionsResponse.Action.self, from: Data(#"{"id":"a1","toolName":"send_email"}"#.utf8))
    let approvals = S.model(["POST /api/chat/pending-actions/a1/approve": refused])
    if let action { approvals.resolvePendingAction(action, approve: true) }
    _ = await S.waitUntil { approvals.pendingActionError != nil }
    check("a refused approval reads as the approvals needs-Pro sentence with the upgrade",
          action != nil && approvals.pendingActionError == L("proposals.needsPro")
              && PlanUpgrade.offersUpgrade(for: approvals.pendingActionError))

    // Chat "Add to calendar" on a refused POST /api/calendar.
    let draft = EventDraft(
        title: "t", startTime: "2026-10-30T10:00:00Z", endTime: "2026-10-30T11:00:00Z",
        location: nil, attendees: nil)
    let calendar = S.model(["POST /api/calendar": refused])
    await calendar.createEvent(from: draft, messageId: UUID())
    check("a refused chat event is the needs-Pro line with the upgrade",
          calendar.chatMessages.last?.text == L("error.needsPro")
              && calendar.chatMessages.last?.offersUpgrade == true)
    let calendarDown = S.model(["POST /api/calendar": down])
    await calendarDown.createEvent(from: draft, messageId: UUID())
    check("a failed chat event keeps its localized failure line",
          calendarDown.chatMessages.last?.text
              == L("chat.event.failed", AppModel.describe(APIError.http(500, nil)))
              && calendarDown.chatMessages.last?.offersUpgrade == false)

    // The assistant at the free daily cap, end to end through sendChat.
    let capped = S.model([
        "POST /api/chat/conversations": Reply(body: #"{"id":"c1"}"#),
        "POST /api/chat/conversations/c1/messages":
            Reply(body: #"{"reply":"quota","error":"capped","errorCode":"DAILY_COST_CAP_FREE"}"#),
    ])
    await capped.sendChat("hi")
    check("a capped turn shows the question and one cap line",
          capped.chatMessages.map(\.text) == ["hi", L("chat.cap.free")]
              && capped.chatMessages.last?.offersUpgrade == true)
    let unreachable = S.model(["POST /api/chat/conversations": down])
    await unreachable.sendChat("hi")
    check("a turn that failed reads through the catalogue",
          unreachable.chatMessages.last?.text
              == L("chat.send.failed", AppModel.describe(APIError.http(500, nil))))
    return results
}

private func planUpgradeStringChecks() -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let keys = [
        "plan.upgrade", "plan.upgrade.a11yHint", "proposals.needsPro",
        "chat.cap.free", "chat.cap.daily", "chat.send.failed", "chat.event.failed",
    ]
    check("every new sentence is in all seven catalogues",
          L10n.shipped.allSatisfy { code in
              let catalogue = L10n.keys(forLanguage: code)
              return keys.allSatisfy(catalogue.contains)
          })
    check("the approvals sentence is not the settings one",
          L("proposals.needsPro") != L("auto.error.forbidden"))
    check("the failure lines take their reason",
          L("chat.send.failed", "x").contains("x") && !L("chat.send.failed", "x").contains("%")
              && L("chat.event.failed", "x").contains("x") && !L("chat.event.failed", "x").contains("%"))
    return results
}

private func planUpgradeWiringChecks(sourceDir: URL) -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let files = swiftSources(under: sourceDir)
    func text(_ name: String) -> String {
        files.first { $0.lastPathComponent == name }
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
    // Every needs-Pro notice the app shows carries the link-out beside it.
    let surfaces = [
        "Compose.swift", "ReadingPane.swift", "CalendarEditor.swift", "PreferencesView.swift",
        "DeviceCalendarSection.swift", "ProposalsList.swift", "AssistantThread.swift",
        "ImapConnectForm.swift",
    ]
    let missing = surfaces.filter { !text($0).contains("UpgradeToProLink()") }
    check("every needs-Pro notice renders the upgrade link", missing.isEmpty)
    if !missing.isEmpty { print("      missing: \(missing.joined(separator: ", "))") }
    let appModel = text("AppModel.swift")
    check("no hardcoded chat failure prefix is left",
          !appModel.contains("\"Couldn't reach Klorn —") && !appModel.contains("\"Couldn't create the event —"))
    check("approvals no longer reuse the settings refusal",
          appModel.contains("pendingActionError = Self.pendingActionErrorText(error)"))
    let upgrade = text("PlanUpgrade.swift")
    check("the link-out opens the billing page and nothing else on the web",
          upgrade.contains("NSWorkspace.shared.open") && upgrade.contains("\"/billing\"")
              && upgrade.components(separatedBy: "Config.webBaseURL").count == 2)
    return results
}
