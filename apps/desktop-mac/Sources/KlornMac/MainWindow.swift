import AppKit
import SwiftUI

/// Pure rules for the standard main window (productization plan, macOS M2),
/// pinned by the self-check.
enum MainWindowRules {
    /// The `Window` scene id.
    static let sceneID = "main"
    /// NSWindow frame autosave name: position and size survive relaunch.
    static let frameAutosaveName = "KlornMainWindow"
    /// The full view's own floor (sidebar 220 + list 420 + a readable
    /// reading pane), so the window can never be dragged into clipping it.
    static let minSize = TopBarMetrics.fullMin
    /// First-open size before any autosaved frame exists. Fits a 1280×800
    /// display's visible area (minus menu bar, Dock and title bar).
    static let defaultSize = NSSize(width: 1180, height: 640)

    /// Whether a main window that just appeared may stay. Only one we asked
    /// for (an openFull() routed here while the flag is on) is kept;
    /// anything else — SwiftUI opening its primary scene at launch, or state
    /// restoration — is closed, so the flag-off app looks exactly as before.
    static func keepsAttachedWindow(macMainWindow: Bool, requested: Bool) -> Bool {
        macMainWindow && requested
    }

    /// Settings ▸ General shows the beta toggle while Option is held, and
    /// always once it is on, so it can be turned back off.
    static func showsBetaToggle(optionHeld: Bool, macMainWindow: Bool) -> Bool {
        optionHeld || macMainWindow
    }
}

/// The main window's content: the current full view, unchanged (the IA
/// change is M4). Actions come from the bar controller, which owns every
/// full-view action today.
struct MainWindowRoot: View {
    let model: AppModel
    let opener: MainWindowOpener
    let actions: () -> TopBarActions?

    var body: some View {
        content
            .frame(
                minWidth: MainWindowRules.minSize.width, maxWidth: .infinity,
                minHeight: MainWindowRules.minSize.height, maxHeight: .infinity,
                alignment: .top)
            // Driven by the real NSWindow (same tracker as Settings), never
            // view lifecycle: SwiftUI can keep this content alive after the
            // window closes.
            .background(WindowPresenceTracker(
                onChange: { [weak opener] open in opener?.windowOpenChanged(open) },
                onKeyChange: { [model] isKey in model.mainWindowIsKey = isKey },
                onAttach: { [weak opener] window in opener?.attached(window) }))
    }

    @ViewBuilder
    private var content: some View {
        if let actions = actions() {
            FullView(actions: actions)
                .environment(model)
                // L() is not observable; rebuild on a language change (same
                // trick as the bar). Scoped so the tracker survives it.
                .id(model.settings.languageRevision)
        } else {
            Color.clear
        }
    }
}

/// Opens, focuses and closes the main window from AppKit code, and decides
/// which appearing windows are kept (see `MainWindowRules`).
///
/// Like `SettingsOpener`, it captures SwiftUI's `openWindow` action from a
/// window-less hosting view, so it works whatever the bar is drawing.
@MainActor
final class MainWindowOpener {
    private let model: AppModel
    private var action: OpenWindowAction?
    private var host: NSHostingView<Capture>?
    /// The accepted main window.
    private weak var window: NSWindow?
    /// The last window the tracker landed in (accepted or not yet decided).
    private weak var candidate: NSWindow?
    /// Set by open(), consumed when the window opens (or after the timeout).
    private var requested = false
    private static let requestTimeout: TimeInterval = 2

    init(model: AppModel) {
        self.model = model
        let host = NSHostingView(rootView: Capture { [weak self] action in self?.action = action })
        _ = host.fittingSize  // evaluates the body once, which captures the action
        self.host = host
    }

