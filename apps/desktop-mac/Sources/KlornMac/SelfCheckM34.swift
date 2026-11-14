import AppKit
import Foundation
import SwiftUI

// Self-check for the M3 / M4 Mac design decisions (founder, LOCKED,
// 2026-11-13), run by `KlornMac --self-check`:
// M3 — outline sidebar symbols in the accent, the floating assistant button
//      replaced by a toolbar button + trailing panel, no `sparkles` in chrome.
// M4 — five Settings tabs, a grouped-Form General pane, the window title and
//      height following the pane, a stored "appearance" tab migrated.
// Pure rules and source pins only: nothing opens a window, sends a key or
// touches the Keychain.

/// Every M3/M4 check, as (name, passed).
@MainActor
func m34SelfChecks(sourceDir: URL) -> [(String, Bool)] {
    print("Mac M3/M4 (sidebar symbols, assistant toolbar, Settings tabs):")
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let files = swiftSources(under: sourceDir)
    func text(_ name: String) -> String {
        files.first { $0.lastPathComponent == name }
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
    func symbolExists(_ name: String) -> Bool {
        NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil
    }

    // MARK: M3.1 sidebar symbols

    check("sidebar symbols: house, envelope, calendar, folder, text.bubble",
          NavSection.allCases.map(\.icon) == ["house", "envelope", "calendar", "folder", "text.bubble"])
    check("a selected sidebar row uses the .fill variant where SF Symbols has one",
          NavSection.allCases.map(\.selectedIcon)
              == ["house.fill", "envelope.fill", "calendar", "folder.fill", "text.bubble.fill"])
    check("every sidebar symbol (plain and selected) exists in SF Symbols",
          NavSection.allCases.allSatisfy { symbolExists($0.icon) && symbolExists($0.selectedIcon) })
    let sidebar = text("NavSidebar.swift")
    check("the sidebar icons wear the accent and the label's font",
          sidebar.contains(".foregroundStyle(Theme.accent)")
              && sidebar.contains("Image(systemName: selected ? (selectedIcon ?? icon) : icon)")
              && !sidebar.contains(".font(Theme.Typo.icon)"))
    check("the Settings footer keeps gearshape",
          sidebar.contains("Image(systemName: \"gearshape\")"))

    // MARK: M3.2 assistant entry point

    let shell = text("MainShell.swift")
    check("the floating assistant button is gone",
          !files.contains { $0.lastPathComponent == "AssistantDock.swift" }
              && !files.filter { !$0.lastPathComponent.hasPrefix("SelfCheck") }.contains {
                  (try? String(contentsOf: $0, encoding: .utf8))?.contains("struct AssistantDock") ?? false
              }
              && !shell.contains("AssistantDock()"))
    check("the assistant toolbar item is labelled, uses text.bubble and its symbol exists",
          AssistantToolbar.symbol == "text.bubble" && symbolExists(AssistantToolbar.symbol)
              && L(AssistantToolbar.labelKey) != AssistantToolbar.labelKey)
    let window = text("MainWindow.swift")
    check("the main window gets a toolbar with the assistant item, title visible on the button",
          window.contains("NSToolbar(identifier:")
              && window.contains("AssistantToolbar.makeItem(")
              && text("AssistantPanel.swift").contains("imagePosition = .imageLeading"))
    check("the panel shows only signed in, with no modal, outside the Assistant section",
          AssistantPanelRules.isVisible(open: true, signedIn: true, modalOpen: false, section: .mail)
              && !AssistantPanelRules.isVisible(open: false, signedIn: true, modalOpen: false, section: .mail)
              && !AssistantPanelRules.isVisible(open: true, signedIn: false, modalOpen: false, section: .mail)
              && !AssistantPanelRules.isVisible(open: true, signedIn: true, modalOpen: true, section: .mail)
              && !AssistantPanelRules.isVisible(open: true, signedIn: true, modalOpen: false, section: .assistant))
    check("the panel is a trailing column in the shell, not an overlay",
          shell.contains("AssistantPanel()")
              && !shell.contains("alignment: .bottomTrailing"))
    check("an open panel widens the window floor so the content keeps its own",
          AssistantPanelRules.minContentWidth(panelVisible: false) == MainWindowRules.minSize.width
              && AssistantPanelRules.minContentWidth(panelVisible: true)
                  == MainWindowRules.minSize.width + AssistantPanelRules.width
              && AssistantPanelRules.minContentWidth(panelVisible: true) <= 1280)
    let commands = text("AppCommands.swift")
    check("⌘J toggles the panel from the menu",
          commands.contains("KeyboardShortcut(\"j\", modifiers: .command)")
              && commands.contains("AssistantPanelMenuItem("))
    let panel = text("AssistantPanel.swift")
    check("the panel keeps the dock's thread and context line, no send path of its own",
          panel.contains("AssistantThread(showsStarters: false)")
              && panel.contains("model.openedEmail?.subject")
              && !panel.contains("sendChat(") && !panel.contains("sendReply("))

    // MARK: M3.3 no sparkles in chrome

    let sparkly = files
        .filter { !$0.lastPathComponent.hasPrefix("SelfCheck") }
        .filter { (try? String(contentsOf: $0, encoding: .utf8))?.contains("\"sparkles\"") ?? false }
        .map(\.lastPathComponent)
    check("no \"sparkles\" symbol anywhere in the app sources (offenders: \(sparkly))", sparkly.isEmpty)

    // MARK: M4.1 Settings tabs

    check("Settings has five tabs: General, Accounts, Notifications, Assistant, Privacy",
          SettingsTab.allCases.map(\.rawValue)
              == ["general", "accounts", "notifications", "assistant", "privacy"])
    check("Settings tab symbols: gearshape, at, bell, text.bubble, lock",
          SettingsTab.allCases.map(\.systemImage) == ["gearshape", "at", "bell", "text.bubble", "lock"])
    check("every Settings tab symbol exists in SF Symbols",
          SettingsTab.allCases.allSatisfy { symbolExists($0.systemImage) })

    // MARK: M4.2 General pane

    check("General holds startup, appearance (theme + language) and the Dock badge",
          Array(SettingsTab.general.sections.prefix(3)) == [.startup, .appearance, .dock])
    check("the Dock badge left Notifications for General",
          !SettingsTab.notifications.sections.contains(.dock))
    let prefs = text("PreferencesView.swift")
    check("General is a grouped Form with Startup / Appearance / Dock sections",
          prefs.contains(".formStyle(.grouped)")
              && prefs.contains("L(\"prefs.group.startup\")")
              && prefs.contains("L(\"prefs.group.appearance\")")
              && prefs.contains("L(\"prefs.group.dock\")"))
    check("theme is a segmented control and language a menu, in the same group",
          prefs.contains(".pickerStyle(.segmented)") && prefs.contains(".pickerStyle(.menu)")
              && prefs.contains("$settings.appearance") && prefs.contains("$settings.appLanguage"))

    // MARK: M4.3 window and pane behaviour

    check("a stored \"appearance\" tab migrates to General",
          SettingsTab.restored("appearance") == .general
              && SettingsTab.migratedRaw("appearance") == "general"
              && SettingsTab.migratedRaw("privacy") == "privacy")
    let settingsWindow = text("SettingsWindow.swift")
    check("the window title follows the selected pane",
          settingsWindow.contains("window.title = title")
              && settingsWindow.contains("SettingsWindowTracker(title: selected.title)"))
    check("the window height fits the pane, capped with scrolling",
          !settingsWindow.contains("height: SettingsMetrics.height)")
              && prefs.contains("minHeight: SettingsMetrics.minHeight, maxHeight: SettingsMetrics.maxHeight")
              && SettingsMetrics.maxHeight + SettingsMetrics.chromeHeight
                  <= SettingsMetrics.smallestVisibleHeight
              && SettingsMetrics.minHeight < SettingsMetrics.maxHeight)

    // Measured, not assumed: each pane's fitting height, hosted windowless.
    let signedOut = AppModel(tokenStore: InMemoryTokenStore())
    func fittedHeight(_ tab: SettingsTab) -> CGFloat {
        NSHostingView(rootView: tab.pane.environment(signedOut)).fittingSize.height
    }
    let heights = Dictionary(uniqueKeysWithValues: SettingsTab.allCases.map { ($0, fittedHeight($0)) })
    print("    measured pane heights (signed out): "
          + SettingsTab.allCases.map { "\($0.rawValue)=\(Int(heights[$0] ?? 0))" }.joined(separator: " "))
    check("every pane measures between the floor and the cap",
          heights.values.allSatisfy { $0 >= SettingsMetrics.minHeight && $0 <= SettingsMetrics.maxHeight })
    check("a short pane is shorter than a long one (the window follows the pane)",
          (heights[.privacy] ?? 0) < (heights[.general] ?? 0))

    // MARK: Localization of the new strings

    let newKeys = [
        "assistant.toolbar.label", "assistant.toolbar.help", "menu.assistant.show", "menu.assistant.hide",
        "prefs.group.startup", "prefs.group.appearance", "prefs.group.dock", "prefs.group.updates",
        "prefs.group.keyboard", "prefs.group.support", "prefs.group.about", "prefs.group.mail",
    ]
    let langs = ["en", "ko", "ja", "zh", "es", "fr", "de"]
    let missing = langs.flatMap { lang -> [String] in
        let url = sourceDir.appendingPathComponent("Resources/\(lang).lproj/Localizable.strings")
        let table = (NSDictionary(contentsOf: url) as? [String: String]) ?? [:]
        return newKeys.filter { (table[$0] ?? "").isEmpty }.map { "\(lang):\($0)" }
    }
    check("every new M3/M4 string exists in all seven catalogues (missing: \(missing))", missing.isEmpty)
    return results
}
