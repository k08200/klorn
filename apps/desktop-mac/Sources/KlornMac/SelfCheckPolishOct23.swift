import Foundation

// Self-check for the 2026-10-23 polish pass: the calendar keeps clear of the
// assistant button, the beta mail sources say so, the two "Auto" settings
// read apart in every language, and the web-chosen display zone resolves
// safely. Pure and source scans only — no window, no network, no Keychain.

@MainActor
func polishOct23SelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let files = swiftSources(under: sourceDir)
    func text(_ name: String) -> String {
        files.first { $0.lastPathComponent == name }
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }

    // MARK: 1. calendar vs the floating assistant button
    let calendar = text("CalendarScreen.swift")
    check("the dock's edge clearance covers its 48pt button + 20pt inset",
          AssistantDock.edgeClearance >= 48 + 20)
    check("the month grid ends above the assistant button",
          calendar.contains(".padding(.bottom, AssistantDock.edgeClearance)"))
    check("every calendar scope (day, week, month, year) keeps dock clearance",
          calendar.components(separatedBy: "AssistantDock.").count - 1 >= 4)

    // MARK: 2. beta mail sources
    check("naver and iCloud are beta", MailSourceCatalog.isBeta("NAVER") && MailSourceCatalog.isBeta("icloud"))
    check("gmail, Outlook and unknown sources carry no beta tag",
          !MailSourceCatalog.isBeta("GOOGLE") && !MailSourceCatalog.isBeta("OUTLOOK")
              && !MailSourceCatalog.isBeta(nil))
    check("the sidebar account rows show the beta tag",
          text("NavSidebar.swift").contains("MailSourceCatalog.isBeta(inbox.provider) { BetaChip() }"))
    let prefs = text("PreferencesView.swift")
    check("settings ▸ Accounts tags beta rows and the Naver connect button",
          prefs.contains("beta: MailSourceCatalog.isBeta(inbox.provider)")
              && prefs.components(separatedBy: "BetaChip()").count - 1 >= 2)
    check("outlook is never offered as a connectable source",
          !files.filter { !$0.lastPathComponent.hasPrefix("SelfCheck") }.contains {
              (try? String(contentsOf: $0, encoding: .utf8))?.contains("account.outlook") ?? false
          })

    // MARK: 3. the two "Auto" settings read apart, in every catalogue
    let languages = ["en", "ko", "de", "es", "fr", "ja", "zh"]
    for language in languages {
        let url = sourceDir.appendingPathComponent("Resources/\(language).lproj/Localizable.strings")
        let table = NSDictionary(contentsOf: url) as? [String: String] ?? [:]
        let reply = table["mode.auto"] ?? ""
        let agent = table["auto.mode.auto"] ?? ""
        check("\(language): reply mode and agent mode name their Auto differently",
              !reply.isEmpty && !agent.isEmpty && reply != agent)
        check("\(language): the beta tag is translated", !(table["common.beta"] ?? "").isEmpty)
    }
    check("en: Auto-reply vs Run safe actions",
          L("mode.auto") != L("auto.mode.auto"))

    // MARK: 4. display time zone
    check("MANUAL + a known zone pins it",
          DisplayTimeZone.pinnedIdentifier(timezone: "America/New_York", mode: "MANUAL") == "America/New_York")
    check("AUTO, null mode and a missing zone follow this Mac",
          DisplayTimeZone.pinnedIdentifier(timezone: "America/New_York", mode: "AUTO") == nil
              && DisplayTimeZone.pinnedIdentifier(timezone: "America/New_York", mode: nil) == nil
              && DisplayTimeZone.pinnedIdentifier(timezone: nil, mode: "MANUAL") == nil)
    check("an unknown zone never pins (no crash, no UTC by accident)",
          DisplayTimeZone.pinnedIdentifier(timezone: "Mars/Olympus_Mons", mode: "MANUAL") == nil
              && DisplayTimeZone.pinnedIdentifier(timezone: "  ", mode: "MANUAL") == nil)

    let decoder = JSONDecoder()
    let newer = try? decoder.decode(MeFlagsResponse.self, from: Data(
        #"{"user":{"files":true,"teamMode":false,"timezone":"Europe/Berlin","timezoneMode":"MANUAL"}}"#.utf8))
    check("/me decodes the zone beside the flags",
          newer?.zone.pinnedIdentifier == "Europe/Berlin" && newer?.user.files == true)
    let older = try? decoder.decode(MeFlagsResponse.self, from: Data(#"{"user":{"files":false}}"#.utf8))
    check("an older /me without the zone still decodes, following this Mac",
          older != nil && older?.zone.pinnedIdentifier == nil)
    let wrongType = try? decoder.decode(MeFlagsResponse.self, from: Data(
        #"{"user":{"timezone":42,"timezoneMode":true}}"#.utf8))
    check("a malformed zone reads as absent", wrongType != nil && wrongType?.zone.pinnedIdentifier == nil)

    // Pinning moves every formatter default; un-pinning restores this Mac's.
    let instant = Date(timeIntervalSince1970: 1_785_313_800)  // 2026-07-29 08:30 UTC
    let model = AppModel(tokenStore: InMemoryTokenStore())
    model.applyDisplayZone(DisplayZonePreference(timezone: "America/Los_Angeles", timezoneMode: "MANUAL"))
    let pinnedZone = DisplayTimeZone.current.identifier
    let pinnedKey = localDayKey(Date(timeIntervalSince1970: 1_785_283_200))  // 2026-07-29 00:00 UTC
    let pinnedLabel = mailTimeLabel(iso: "2026-07-29T08:12:00.000Z", now: instant, locale: Locale(identifier: "en_US_POSIX"))
    check("a MANUAL zone pins the display zone", pinnedZone == "America/Los_Angeles")
    check("day buckets follow the pinned zone (00:00 UTC is the 28th in LA)", pinnedKey == "2026-07-28")
    check("mail times follow the pinned zone (08:12 UTC → 01:12 in LA)", pinnedLabel == "01:12")
    check("the editor and banners read the display zone",
          text("CalendarEditor.swift").contains(".environment(\\.timeZone, DisplayTimeZone.current)")
              && text("Notifications.swift").contains("style.timeZone = DisplayTimeZone.current"))
    model.applyDisplayZone(DisplayZonePreference(timezone: "America/Los_Angeles", timezoneMode: "AUTO"))
    check("AUTO un-pins back to this Mac's zone",
          model.displayTimeZoneID == nil && DisplayTimeZone.current == TimeZone.current)
    model.applyDisplayZone(DisplayZonePreference(timezone: "Asia/Tokyo", timezoneMode: "MANUAL"))
    for field in AppModel.accountFields() { field.reset(model) }
    check("sign-out un-pins the zone", DisplayTimeZone.current == TimeZone.current)
    DisplayTimeZone.pin(identifier: nil)
    return results
}
