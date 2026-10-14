import AppKit
import SwiftUI

/// Pure rules for the standard main window (productization plan, macOS M2),
/// pinned by the self-check.
enum MainWindowRules {
    /// NSWindow frame autosave name: position and size survive relaunch.
    static let frameAutosaveName = "KlornMainWindow"
    /// The shell's floor (sidebar 220 + list 420 + a readable reading pane;
    /// the same numbers as the bar's full view), so the window can never be
    /// dragged into clipping it.
    static let minSize = TopBarMetrics.fullMin
    /// First-open size before any autosaved frame exists. Fits a 1280×800
    /// display's visible area (minus menu bar, Dock and title bar).
    static let defaultSize = NSSize(width: 1180, height: 640)
    /// `.fullSizeContentView` with a transparent title bar (M7): the canvas
    /// and the sidebar's rule run to the top of the window and the traffic
    /// lights sit over the sidebar. The shell stays inside the safe area, so
    /// no control ever sits under the title bar and the strip still drags
    /// the window.
    static let styleMask: NSWindow.StyleMask = [
        .titled, .closable, .miniaturizable, .resizable, .fullSizeContentView,
    ]

    /// The title bar's height in a full-size-content window: what the frame
    /// has and the unobscured layout rect does not. Never negative.
    static func titlebarInset(frameHeight: CGFloat, layoutHeight: CGFloat) -> CGFloat {
        max(0, frameHeight - layoutHeight)
    }

    /// A content size that leaves `usable` under the title bar. The content
    /// view now includes the title bar strip, so the shell's floor and the
    /// first-open size both grow by it; the WINDOW sizes are what they were.
    static func contentSize(usable: NSSize, titlebarInset: CGFloat) -> NSSize {
        NSSize(width: usable.width, height: usable.height + titlebarInset)
    }

    /// Whether an open request may create (or show) the window. With the
    /// flag off no window object is ever made, so flag-off is unchanged.
    static func mayOpen(macMainWindow: Bool) -> Bool {
        macMainWindow
    }

    /// Settings ▸ General shows the beta toggle while Option is held, and
    /// always once it is on, so it can be turned back off.
    static func showsBetaToggle(optionHeld: Bool, macMainWindow: Bool) -> Bool {
        optionHeld || macMainWindow
    }
}

/// The main window's content: the five-item shell (M4b). Actions come from
/// the bar controller, which owns every full-view action today.
struct MainWindowRoot: View {
    let model: AppModel
    let actions: TopBarActions
    /// Tells the controller the sheet the model wants has changed (M5).
    var onSheetChange: () -> Void = {}

