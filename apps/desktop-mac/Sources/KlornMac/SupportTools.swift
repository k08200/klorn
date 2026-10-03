import AppKit

/// The "App & support" disclosure in both sidebars. Restart and the
/// connection-status readout are support tools, not daily controls: they show
/// only when the disclosure is Option-clicked — the standard macOS way to
/// reveal advanced items (cf. Option on the menu-bar menu, where Restart is
/// the alternate of Quit). Support can still walk anyone to them.
enum MaintenanceDisclosure {
    struct State: Equatable {
        var expanded: Bool
        var supportTools: Bool
    }

    /// Next state after a click. An Option-click always lands expanded with
    /// the support tools showing; a plain click toggles the disclosure and
    /// never reveals them (collapsing hides them again). Pure for the harness.
    static func toggled(_ state: State, optionHeld: Bool) -> State {
        if optionHeld && !state.supportTools { return State(expanded: true, supportTools: true) }
        if state.expanded { return State(expanded: false, supportTools: false) }
        return State(expanded: true, supportTools: false)
    }

    /// Whether Option is held right now (read at click time).
    @MainActor static var optionHeld: Bool { NSEvent.modifierFlags.contains(.option) }
}