    /// Open the main window, or bring the open one forward.
    func open() {
        // Explicit user command, so take focus outright (cooperative
        // activate() is refused when not tied to the current input event).
        NSApp.activate(ignoringOtherApps: true)
        if let window, model.mainWindowOpen {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
            return
        }
        guard let action else {
            Log.app.error("main window: openWindow action was never captured")
            return
        }
        requested = true
        action(id: MainWindowRules.sceneID)
        // If no window ever shows up, the request must not linger and turn
        // a later stray window (launch, restoration) into a "requested" one.
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.requestTimeout) { [weak self] in
            guard let self, !self.model.mainWindowOpen else { return }
            self.requested = false
        }
    }

    /// Close the main window (header ✕ / "Smaller"). The tracker's willClose
    /// drops the app back to ambient.
    func close() {
        window?.close()
    }

    /// The tracker landed in a hosting NSWindow. SwiftUI may reuse that
    /// window across close/reopen, so the keep-or-close decision is made on
    /// each open transition, not here.
    func attached(_ window: NSWindow) {
        candidate = window
        // Our own frame autosave is the only restoration we want; state
        // restoration would reopen the window at launch.
        window.isRestorable = false
    }

    /// The tracker's open/closed signal.
    func windowOpenChanged(_ open: Bool) {
        guard open else {
            model.mainWindowOpen = false
            model.mainWindowIsKey = false
            return
        }
        let keep = MainWindowRules.keepsAttachedWindow(
            macMainWindow: model.settings.macMainWindow, requested: requested)
        requested = false
        guard keep, let candidate else {
            Log.app.info("main window: closing an unrequested window")
            let stray = candidate
            DispatchQueue.main.async { stray?.close() }
            return
        }
        if window !== candidate { configure(candidate) }
        window = candidate
        model.mainWindowOpen = true
        model.mainWindowIsKey = candidate.isKeyWindow
    }

    private func configure(_ window: NSWindow) {
        window.titleVisibility = .hidden  // the full view draws its own header
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.setFrameAutosaveName(MainWindowRules.frameAutosaveName)
        _ = window.setFrameUsingName(MainWindowRules.frameAutosaveName)
        clampOnScreen(window)
    }

    /// A restored frame from a since-disconnected or smaller display must
    /// not leave the title bar unreachable (clipping lessons, 2026-08-20).
    private func clampOnScreen(_ window: NSWindow) {
        guard let visible = (window.screen ?? NSScreen.main)?.visibleFrame else { return }
        let clamped = KeyablePanel.clamped(window.frame, into: visible)
        if clamped != window.frame { window.setFrame(clamped, display: true) }
    }

    /// Reads the environment action during body evaluation.
    struct Capture: View {
        @Environment(\.openWindow) private var openWindow
        let onCapture: (OpenWindowAction) -> Void

        var body: some View {
            let _ = onCapture(openWindow)
            Color.clear.frame(width: 1, height: 1)
        }
    }
}

/// Settings ▸ General: the hidden switch for the main-window beta. Revealed
/// while Option is held (the macOS convention for advanced items), and kept
/// visible once on so it can be turned back off. The same switch is
/// `defaults write ai.klorn.desktop macMainWindow -bool YES`.
struct MainWindowBetaToggle: View {
    @Bindable var settings: AppSettings
    @State private var optionHeld = NSEvent.modifierFlags.contains(.option)
    @State private var monitor: Any?

    var body: some View {
        Group {
            if MainWindowRules.showsBetaToggle(
                optionHeld: optionHeld, macMainWindow: settings.macMainWindow)
            {
                Toggle(isOn: $settings.macMainWindow) {
                    Text(L("prefs.mainWindow")).foregroundStyle(Theme.text)
                }
                .toggleStyle(.switch).tint(Theme.accent)
                Text(L("prefs.mainWindow.detail"))
                    .font(.caption).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        // A key-modifier monitor, not window tracking: view lifecycle is
        // the right scope for it.
        .onAppear {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { event in
                optionHeld = event.modifierFlags.contains(.option)
                return event
            }
        }
        .onDisappear {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }
    }
}
