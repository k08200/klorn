import Foundation

// Self-check for M8 follow-ups, run by `KlornMac --self-check`: the account
// editors that lived in the deleted full sidebar, and a coherent mode for a
// user who stored `macMainWindow` OFF (no main window, the expanded panel is
// the largest view).

/// Every M8 follow-up check, as (name, passed).
@MainActor
func m8SelfChecks(sourceDir: URL) -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let files = swiftSources(under: sourceDir)
    func text(_ name: String) -> String {
        files.first { $0.lastPathComponent == name }
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
    func users(of needle: String) -> [String] {
        files.map(\.lastPathComponent)
            .filter { !$0.hasPrefix("SelfCheck") && text($0).contains(needle) }.sorted()
    }

    // MARK: account editors (company domains, triage priorities)
    check("Settings ▸ Accounts mounts the company-domains and priorities editors",
          users(of: "CompanyDomainsRow()") == ["PreferencesView.swift"]
          && users(of: "PrioritiesRow()") == ["PreferencesView.swift"])
    check("both setters have a Settings call site besides the one-time purpose prompt",
          users(of: "model.setCompanyDomains(") == ["AccountRows.swift", "TierGuide.swift"]
          && users(of: "model.setTriagePriorities(") == ["AccountRows.swift", "TierGuide.swift"])
    check("the account editors' strings are localized",
          ["company.label", "company.none", "company.placeholder", "company.save",
           "priorities.label", "priorities.none", "priorities.placeholder"]
              .allSatisfy { L($0) != $0 })

    // MARK: main window stored OFF
    check("the expanded panel offers the full-view button only with the main window",
          ExpandedPanelRules.showsFullViewButton(macMainWindow: true)
          && !ExpandedPanelRules.showsFullViewButton(macMainWindow: false))
    var on = MenuState(
        signedIn: true, fullViewOpen: false, mailSurfaceIsKey: false, modalOpen: false,
        targetTier: nil, emailLoaded: false, readerReplying: false, teamModeAvailable: true,
        listHasSearchField: true)
    on.mainWindowAvailable = true
    var off = on
    off.mainWindowAvailable = false
    let navCommands: [MenuCommand] = [.find, .go(.inbox), .go(.calendar), .section(.mail), .section(.today)]
    check("main window on: Find, Go and the sections stay live",
          navCommands.allSatisfy { MenuRules.isEnabled($0, in: on) })
    check("main window off: Find, Go and the sections are disabled (nothing to show them in)",
          navCommands.allSatisfy { !MenuRules.isEnabled($0, in: off) })
    check("main window off: New Email still works (the composer is its own window)",
          MenuRules.isEnabled(.compose, in: off))
    let perform = text("KlornApp.swift").components(separatedBy: "func perform(_ command: MenuCommand) {")
        .dropFirst().first?.components(separatedBy: "private func ensureFullView()").first ?? ""
    check("main window off: the delegate drops Find/Go/section, so no search focus is left pending",
          perform.contains("guard MenuRules.mainWindowCommandAllowed(command, macMainWindow: model.settings.macMainWindow) else { return }")
          && MenuRules.mainWindowCommandAllowed(.find, macMainWindow: true)
          && !MenuRules.mainWindowCommandAllowed(.find, macMainWindow: false)
          && !MenuRules.mainWindowCommandAllowed(.go(.inbox), macMainWindow: false)
          && !MenuRules.mainWindowCommandAllowed(.section(.mail), macMainWindow: false)
          && MenuRules.mainWindowCommandAllowed(.compose, macMainWindow: false))
    check("a fallback to the expanded panel raises the Settings hint; resting clears it",
          text("TopBarController.swift").contains("model.mainWindowOffHint = true")
          && text("TopBarController.swift").contains("model.mainWindowOffHint = false"))
    check("the hint offers Settings, and Settings opens on General where the switch is",
          text("ExpandedDashboard.swift").contains("if model.mainWindowOffHint")
          && text("ExpandedDashboard.swift").contains("actions.onOpenMainWindowSettings")
          && text("TopBarController.swift").contains("SettingsTab.general.rawValue"))
    check("the main-window switch is always visible in Settings (no Option needed to turn it back on)",
          !text("MainWindow.swift").contains("optionHeld"))
    let hintKeys = ["bar.mainWindowOff.hint", "bar.mainWindowOff.settings"]
    check("the hint strings exist in every locale",
          hintKeys.allSatisfy { L($0) != $0 }
          && ["en", "ko", "de", "es", "fr", "ja", "zh"].allSatisfy { locale in
              let strings = (try? String(
                  contentsOf: sourceDir.appendingPathComponent("Resources/\(locale).lproj/Localizable.strings"),
                  encoding: .utf8)) ?? ""
              return hintKeys.allSatisfy { strings.contains("\"\($0)\" = ") }
          })

    // MARK: same-state requests
    check("a same-state request on a visible panel does not re-render it",
          !TopBarController.needsRender(current: .expanded, requested: .expanded, panelVisible: true)
          && TopBarController.needsRender(current: .expanded, requested: .expanded, panelVisible: false)
          && TopBarController.needsRender(current: .collapsed, requested: .expanded, panelVisible: true))
    return results
}
