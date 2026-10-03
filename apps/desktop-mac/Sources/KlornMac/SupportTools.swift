import AppKit

/// The "App & support" disclosure in both sidebars. Restart and the
/// connection-status readout are support tools, not daily controls: they show
/// only when the disclosure is Option-clicked — the standard macOS way to
/// reveal advanced items (the menu-bar menu lists Restart only when opened
/// with Option). Assistive tech reaches them through the disclosure's named
/// accessibility action instead of a modifier key (`revealed`).
enum MaintenanceDisclosure {
    struct State: Equatable {
        var expanded: Bool
        var supportTools: Bool
    }

    /// Next state after a click. An Option-click always lands expanded with
    /// the support tools showing; a plain click toggles the disclosure and
    /// never reveals them (collapsing hides them again). Pure for the harness.
    static func toggled(_ state: State, optionHeld: Bool) -> State {
        if optionHeld && !state.supportTools { return revealed }
        if state.expanded { return State(expanded: false, supportTools: false) }
        return State(expanded: true, supportTools: false)
    }

    /// The state the "Show support tools" accessibility action jumps to.
    static let revealed = State(expanded: true, supportTools: true)

    /// Whether these modifier flags are the reveal gesture (Option). A pure
    /// value check, so the harness never touches AppKit objects.
    static func isRevealGesture(_ flags: NSEvent.ModifierFlags) -> Bool {
        flags.contains(.option)
    }

    /// Whether Option is held right now (read at click time).
    @MainActor static var optionHeld: Bool { isRevealGesture(NSEvent.modifierFlags) }
}
