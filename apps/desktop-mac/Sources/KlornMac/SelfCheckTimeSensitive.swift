import Foundation
import UserNotifications

// Self-check for Time Sensitive banners (2026-11-13), run by
// `KlornMac --self-check`.
//
// A banner about one PUSH- or MEETING-lane mail posts at the Time Sensitive
// interruption level, so a Focus mode the user lets Klorn through does not
// silence it. Summaries and meeting reminders keep the default level. The
// level needs the restricted entitlement, which only the Developer ID release
// claims, authorized by its embedded provisioning profile; every other build
// posts at the default level instead of relying on what macOS does with an
// unentitled request.
//
// Nothing here posts a banner or reads the notification center: the content
// is built and inspected only.

@MainActor
func timeSensitiveSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ cond: Bool) { results.append((name, cond)) }
    func text(_ file: String) -> String {
        (try? String(contentsOf: sourceDir.appendingPathComponent(file), encoding: .utf8)) ?? ""
    }
    func item(_ id: String, _ tier: String) -> FirewallItem {
        let json = #"{"id":"\#(id)","source":"email","sourceId":"\#(id)","type":"email","title":"t","tier":"\#(tier)","priority":9,"surfacedAt":"2026-11-07T23:00:00Z","email":{"emailDbId":"d-\#(id)","subject":"s-\#(id)","from":"Name-\#(id) <\#(id)@a.example>"},"hashStale":false}"#
        return try! JSONDecoder().decode(FirewallItem.self, from: Data(json.utf8))
    }
    let push = item("p1", "PUSH")
    let meeting = item("m1", "MEETING")

    // MARK: which banners are Time Sensitive

    check("per lane: PUSH and MEETING are Time Sensitive, every other lane the default",
          BannerInterruption.forLane(.push) == .timeSensitive
          && BannerInterruption.forLane(.meeting) == .timeSensitive
          && BannerInterruption.forLane(.queue) == .standard
          && BannerInterruption.forLane(.info) == .standard
          && BannerInterruption.forLane(.silent) == .standard)
    check("a PUSH-mail and a MEETING-mail banner are Time Sensitive",
          PushBanner.make(for: push).interruption == .timeSensitive
          && PushBanner.make(for: meeting).interruption == .timeSensitive)
    let eight = (1...8).map { item("p\($0)", "PUSH") }
    let burst = BannerBatch.banners(for: eight)
    check("a burst: the four mail banners are Time Sensitive, the \"+N more\" summary is not",
          burst.count == PushLedger.maxBannersPerSync
          && burst.prefix(4).allSatisfy { $0.interruption == .timeSensitive }
          && burst.last?.interruption == .standard)
    let held = [item("p2", "PUSH"), item("p3", "PUSH")]
    check("the held, while-closed and delayed summaries keep the default level",
          [HeldBanners.SummaryKind.quietHours, .whileClosed, .delayed].allSatisfy {
              HeldBanners.summaryBanner(for: held, kind: $0).interruption == .standard
          })
    let standup = CalendarEventWire(
        id: "ev-1",
        title: "Standup", startTime: "2026-11-07T09:10:00Z", endTime: "2026-11-07T09:30:00Z",
        location: nil, meetingLink: nil, allDay: false)
    check("a meeting reminder keeps the default level",
          MeetingBanner.make(for: standup, now: ISO8601DateFormatter().date(from: "2026-11-07T09:02:00Z")!)
              .interruption == .standard)

    // MARK: the level actually posted

    check("the Time Sensitive level is posted only when this build claims the entitlement",
          BannerInterruption.timeSensitive.level(entitled: true) == .timeSensitive
          && BannerInterruption.timeSensitive.level(entitled: false) == .active
          && BannerInterruption.standard.level(entitled: true) == .active
          && BannerInterruption.standard.level(entitled: false) == .active)
    let entitledPush = SystemPushNotifier.content(for: PushBanner.make(for: push), entitled: true)
    let unentitledPush = SystemPushNotifier.content(for: PushBanner.make(for: push), entitled: false)
    let entitledSummary = SystemPushNotifier.content(for: BannerBatch.moreSummary(for: held), entitled: true)
    check("the posted content carries that level: a PUSH banner, entitled or not, and a summary",
          entitledPush.interruptionLevel == .timeSensitive
          && unentitledPush.interruptionLevel == .active
          && entitledSummary.interruptionLevel == .active)
    let meetingContent = SystemPushNotifier.content(for: PushBanner.make(for: meeting), entitled: true)
    check("the content is otherwise unchanged: title, lane line, body, sound, thread",
          meetingContent.title == "Name-m1" && meetingContent.subtitle == Tier.meeting.label
          && meetingContent.body == "s-m1" && meetingContent.sound != nil
          && meetingContent.threadIdentifier == PushNotifier.threadIdentifier
          && entitledPush.subtitle.isEmpty)
    check("the shipped notifier posts that content, read against this build's own signature",
          text("Notifications.swift").contains(
              "let content = Self.content(for: banner, entitled: TimeSensitiveEntitlement.isClaimed)"))

    // MARK: this build's own entitlement

    check("an entitlement claim is a boolean true; absent, false or another type is none",
          TimeSensitiveEntitlement.claimed(kCFBooleanTrue)
          && !TimeSensitiveEntitlement.claimed(kCFBooleanFalse)
          && !TimeSensitiveEntitlement.claimed(nil)
          && !TimeSensitiveEntitlement.claimed("true" as CFString)
          && !TimeSensitiveEntitlement.claimed(1 as CFNumber))
    // Read through Security's SecTask, synchronously, outside any actor: the
    // value depends on how this binary was signed, so only the read is checked.
    let claimedHere = TimeSensitiveEntitlement.isClaimed
    check("reading this build's own signature works without a notification center (here: \(claimedHere))",
          claimedHere == TimeSensitiveEntitlement.isClaimed)

    // MARK: the two entitlements files

    let packageDir = sourceDir.deletingLastPathComponent().deletingLastPathComponent()
    func entitlements(_ name: String) -> [String: Any] {
        guard let data = FileManager.default.contents(atPath: packageDir.appendingPathComponent(name).path),
              let dict = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return [:] }
        return dict
    }
    let base = entitlements("Klorn.entitlements")
    let developerID = entitlements("Klorn.developerid.entitlements")
    let profileKeys: [String: Any] = [
        "com.apple.application-identifier": "P89M32649C.ai.klorn.desktop",
        "com.apple.developer.team-identifier": "P89M32649C",
        TimeSensitiveEntitlement.key: true,
    ]
    check("the ad-hoc entitlements never claim a profile-only key (that build would not launch)",
          !base.isEmpty && profileKeys.keys.allSatisfy { base[$0] == nil })
    check("the Developer ID entitlements are Klorn.entitlements plus exactly the three profile keys",
          Set(developerID.keys) == Set(base.keys).union(profileKeys.keys)
          && base.allSatisfy { key, value in (developerID[key] as AnyObject?)?.isEqual(value) == true }
          && profileKeys.allSatisfy { key, value in (developerID[key] as AnyObject?)?.isEqual(value) == true })
    let workflow = (try? String(
        contentsOf: packageDir.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".github/workflows/desktop-release.yml"),
        encoding: .utf8)) ?? ""
    let embed = workflow.range(of: "- name: Embed the Developer ID provisioning profile")
    let sign = workflow.range(of: "- name: Sign with Developer ID (hardened runtime)")
    check("the release embeds the profile before it signs, and signs with the Developer ID file only then",
          embed != nil && sign != nil && embed!.lowerBound < sign!.lowerBound
          && workflow.contains(#"ENTITLEMENTS="Klorn.developerid.entitlements""#)
          && workflow.contains("Klorn.app/Contents/embedded.provisionprofile"))
    return results
}
