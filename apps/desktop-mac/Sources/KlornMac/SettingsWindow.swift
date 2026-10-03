import AppKit
import SwiftUI

/// One existing Preferences section. The Settings window regroups these into
/// tabs; it adds no new settings (productization plan, macOS M0).
enum PrefsSection: CaseIterable, Hashable, Sendable {
    case general, topBar, keyboard, about
    case account, inboxes
    case mode, behaviour, replies
    case banners, interrupts
    case appearance, language
    case mail

    /// Server-backed sections only make sense with an account behind them.
    var requiresSignIn: Bool {
        switch self {
        case .inboxes, .mode, .behaviour, .replies, .interrupts: true
        default: false
        }
    }
}

/// The Settings window's tabs, in display order. Names follow the settings
/// IA in `docs/design/productization-plan.md` §1 for the groups the Mac app
/// already has; plan groups with no Mac settings yet (Lanes & rules, Team,
/// Integrations, billing) are deliberately absent rather than shown empty.
/// `general` is the macOS-convention home for app chrome (login item,
/// updates, top bar, hotkey, about), which the web IA has no slot for.
enum SettingsTab: String, CaseIterable, Identifiable, Sendable {
    case general, accounts, assistant, notifications, appearance, privacy

    var id: String { rawValue }
    var titleKey: String { "settings.tab.\(rawValue)" }
    var title: String { L(titleKey) }

    var systemImage: String {
        switch self {
        case .general: "gearshape"
        case .accounts: "person.crop.circle"
        case .assistant: "sparkles"
        case .notifications: "bell.badge"
        case .appearance: "paintbrush"
        case .privacy: "hand.raised"
        }
    }

    var sections: [PrefsSection] {
        switch self {
        case .general: [.general, .topBar, .keyboard, .about]
        case .accounts: [.account, .inboxes]
        case .assistant: [.mode, .behaviour, .replies]
        case .notifications: [.banners, .interrupts]
        case .appearance: [.appearance, .language]
        case .privacy: [.mail]
        }
    }

    /// What the tab draws for the current sign-in state. Pure for the harness.
    func visibleSections(signedIn: Bool) -> [PrefsSection] {
        sections.filter { signedIn || !$0.requiresSignIn }
    }

    /// The persisted selection, falling back to the first tab for a value
    /// written by a build that had a tab this one no longer has.
    static func restored(_ raw: String) -> SettingsTab {
        SettingsTab(rawValue: raw) ?? .general
    }
}

/// Fixed Settings window size. Every tab scrolls inside it, so content can
/// never grow the window (the content-overflow clipping lesson, 2026-08-20),
/// and the height fits the smallest supported display's visible area.
enum SettingsMetrics {
    static let width: CGFloat = 560
    static let height: CGFloat = 560
    /// Title bar + toolbar tab strip above the content, approximately.
    static let chromeHeight: CGFloat = 90
    /// Visible height of a 1280×800 display minus menu bar and Dock.
    static let smallestVisibleHeight: CGFloat = 700
}

/// Root of the `Settings` scene: a native toolbar-tab Settings window.
struct SettingsRoot: View {
    @Environment(AppModel.self) private var model
    @AppStorage("settings.selectedTab") private var selectedRaw = SettingsTab.general.rawValue

    var body: some View {
        TabView(selection: Binding(
            get: { SettingsTab.restored(selectedRaw) },
            set: { selectedRaw = $0.rawValue })
        ) {
            ForEach(SettingsTab.allCases) { tab in
                PreferencesView(tab: tab)
                    .tabItem { Label(tab.title, systemImage: tab.systemImage) }
                    .tag(tab)
            }
        }
        .frame(width: SettingsMetrics.width, height: SettingsMetrics.height)
        // L() is not observable; rebuild on a language change (same trick
        // as the top bar) — the tab survives via @AppStorage.
        .id(model.settings.languageRevision)
        // Cmd+Tab compromise: an open Settings window is a summoned app
        // window, so the app is .regular while it is up (see
        // TopBarController.activationPolicy). Appear/disappear fire on every
        // open and close of the scene's window, whichever path opened it.
        .onAppear { model.settingsWindowOpen = true }
        .onDisappear { model.settingsWindowOpen = false }
    }
}

/// Opens the `Settings` scene from AppKit code (status item, top bar).
///
/// `NSApp.sendAction(Selector(("showSettingsWindow:")))` returns true but
/// opens nothing on macOS 14+ (verified 2026-10-02), so this captures
/// SwiftUI's own `openSettings` action from a window-less hosting view —
/// independent of whether the pill is drawn (hidden-pill mode has no panel).
@MainActor
final class SettingsOpener {
    private let model: AppModel
    private var action: OpenSettingsAction?
    private var host: NSHostingView<Capture>?
    /// Re-applies the activation policy (wired to the top bar controller).
    var onPolicyChange: (() -> Void)?

    static let windowIdentifier = "com_apple_SwiftUI_Settings_window"

    init(model: AppModel) {
        self.model = model
        let host = NSHostingView(rootView: Capture { [weak self] action in self?.action = action })
        _ = host.fittingSize  // evaluates the body once, which captures the action
        self.host = host
    }

    func open() {
        guard let action else {
            Log.app.error("settings: openSettings action was never captured")
            return
        }
        // Promote BEFORE activating: an .accessory app can't hold the menu
        // bar or a Cmd+Tab slot, and the window must arrive frontmost.
        model.settingsWindowOpen = true
        onPolicyChange?()
        // Explicit user command (menu item / button), so take focus outright:
        // cooperative NSApp.activate() is refused when the request isn't tied
        // to the current input event, which left the window behind the
        // frontmost app in testing (2026-10-02).
        NSApp.activate(ignoringOtherApps: true)
        action()
        // SwiftUI creates the window asynchronously on first open.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            MainActor.assumeIsolated { self?.bringToFront() }
        }
    }

    private func bringToFront() {
        guard let window = NSApp.windows.first(where: {
            $0.identifier?.rawValue == Self.windowIdentifier
        }) else {
            // No window means no onDisappear will ever clear the promotion —
            // drop it here so the app can't get stuck in Cmd+Tab. A late
            // window re-promotes itself through SettingsRoot.onAppear.
            Log.app.error("settings: window did not appear")
            model.settingsWindowOpen = false
            return
        }
        if !window.isKeyWindow { window.makeKeyAndOrderFront(nil) }
    }

    /// Reads the environment action during body evaluation.
    struct Capture: View {
        @Environment(\.openSettings) private var openSettings
        let onCapture: (OpenSettingsAction) -> Void

        var body: some View {
            let _ = onCapture(openSettings)
            Color.clear.frame(width: 1, height: 1)
        }
    }
}
