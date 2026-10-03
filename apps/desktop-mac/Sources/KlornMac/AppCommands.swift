import SwiftUI

/// Every app-menu command (productization plan, macOS M1). Each one maps to
/// an action the app already had — the menus add reach, not features.
enum MenuCommand: Hashable {
    case compose
    case find
    case reply
    case dismiss
    case moveTo(Tier)
    case go(ListMode)
}

/// The slice of app state that decides which commands are live.
struct MenuState: Equatable {
    var signedIn: Bool
    var fullViewOpen: Bool
    var modalOpen: Bool
    /// The lane of the firewall item the reading pane shows, nil if none.
    var targetTier: Tier?
    var emailLoaded: Bool
    var readerReplying: Bool
    var teamModeAvailable: Bool

    @MainActor
    init(model: AppModel) {
        signedIn = model.phase == .signedIn
        fullViewOpen = model.isFullViewOpen
        modalOpen = model.fullViewModalOpen
        targetTier = model.menuTargetItem?.tier
        emailLoaded = model.openedEmail != nil
        readerReplying = model.readerReplying
        teamModeAvailable = model.teamModeAvailable
    }

    init(
        signedIn: Bool, fullViewOpen: Bool, modalOpen: Bool, targetTier: Tier?,
        emailLoaded: Bool, readerReplying: Bool, teamModeAvailable: Bool
    ) {
        self.signedIn = signedIn
        self.fullViewOpen = fullViewOpen
        self.modalOpen = modalOpen
        self.targetTier = targetTier
        self.emailLoaded = emailLoaded
        self.readerReplying = readerReplying
        self.teamModeAvailable = teamModeAvailable
    }
}

/// Pure rules for the app menus, pinned by the self-check.
enum MenuRules {
    /// The Go menu's destinations, in menu order. Mirrors the sidebar; Teams
    /// is filtered by `isEnabled` like the sidebar row it stands for.
    static let destinations: [ListMode] = [
        .inbox, .calendar, .proposals, .commitments, .waitingOn,
        .mailbox(.sent), .mailbox(.drafts), .mailbox(.archived), .teams,
    ]

    static func isEnabled(_ command: MenuCommand, in s: MenuState) -> Bool {
        guard s.signedIn else { return false }
        // Message commands act on the mail visible in the reading pane, so
        // they need the full view up, no modal over it, and a firewall item.
        let canActOnMessage = s.fullViewOpen && !s.modalOpen && s.targetTier != nil
        switch command {
        case .compose, .find:
            return !s.modalOpen
        case .go(let mode):
            return !s.modalOpen && (mode != .teams || s.teamModeAvailable)
        case .reply:
            // Re-drafting while the inline composer is open would wipe it.
            return canActOnMessage && s.emailLoaded && !s.readerReplying
        case .dismiss:
            return canActOnMessage
        case .moveTo(let tier):
            return canActOnMessage && s.targetTier != tier
        }
    }

    /// Key equivalents. Every one carries ⌘ or ⌃: a bare key would be eaten
    /// by the menu before a text field sees it, and the reading pane already
    /// binds bare 1/2/3 to its quick replies. Lane moves use ⌃⌘1–5 (Mail's
    /// "move to" convention) rather than ⌃1–5, which macOS binds to
    /// "Switch to Desktop N" when Mission Control shortcuts are on.
    /// Dismiss has none on purpose: ⌘⌫ deletes to line start in the reply
    /// field, and a mis-aimed dismiss is not worth a chord.
    static func shortcut(for command: MenuCommand) -> KeyboardShortcut? {
        switch command {
        case .compose: return KeyboardShortcut("n", modifiers: .command)
        case .find: return KeyboardShortcut("f", modifiers: .command)
        case .reply: return KeyboardShortcut("r", modifiers: .command)
        case .dismiss: return nil
        case .moveTo(let tier):
            guard let index = Tier.allCases.firstIndex(of: tier) else { return nil }
            return KeyboardShortcut(
                KeyEquivalent(Character("\(index + 1)")), modifiers: [.control, .command])
        case .go(let mode):
            let numbered: [ListMode] = [.inbox, .calendar, .proposals, .commitments, .waitingOn]
            guard let index = numbered.firstIndex(of: mode) else { return nil }
            return KeyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
        }
    }

    /// Menu title for a Go destination — the sidebar's own label for it.
    static func title(for mode: ListMode) -> String {
        switch mode {
        case .inbox: L("section.inbox")
        case .calendar: L("section.calendar")
        case .proposals: L("proposals.title")
        case .commitments: L("section.commitments")
        case .waitingOn: L("waiting.title")
        case .mailbox(let box): box.label
        case .teams: L("teams.title")
        case .tier(let tier): tier.label
        case .label(let filter): filter.label
        }
    }
}

/// The app menus. Only visible while the app is `.regular` (bar expanded or
/// full, Settings open, or show-in-Dock on) — the menu bar belongs to the
/// frontmost regular app, which is the Cmd+Tab compromise working as meant.
struct KlornCommands: Commands {
    let model: AppModel
    let perform: @MainActor (MenuCommand) -> Void

    var body: some Commands {
        // No document model: Compose is the app's "New".
        CommandGroup(replacing: .newItem) {
            CommandButton(model: model, command: .compose, title: L("menu.compose"), perform: perform)
        }
        CommandGroup(after: .textEditing) {
            CommandButton(model: model, command: .find, title: L("menu.find"), perform: perform)
        }
        CommandMenu(L("menu.message")) {
            CommandButton(
                model: model, command: .reply, title: L("reading.replyWithAI"), perform: perform)
            CommandButton(model: model, command: .dismiss, title: L("mail.dismiss"), perform: perform)
            Divider()
            Menu(L("menu.moveToLane")) {
                ForEach(Tier.allCases) { tier in
                    CommandButton(
                        model: model, command: .moveTo(tier), title: tier.label, perform: perform)
                }
            }
        }
        CommandMenu(L("menu.go")) {
            GoMenuItems(model: model, perform: perform)
        }
    }
}

/// Go menu body. A View (not inline Commands content) so it observes the
/// model and can hide Teams exactly when the sidebar does.
private struct GoMenuItems: View {
    let model: AppModel
    let perform: @MainActor (MenuCommand) -> Void

    var body: some View {
        ForEach(MenuRules.destinations, id: \.self) { mode in
            if mode == .mailbox(.sent) { Divider() }
            if mode != .teams || model.teamModeAvailable {
                CommandButton(
                    model: model, command: .go(mode), title: MenuRules.title(for: mode),
                    perform: perform)
            }
        }
    }
}

/// One menu item: title, shortcut and enablement all come from MenuRules.
/// A View so SwiftUI observation re-evaluates enablement as the model moves.
private struct CommandButton: View {
    let model: AppModel
    let command: MenuCommand
    let title: String
    let perform: @MainActor (MenuCommand) -> Void

    var body: some View {
        Button(title) { perform(command) }
            .keyboardShortcut(MenuRules.shortcut(for: command))
            .disabled(!MenuRules.isEnabled(command, in: MenuState(model: model)))
    }
}