    var body: some View {
        MainShell(actions: actions)
            .environment(model)
            .onChange(of: model.activeMainSheet, initial: true) { _, _ in onSheetChange() }
            // L() is not observable; rebuild on a language change (same
            // trick as the bar).
            .id(model.settings.languageRevision)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

/// Owns the standard main window: a plain AppKit NSWindow hosting the full
/// view, created lazily on the first open request while `macMainWindow` is
/// on and reused afterwards. There is no SwiftUI `Window` scene, so nothing
/// is instantiated at launch and the flag-off app never has this window.
///
/// Open/closed and key state come from the window's own delegate callbacks
/// (shown → open, willClose → closed), never from view lifecycle.
@MainActor
final class MainWindowController: NSObject, NSWindowDelegate {
    private let model: AppModel
    /// FullView actions for the window; wired by the AppDelegate to the bar.
    var actionsProvider: (() -> TopBarActions?)?
    private(set) var window: NSWindow?
    /// The attached sheet (M5) and which one it is.
    private var sheetWindow: NSWindow?
    private var presentedSheet: MainSheet?

    init(model: AppModel) {
        self.model = model
    }

    /// Open the main window, or bring the open one forward.
    func open() {
        guard MainWindowRules.mayOpen(macMainWindow: model.settings.macMainWindow) else { return }
        guard let window = window ?? makeWindow() else {
            Log.app.error("main window: no full-view actions to host")
            return
        }
        // Explicit user command, so take focus outright (cooperative
        // activate() is refused when not tied to the current input event).
        NSApp.activate(ignoringOtherApps: true)
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        model.mainWindowOpen = true
        model.mainWindowIsKey = window.isKeyWindow
        // A sheet asked for while the window was closed shows now.
        syncSheet()
    }

    /// Attach, swap or end the window's sheet so it matches the model: the
    /// lane guide, the event editor or the connect-time question (M5). The
    /// model's flags are the only state; dismissing a sheet clears its flag
    /// and lands back here.
    func syncSheet() {
        guard let window else { return }
        let wanted = MainSheetRules.presented(
            active: model.activeMainSheet, windowVisible: window.isVisible,
            miniaturized: window.isMiniaturized)
        guard wanted != presentedSheet else { return }
        if let sheetWindow {
            window.endSheet(sheetWindow)
            self.sheetWindow = nil
        }
        presentedSheet = wanted
        model.mainSheetAttached = wanted != nil
        guard let wanted else { return }
        let sheet = SheetWindow(
            contentViewController: NSHostingController(
                rootView: MainSheetRoot(model: model, sheet: wanted)))
        sheet.styleMask = [.titled]
        sheet.onCancel = { [weak self] in self?.model.dismiss(wanted) }
        sheetWindow = sheet
        window.beginSheet(sheet)
    }

    /// Close the main window (header ✕ / "Smaller"); willClose does the rest.
    func close() {
        window?.close()
    }

    private func makeWindow() -> NSWindow? {
        guard let actions = actionsProvider?() else { return nil }
        // Land on Today unless a deep link already chose a destination.
        model.prepareMainNavigation()
        let host = NSHostingController(
            rootView: MainWindowRoot(
                model: model, actions: actions, onSheetChange: { [weak self] in self?.syncSheet() }))
        // The window owns its frame; SwiftUI content must never resize it
        // (clipping lessons, 2026-08-19).
        host.sizingOptions = []
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: MainWindowRules.defaultSize),
            styleMask: MainWindowRules.styleMask, backing: .buffered, defer: false)
        window.contentViewController = host
        window.title = "Klorn"
        window.titleVisibility = .hidden  // the sections draw their own titles
        window.titlebarAppearsTransparent = true
        let titlebar = MainWindowRules.titlebarInset(
            frameHeight: window.frame.height, layoutHeight: window.contentLayoutRect.height)
        window.contentMinSize = MainWindowRules.contentSize(
            usable: MainWindowRules.minSize, titlebarInset: titlebar)
        window.isReleasedWhenClosed = false  // reused on reopen
        window.isRestorable = false  // our frame autosave is the only restoration
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.delegate = self
        window.setContentSize(MainWindowRules.contentSize(
            usable: MainWindowRules.defaultSize, titlebarInset: titlebar))
        if !window.setFrameUsingName(MainWindowRules.frameAutosaveName) { window.center() }
        window.setFrameAutosaveName(MainWindowRules.frameAutosaveName)
        clampOnScreen(window)
        self.window = window
        return window
    }

    func windowDidBecomeKey(_ notification: Notification) {
        model.mainWindowIsKey = true
        // A sheet asked for while the window was away is attached now.
        syncSheet()
    }

    func windowDidDeminiaturize(_ notification: Notification) {
        syncSheet()
    }

    func windowDidResignKey(_ notification: Notification) {
        model.mainWindowIsKey = false
    }

    func windowWillClose(_ notification: Notification) {
        // A sheet never outlives its window; its flag stays set, so it is
        // presented again on the next open.
        if let sheetWindow { window?.endSheet(sheetWindow) }
        sheetWindow = nil
        presentedSheet = nil
        model.mainSheetAttached = false
        model.mainWindowIsKey = false
        model.mainWindowOpen = false
    }

    /// A restored frame from a since-disconnected or smaller display must
    /// not leave the title bar unreachable (clipping lessons, 2026-08-20).
    private func clampOnScreen(_ window: NSWindow) {
        guard let visible = (window.screen ?? NSScreen.main)?.visibleFrame else { return }
        let clamped = KeyablePanel.clamped(window.frame, into: visible)
        if clamped != window.frame { window.setFrame(clamped, display: true) }
    }
}

/// A sheet's window: Escape dismisses it, as a click on the scrim did for the
/// overlay it replaces.
private final class SheetWindow: NSWindow {
    var onCancel: (() -> Void)?

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
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
