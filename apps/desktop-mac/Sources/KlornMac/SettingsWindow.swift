import AppKit
import SwiftUI

/// One existing Preferences section. The Settings window regroups these into
/// tabs; it adds no new settings (productization plan, macOS M0).
enum PrefsSection: CaseIterable, Hashable, Sendable {
    /// General (M4): login item, theme + language, the Dock badge, then the
    /// app chrome that was already there.
    case startup, appearance, dock, updates, keyboard, support, about
    case account, inboxes, deviceCalendars, driveImport
    case mode, behaviour, replies
    case banners, interrupts
    case mail

    /// Server-backed sections only make sense with an account behind them.
    var requiresSignIn: Bool {
        switch self {
        case .inboxes, .deviceCalendars, .driveImport, .mode, .behaviour, .replies, .interrupts: true
        default: false
        }
    }
}

/// The Settings window's tabs, in display order (M4, 2026-11-13, LOCKED):
/// five, with Appearance folded into General. Groups follow the settings
/// IA in `docs/design/productization-plan.md` §1 for the groups the Mac app
/// already has; plan groups with no Mac settings yet (Lanes & rules, Team,
/// Integrations, billing) are deliberately absent rather than shown empty.
/// `general` is the macOS-convention home for app chrome (login item,
/// theme, language, Dock badge, updates, hotkey, support, about), which the
/// web IA has no slot for.
enum SettingsTab: String, CaseIterable, Identifiable, Sendable {
    case general, accounts, notifications, assistant, privacy

    /// The defaults key of the selected tab (the Settings window and the D7 import share it).
    static let storageKey = "settings.selectedTab"

    var id: String { rawValue }
    var titleKey: String { "settings.tab.\(rawValue)" }
    var title: String { L(titleKey) }

    var systemImage: String {
        switch self {
        case .general: "gearshape"
        case .accounts: "at"
        case .notifications: "bell"
        case .assistant: "text.bubble"
        case .privacy: "lock"
        }
    }

    var sections: [PrefsSection] {
        switch self {
        case .general: [.startup, .appearance, .dock, .updates, .keyboard, .support, .about]
        case .accounts: [.account, .inboxes, .deviceCalendars, .driveImport]
        case .notifications: [.banners, .interrupts]
        case .assistant: [.mode, .behaviour, .replies]
        case .privacy: [.mail]
        }
    }

    /// What the tab draws for the current sign-in state. Pure for the harness.
    func visibleSections(signedIn: Bool) -> [PrefsSection] {
        sections.filter { signedIn || !$0.requiresSignIn }
    }

    /// The persisted selection, falling back to the first tab for a value
    /// written by a build that had a tab this one no longer has — including
    /// "appearance", whose settings now live in General (M4).
    static func restored(_ raw: String) -> SettingsTab {
        SettingsTab(rawValue: raw) ?? .general
    }

    /// The stored value rewritten to a tab this build has, so the defaults
    /// stop carrying a retired tab name ("appearance" → "general").
    static func migratedRaw(_ raw: String) -> String {
        restored(raw).rawValue
    }
}

/// Settings window size. The width is fixed; the height fits the selected
/// pane (M4) between a floor and a cap, and a pane taller than the cap
/// scrolls inside it, so content can never grow the window past the
/// smallest supported display (the content-overflow clipping lesson,
/// 2026-08-20).
enum SettingsMetrics {
    /// Wide enough for every toolbar tab in the longest locale (de/fr)
    /// without the overflow chevron hiding the last tab (probe, 2026-10-02).
    static let width: CGFloat = 620
    /// A near-empty pane (signed out) still reads as a window.
    static let minHeight: CGFloat = 220
    /// The tallest a pane grows before it scrolls.
    static let maxHeight: CGFloat = 560
    /// Title bar + toolbar tab strip above the content, approximately.
    static let chromeHeight: CGFloat = 90
    /// Visible height of a 1280×800 display minus menu bar and Dock.
    static let smallestVisibleHeight: CGFloat = 700
}

/// Root of the `Settings` scene: a native toolbar-tab Settings window.
struct SettingsRoot: View {
    @Environment(AppModel.self) private var model
    @AppStorage(SettingsTab.storageKey) private var selectedRaw = SettingsTab.general.rawValue

    private var selected: SettingsTab { SettingsTab.restored(selectedRaw) }

    var body: some View {
        tabs
            // L() is not observable; rebuild the tabs on a language change
            // (same trick as the main window) — the tab survives via @AppStorage.
            // Scoped to the tabs only, so the window tracker below is never
            // torn down by a language switch.
            .id(model.settings.languageRevision)
            // Width only: each pane fixes its own height (PreferencesView),
            // and the Settings window resizes to the selected one.
            .frame(width: SettingsMetrics.width)
            // A retired tab name ("appearance") is rewritten once (M4).
            .onAppear {
                let migrated = SettingsTab.migratedRaw(selectedRaw)
                if migrated != selectedRaw { selectedRaw = migrated }
            }
            // Open/closed comes from the real NSWindow, not view lifecycle:
            // SwiftUI may keep this content alive after the window closes,
            // so onDisappear is not a close signal. The tracker also names
            // the window after the selected pane (M4).
            .background(SettingsWindowTracker(title: selected.title) { open in
                model.settingsWindowOpen = open
            })
    }

