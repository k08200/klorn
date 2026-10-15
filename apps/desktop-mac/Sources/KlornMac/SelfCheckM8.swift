import Foundation

// Self-check for M8 follow-ups, run by `KlornMac --self-check`: the account
// editors that lived in the deleted full sidebar, and the menus now that the
// main window is the only surface (the `macMainWindow` OFF mode was removed
// with the pill, founder decision 2026-10-15).

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

    // MARK: menus with the main window as the only surface (2026-10-15)
    let closed = MenuState(
        signedIn: true, fullViewOpen: false, mailSurfaceIsKey: false, modalOpen: false,
        targetTier: nil, emailLoaded: false, readerReplying: false, teamModeAvailable: true,
        listHasSearchField: true)
    let navCommands: [MenuCommand] = [.find, .go(.inbox), .go(.calendar), .section(.mail), .section(.today)]
    check("signed in: Find, Go and the sections are enabled even with the window closed",
          navCommands.allSatisfy { MenuRules.isEnabled($0, in: closed) }
          && MenuRules.isEnabled(.compose, in: closed))
    var signedOut = closed
    signedOut.signedIn = false
    check("signed out: Find, Go and the sections stay disabled",
          navCommands.allSatisfy { !MenuRules.isEnabled($0, in: signedOut) })
    let perform = text("KlornApp.swift").components(separatedBy: "func perform(_ command: MenuCommand) {")
        .dropFirst().first?.components(separatedBy: "private func ensureMainWindow()").first ?? ""
    check("Find, Go and the sections open the main window before acting",
          perform.components(separatedBy: "ensureMainWindow()").count - 1 == 3
          && !perform.contains("macMainWindow"))
    return results
}
