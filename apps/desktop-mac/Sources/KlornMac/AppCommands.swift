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

/// A Reply request from the menu, bound to the item it was issued for.
struct ReplyRequest: Equatable, Sendable {
    let token: Int
    let itemId: String
}

/// The slice of app state that decides which commands are live.
struct MenuState: Equatable {
    var signedIn: Bool
    var fullViewOpen: Bool
    /// The bar's panel is the key window (not Settings or another window).
    var barIsKey: Bool
    var modalOpen: Bool
    /// The lane of the firewall item the reading pane shows, nil if none.
    var targetTier: Tier?
    var emailLoaded: Bool
    var readerReplying: Bool
    var teamModeAvailable: Bool
    /// The list column currently shows the search field (Find needs no
    /// mode switch, so it can't unmount the reading pane).
    var listHasSearchField: Bool

    @MainActor
    init(model: AppModel) {
        signedIn = model.phase == .signedIn
        fullViewOpen = model.isFullViewOpen
        barIsKey = model.barPanelIsKey
        modalOpen = model.fullViewModalOpen
        targetTier = model.menuTargetItem?.tier
        emailLoaded = model.openedEmail != nil
        readerReplying = model.readerReplying
        teamModeAvailable = model.teamModeAvailable
        listHasSearchField = model.listMode.hasSearchField
    }

    init(
        signedIn: Bool, fullViewOpen: Bool, barIsKey: Bool, modalOpen: Bool, targetTier: Tier?,
        emailLoaded: Bool, readerReplying: Bool, teamModeAvailable: Bool,
        listHasSearchField: Bool
    ) {
        self.signedIn = signedIn
        self.fullViewOpen = fullViewOpen
        self.barIsKey = barIsKey
        self.modalOpen = modalOpen
        self.targetTier = targetTier
        self.emailLoaded = emailLoaded
        self.readerReplying = readerReplying
        self.teamModeAvailable = teamModeAvailable
        self.listHasSearchField = listHasSearchField
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
        // they need the full view up AND key (not Settings), no modal over
        // it, and a firewall item.
        let canActOnMessage = s.fullViewOpen && s.barIsKey && !s.modalOpen && s.targetTier != nil
        // Anything that clears the selection or switches the list mode
        // unmounts the inline reply composer and loses what was typed, so
        // those commands wait until the composer is closed.
        let keepsDraft = !s.readerReplying
        switch command {
        case .compose:
            return !s.modalOpen
        case .find:
            return !s.modalOpen && (s.listHasSearchField || keepsDraft)
        case .go(let mode):
            return !s.modalOpen && keepsDraft && (mode != .teams || s.teamModeAvailable)
        case .reply:
            // Re-drafting while the inline composer is open would wipe it.
            return canActOnMessage && s.emailLoaded && keepsDraft
        case .dismiss:
            return canActOnMessage && keepsDraft
        case .moveTo(let tier):
            return canActOnMessage && keepsDraft && s.targetTier != tier
        }
    }

    /// Whether the reading pane should act on a menu Reply: only for the
    /// item it was issued for, with the email loaded and no reply already
    /// being composed. Pure for the harness.
    static func shouldStartReply(
        _ request: ReplyRequest?, selectedItemId: String?, replying: Bool, emailLoaded: Bool
    ) -> Bool {
        guard let request, let selectedItemId else { return false }
        return request.itemId == selectedItemId && !replying && emailLoaded
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
