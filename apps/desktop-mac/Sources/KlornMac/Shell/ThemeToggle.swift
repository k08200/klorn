import AppKit

/// The light/dark toggle beside the Assistant button (founder, 2026-11-13,
/// LOCKED). It writes the one appearance setting (`AppSettings.appearance`),
/// so Settings ▸ General shows the same choice; "System" becomes the
/// explicit opposite of what is on screen now.
///
/// The symbol shows the CURRENT appearance (sun = light, moon = dark), the
/// way macOS's own appearance controls depict state; the tooltip and the
/// VoiceOver label name the action ("Switch to Dark Mode"), so the button
/// never has to be read as a picture of its target.
enum ThemeToggleRules {
    /// What a click picks: always explicit, always the other appearance.
    static func next(effectiveDark: Bool) -> AppearanceChoice {
        effectiveDark ? .light : .dark
    }

    /// The appearance on screen for a stored choice.
    static func isEffectivelyDark(choice: AppearanceChoice, systemDark: Bool) -> Bool {
        switch choice {
        case .system: systemDark
        case .light: false
        case .dark: true
        }
    }

    static func symbol(effectiveDark: Bool) -> String {
        effectiveDark ? "moon" : "sun.max"
    }

    /// The action, as the tooltip and the label say it.
    static func actionKey(effectiveDark: Bool) -> String {
        effectiveDark ? "theme.toggle.toLight" : "theme.toggle.toDark"
    }

    static func isDark(_ appearance: NSAppearance) -> Bool {
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    }
}

/// The toolbar item. AppKit, like `AssistantToolbar`: the window is an
/// AppKit `NSWindow` (see `MainWindowController`).
@MainActor
enum ThemeToolbar {
    static let itemIdentifier = NSToolbarItem.Identifier("klorn.theme")
    static let labelKey = "theme.toggle.label"

    static func makeItem(target: AnyObject, action: Selector) -> NSToolbarItem {
        let button = NSButton(image: NSImage(), target: target, action: action)
        button.bezelStyle = .toolbar
        button.imagePosition = .imageOnly
        let item = NSToolbarItem(itemIdentifier: itemIdentifier)
        item.label = L(labelKey)
        item.paletteLabel = L(labelKey)
        item.view = button
        return item
    }

    /// Point the button at the appearance now on screen.
    static func update(_ button: NSButton?, effectiveDark: Bool) {
        guard let button else { return }
        let action = L(ThemeToggleRules.actionKey(effectiveDark: effectiveDark))
        button.image = NSImage(
            systemSymbolName: ThemeToggleRules.symbol(effectiveDark: effectiveDark),
            accessibilityDescription: action)
        button.toolTip = action
        button.setAccessibilityLabel(action)
    }
}

extension AppSettings {
    /// One click of the toolbar toggle.
    @MainActor
    func toggleAppearance(effectiveDark: Bool) {
        appearance = ThemeToggleRules.next(effectiveDark: effectiveDark)
    }
}
