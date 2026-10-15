import AppKit
import SwiftUI

/// Pure rules for the standard main window (productization plan, macOS M2),
/// pinned by the self-check.
enum MainWindowRules {
    /// NSWindow frame autosave name: position and size survive relaunch.
    static let frameAutosaveName = "KlornMainWindow"
    /// The shell's floor (sidebar 220 + list 420 + a readable ~240pt reading
    /// pane), so the window can never be dragged into clipping it. 880 keeps
    /// edge-drag alive on fitted sizes ("can't shrink it", 2026-08-07).
    static let minSize = NSSize(width: 880, height: 520)
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
}

/// The main window's content: the five-item shell (M4b). Actions come from
/// the window router (`WindowRouter.makeActions()`).
struct MainWindowRoot: View {
    let model: AppModel
    let actions: ShellActions
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
/// view, created lazily on the first open request and reused afterwards.
/// Since the pill and the expanded panel were removed (founder decision
/// 2026-10-15) it is Klorn's only main surface. Closing it (⌘W, red button)
/// keeps the app running — the poll loop and the PUSH banners live on.
///
/// Open/closed and key state come from the window's own delegate callbacks
/// (shown → open, willClose → closed), never from view lifecycle.
@MainActor
final class MainWindowController: NSObject, NSWindowDelegate, MainWindowPresenting {
    private let model: AppModel
    /// The shell's actions for the window; wired by the AppDelegate to the router.
    var actionsProvider: (() -> ShellActions?)?
    private(set) var window: NSWindow?
    /// The attached sheet (M5) and which one it is.
    private var sheetWindow: NSWindow?
    private var presentedSheet: MainSheet?

    init(model: AppModel) {
        self.model = model
    }

    /// The window is on screen, key, and Klorn is the active app — what
    /// ⌥⌘K treats as "already frontmost" (it hides the app then).
    var isFrontmost: Bool {
        guard let window else { return false }
        return NSApp.isActive && window.isVisible && window.isKeyWindow && !window.isMiniaturized
    }

    /// Open the main window, or bring the open one forward. `activate`
    /// false (a launch at login) shows it without taking focus.
    func open(activate: Bool) {
        guard let window = window ?? makeWindow() else {
            Log.app.error("main window: no shell actions to host")
            return
        }
        if window.isMiniaturized { window.deminiaturize(nil) }
        if activate {
            // Explicit user command, so take focus outright (cooperative
            // activate() is refused when not tied to the current input event).
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            // The user opened Klorn: now the banner permission may be asked
            // (a login launch's unfocused window never gets here).
            model.windowShownByUser = true
            Task { await model.requestNotificationPermissionIfNeeded() }
        } else {
            window.orderFront(nil)
        }
        // Fresh-release discovery when the user is looking (15-min debounce).
        model.checkForUpdateOnWindowOpen()
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

    /// Close the main window; willClose does the rest.
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
        let clamped = WindowGeometry.clamped(window.frame, into: visible)
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
