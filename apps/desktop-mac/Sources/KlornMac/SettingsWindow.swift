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

/// The Settings window's tabs, in display order. Groups follow the settings
/// IA in `docs/design/productization-plan.md` §1 (labels shortened to one
/// word each so six toolbar tabs fit) for the groups the Mac app
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
    /// Wide enough for all six toolbar tabs in the longest locale (de/fr)
    /// without the overflow chevron hiding the last tab (probe, 2026-10-02).
    static let width: CGFloat = 620
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
        tabs
            // L() is not observable; rebuild the tabs on a language change
            // (same trick as the top bar) — the tab survives via @AppStorage.
            // Scoped to the tabs only, so the window tracker below is never
            // torn down by a language switch.
            .id(model.settings.languageRevision)
            .frame(width: SettingsMetrics.width, height: SettingsMetrics.height)
            // Cmd+Tab compromise: an open Settings window is a summoned app
            // window, so the app is .regular while it is up (see
            // TopBarController.activationPolicy). Driven by the real NSWindow,
            // not view lifecycle: SwiftUI may keep this content alive after
            // the window closes, so onDisappear is not a close signal.
            .background(WindowPresenceTracker { open in model.settingsWindowOpen = open })
    }

    private var tabs: some View {
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
    }
}

/// What happened to a tracked window (Settings, the main window), as the
/// tracker sees it.
enum WindowPresenceEvent: Sendable {
    case attached(visible: Bool)
    case becameKey
    case occlusionChanged(visible: Bool)
    case willClose
}

extension WindowPresenceEvent {
    /// Whether the window counts as open after `event`. Only a real close
    /// clears it: hiding the app (⌘H) or covering the window must not drop
    /// the app to .accessory, which would leave a hidden accessory app that
    /// Cmd+Tab can no longer bring back. Pure for the harness.
    func openState(current: Bool) -> Bool {
        switch self {
        case .willClose: false
        case .becameKey: true
        case .attached(let visible), .occlusionChanged(let visible): visible ? true : current
        }
    }
}

/// Reports a SwiftUI scene window's open/closed (and key) state from the
/// NSWindow that actually hosts the scene content — no private identifiers,
/// no timers, and never view lifecycle (SwiftUI may keep content alive after
/// its window closes, so onDisappear is not a close signal). Used by the
/// Settings window (M0) and the main window (M2).
struct WindowPresenceTracker: NSViewRepresentable {
    let onChange: @MainActor (Bool) -> Void
    var onKeyChange: (@MainActor (Bool) -> Void)?
    /// Called once per hosting NSWindow, when the tracker first lands in it.
    var onAttach: (@MainActor (NSWindow) -> Void)?

    func makeNSView(context: Context) -> TrackingView {
        let view = TrackingView()
        update(view)
        return view
    }

    func updateNSView(_ view: TrackingView, context: Context) {
        update(view)
    }

    private func update(_ view: TrackingView) {
        view.onChange = onChange
        view.onKeyChange = onKeyChange
        view.onAttach = onAttach
    }

    final class TrackingView: NSView {
        var onChange: (@MainActor (Bool) -> Void)?
        var onKeyChange: (@MainActor (Bool) -> Void)?
        var onAttach: (@MainActor (NSWindow) -> Void)?
        private var isOpen = false
        private weak var attachedWindow: NSWindow?
        nonisolated(unsafe) private var tokens: [NSObjectProtocol] = []

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            tokens.forEach(NotificationCenter.default.removeObserver)
            tokens = []
            guard let window else { return }
            let names: [Notification.Name] = [
                NSWindow.didBecomeKeyNotification,
                NSWindow.didResignKeyNotification,
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
            if attachedWindow !== window {
                attachedWindow = window
                onAttach?(window)
            }
            apply(.attached(visible: window.isVisible))
            // The window may already be key before this view lands in it.
            onKeyChange?(window.isKeyWindow)
        }

        private func handle(_ name: Notification.Name) {
            guard let window else { return }
            switch name {
            case NSWindow.didBecomeKeyNotification:
                onKeyChange?(true)
                apply(.becameKey)
            case NSWindow.didResignKeyNotification:
                onKeyChange?(false)
            case NSWindow.willCloseNotification:
                onKeyChange?(false)
                apply(.willClose)
            default: apply(.occlusionChanged(visible: window.occlusionState.contains(.visible)))
            }
        }

        private func apply(_ event: WindowPresenceEvent) {
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

/// Opens the `Settings` scene from AppKit code (status item, top bar).
///
/// `NSApp.sendAction(Selector(("showSettingsWindow:")))` returns true but
/// opens nothing on macOS 14+ (verified 2026-10-02), so this captures
/// SwiftUI's own `openSettings` action from a window-less hosting view —
/// independent of whether the pill is drawn (hidden-pill mode has no panel).
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
