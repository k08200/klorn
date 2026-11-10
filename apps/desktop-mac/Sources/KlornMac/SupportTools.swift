import AppKit
import SwiftUI

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

/// Settings ▸ General "App & support": the maintenance block the expanded
/// panel's account column carried until the panel was removed (founder
/// decision 2026-10-15). Same contents and the same Option-click reveal for
/// the support tools, so nothing a user could reach before is lost.
struct SupportSection: View {
    @Environment(AppModel.self) private var model
    @State private var maintenance = MaintenanceDisclosure.State(expanded: false, supportTools: false)

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let version = model.updateAvailable { UpdateRow(version: version) }
            Button {
                let next = MaintenanceDisclosure.toggled(
                    maintenance, optionHeld: MaintenanceDisclosure.optionHeld)
                withAnimation(.easeOut(duration: 0.15)) { maintenance = next }
            } label: {
                HStack(spacing: 6) {
                    Text(L("account.maintenance")).font(.body).foregroundStyle(Theme.text)
                    Image(systemName: "chevron.right").font(.caption2)
                        .foregroundStyle(Theme.textDim)
                        .rotationEffect(maintenance.expanded ? .degrees(90) : .zero)
                        .accessibilityHidden(true)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L("account.maintenance"))
            .accessibilityValue(maintenance.expanded ? L("a11y.expanded") : L("a11y.collapsed"))
            // VoiceOver / Switch Control / Full Keyboard Access path to the
            // Option-click support tools.
            .accessibilityAction(named: L("account.showSupportTools")) {
                maintenance = MaintenanceDisclosure.revealed
            }
            if maintenance.expanded {
                if maintenance.supportTools {
                    SubtleTextButton(title: L("menu.restart")) { AppRestart.relaunch() }
                    SubtleTextButton(title: L("menu.diagnostics")) {
                        Task { await model.runDiagnostics() }
                    }
                }
                // Sits with diagnostics on purpose: someone who just ran a
                // diagnostic and is still stuck needs the next step here.
                SubtleTextButton(title: L("menu.contactSupport")) { openSupportMail() }
                if maintenance.supportTools { DiagnosticsBlock() }
            }
        }
    }
}