    private var tabs: some View {
        TabView(selection: Binding(
            get: { selected },
            set: { selectedRaw = $0.rawValue })
        ) {
            ForEach(SettingsTab.allCases) { tab in
                tab.pane
                    .tabItem { Label(tab.title, systemImage: tab.systemImage) }
                    .tag(tab)
            }
        }
    }
}

extension SettingsTab {
    /// The tab's pane. The one place a PreferencesView is made, so the
    /// window, the self-check's measurement and the preview shots draw the
    /// same view.
    @MainActor var pane: some View { PreferencesView(tab: self) }
}

/// What happened to the Settings window, as the tracker sees it.
enum SettingsWindowEvent: Sendable {
    case attached(visible: Bool)
    case becameKey
    case occlusionChanged(visible: Bool)
    case willClose
}

extension SettingsWindowEvent {
    /// Whether Settings counts as open after `event`. Only a real close
    /// clears it: hiding the app (⌘H) or covering the window does not close
    /// it. Pure for the harness.
    func openState(current: Bool) -> Bool {
        switch self {
        case .willClose: false
        case .becameKey: true
        case .attached(let visible), .occlusionChanged(let visible): visible ? true : current
        }
    }
}

/// Reports the Settings window's open/closed state from the NSWindow that
/// actually hosts the scene content (no private identifiers, no timers).
struct SettingsWindowTracker: NSViewRepresentable {
    /// The selected pane's name, shown as the window title (M4).
    let title: String
    let onChange: @MainActor (Bool) -> Void

    func makeNSView(context: Context) -> TrackingView {
        let view = TrackingView()
        view.onChange = onChange
        view.title = title
        return view
    }

    func updateNSView(_ view: TrackingView, context: Context) {
        view.onChange = onChange
        view.title = title
    }

    final class TrackingView: NSView {
        var onChange: (@MainActor (Bool) -> Void)?
        /// Applied to the hosting window now and whenever it changes.
        var title = "" {
            didSet { applyTitle() }
        }
        private var isOpen = false
        nonisolated(unsafe) private var tokens: [NSObjectProtocol] = []

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            tokens.forEach(NotificationCenter.default.removeObserver)
            tokens = []
            guard let window else { return }
            let names: [Notification.Name] = [
                NSWindow.didBecomeKeyNotification,
                NSWindow.didChangeOcclusionStateNotification,
                NSWindow.willCloseNotification,
            ]
            tokens = names.map { name in
                NotificationCenter.default.addObserver(
                    forName: name, object: window, queue: .main
                ) { [weak self] _ in
                    MainActor.assumeIsolated { self?.handle(name) }
                }
            }
            apply(.attached(visible: window.isVisible))
            applyTitle()
        }

        private func applyTitle() {
            guard let window, !title.isEmpty, window.title != title else { return }
            window.title = title
        }

        private func handle(_ name: Notification.Name) {
            guard let window else { return }
            switch name {
            case NSWindow.didBecomeKeyNotification: apply(.becameKey)
            case NSWindow.willCloseNotification: apply(.willClose)
            default: apply(.occlusionChanged(visible: window.occlusionState.contains(.visible)))
            }
        }

        private func apply(_ event: SettingsWindowEvent) {
            let next = event.openState(current: isOpen)
            guard next != isOpen else { return }
            isOpen = next
            onChange?(next)
        }

        deinit {
            tokens.forEach(NotificationCenter.default.removeObserver)
        }
    }
}

/// Opens the `Settings` scene from AppKit code (the shell, the drive import).
///
/// `NSApp.sendAction(Selector(("showSettingsWindow:")))` returns true but
/// opens nothing on macOS 14+ (verified 2026-10-02), so this captures
/// SwiftUI's own `openSettings` action from a window-less hosting view —
/// independent of whether the main window is open.
@MainActor
final class SettingsOpener {
    private var action: OpenSettingsAction?
    private var host: NSHostingView<Capture>?

    init() {
        let host = NSHostingView(rootView: Capture { [weak self] action in self?.action = action })
        _ = host.fittingSize  // evaluates the body once, which captures the action
        self.host = host
    }

    /// The window tracker promotes the app to .regular once the window is
    /// actually up; nothing here guesses at that.
    func open() {
        guard let action else {
            Log.app.error("settings: openSettings action was never captured")
            return
        }
        // Explicit user command (menu item / button), so take focus outright:
        // cooperative NSApp.activate() is refused when the request isn't tied
        // to the current input event, which left the window behind the
        // frontmost app in testing (2026-10-02).
        NSApp.activate(ignoringOtherApps: true)
        action()
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
