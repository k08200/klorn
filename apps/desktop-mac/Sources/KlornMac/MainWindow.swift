import AppKit
import SwiftUI

/// Pure rules for the standard main window (productization plan, macOS M2),
/// pinned by the self-check.
enum MainWindowRules {
    /// NSWindow frame autosave name: position and size survive relaunch.
    static let frameAutosaveName = "KlornMainWindow"
    /// The main window's toolbar: the light/dark toggle, the notification
    /// bell (NC2-A) and the "Assistant" button (M3), trailing.
    static let toolbarIdentifier = "KlornMainToolbar"
    /// Left to right. The closing standard space keeps the Assistant button
    /// off the window's edge (founder, 2026-11-13: "cramped at the edge");
    /// AppKit spaces the two buttons itself.
    @MainActor static let toolbarItems: [NSToolbarItem.Identifier] = [
        .flexibleSpace, ThemeToolbar.itemIdentifier, BellToolbar.itemIdentifier,
        AssistantToolbar.itemIdentifier, .space,
    ]
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
    /// Tells the controller the assistant panel's state has changed (M3):
    /// the toolbar button's state and the window's width floor follow it.
    var onAssistantPanelChange: () -> Void = {}
    /// Tells the controller the bell's count or the panel's state changed
    /// (NC2-A): the toolbar badge and the Esc monitor follow it.
    var onNotificationCenterChange: () -> Void = {}

    var body: some View {
        MainShell(actions: actions)
            .environment(model)
            .onChange(of: model.activeMainSheet, initial: true) { _, _ in onSheetChange() }
            .onChange(
                of: [model.assistantPanelVisible, model.canToggleAssistantPanel], initial: true
            ) { _, _ in onAssistantPanelChange() }
            .onChange(
                of: [model.notificationCenter.badgeCount, model.notificationCenter.panelOpen ? 1 : 0],
                initial: true
            ) { _, _ in onNotificationCenterChange() }
            // L() is not observable; rebuild on a language change.
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
final class MainWindowController: NSObject, NSWindowDelegate, NSToolbarDelegate, MainWindowPresenting {
    private let model: AppModel
    /// The title bar + toolbar height the content view includes (M7).
    private var titlebarInset: CGFloat = 0
    /// The toolbar's "Assistant" button (M3); its state mirrors the panel.
    private weak var assistantButton: NSButton?
    /// The toolbar's light/dark toggle; its symbol follows the appearance.
    private weak var themeButton: NSButton?
    /// The toolbar's bell (NC2-A): its badge and state mirror the store.
    private weak var bellView: BellToolbar.BellView?
    /// Esc closes the notification panel; installed only while it is open.
    private var escapeMonitor: Any?
    /// Watches the app's effective appearance: the toggle's symbol follows
    /// a System change and its own clicks alike.
    private var appearanceObservation: NSKeyValueObservation?
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
            // The user opened Klorn: now the "Open at login" question may
            // show (a login launch's unfocused window never gets here). The
            // banner permission itself is asked at the first sync, whatever
            // the launch mode; this only asks if that has not happened yet.
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

    /// Match the toolbar button and the window's width floor to the panel
    /// (M3). Opening the panel on a window narrower than floor + panel
    /// widens the window rather than squeezing the mail columns; closing it
    /// lowers the floor but never shrinks the window behind the user.
    func syncAssistantPanel() {
        let visible = model.assistantPanelVisible
        assistantButton?.state = visible ? .on : .off
        assistantButton?.isEnabled = model.canToggleAssistantPanel
        guard let window else { return }
        let floor = NSSize(
            width: AssistantPanelRules.minContentWidth(panelVisible: visible),
            height: MainWindowRules.minSize.height)
        window.contentMinSize = MainWindowRules.contentSize(usable: floor, titlebarInset: titlebarInset)
        let shortfall = floor.width - window.contentLayoutRect.width
        guard visible, shortfall > 0 else { return }
        var frame = window.frame
        frame.size.width += shortfall
        window.setFrame(frame, display: true)
        clampOnScreen(window)
    }

    @objc func toggleAssistantPanel(_ sender: Any?) {
        if model.canToggleAssistantPanel { model.showAssistantPanel.toggle() }
        syncAssistantPanel()
    }

    /// The bell: toggle the floating notification panel (signed in only).
    @objc func toggleNotificationPanel(_ sender: Any?) {
        let store = model.notificationCenter
        store.panelOpen = model.phase == .signedIn && !store.panelOpen
        syncNotificationCenter()
    }

    /// Match the bell to the store, and hold the Esc monitor exactly while
    /// the panel is open. The monitor only reads Esc aimed at this window.
    func syncNotificationCenter() {
        let store = model.notificationCenter
        BellToolbar.update(bellView, count: store.badgeCount, open: store.panelOpen)
        bellView?.button.isEnabled = model.phase == .signedIn
        if store.panelOpen, escapeMonitor == nil {
            escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, NotificationPanelKeys.closes(keyCode: event.keyCode),
                      event.window === self.window, self.model.notificationCenter.panelOpen
                else { return event }
                self.model.notificationCenter.panelOpen = false
                return nil
            }
        } else if !store.panelOpen, let monitor = escapeMonitor {
            NSEvent.removeMonitor(monitor)
            escapeMonitor = nil
        }
    }

    /// The toolbar toggle: the opposite of what is on screen, explicitly.
    @objc func toggleAppearance(_ sender: Any?) {
        model.settings.toggleAppearance(effectiveDark: ThemeToggleRules.isDark(NSApp.effectiveAppearance))
    }

    private func observeAppearance() {
        guard appearanceObservation == nil else { return }
        appearanceObservation = NSApp.observe(\.effectiveAppearance, options: [.initial, .new]) {
            [weak self] _, _ in
            // AppKit posts this KVO change on the main thread.
            MainActor.assumeIsolated {
                ThemeToolbar.update(self?.themeButton, effectiveDark: ThemeToggleRules.isDark(NSApp.effectiveAppearance))
            }
        }
    }

    // MARK: NSToolbarDelegate

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        MainWindowRules.toolbarItems
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(
        _ toolbar: NSToolbar, itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        switch itemIdentifier {
        case AssistantToolbar.itemIdentifier:
            let item = AssistantToolbar.makeItem(target: self, action: #selector(toggleAssistantPanel(_:)))
            assistantButton = item.view as? NSButton
            return item
        case BellToolbar.itemIdentifier:
            let (item, view) = BellToolbar.makeItem(target: self, action: #selector(toggleNotificationPanel(_:)))
            bellView = view
            return item
        case ThemeToolbar.itemIdentifier:
            let item = ThemeToolbar.makeItem(target: self, action: #selector(toggleAppearance(_:)))
            themeButton = item.view as? NSButton
            ThemeToolbar.update(themeButton, effectiveDark: ThemeToggleRules.isDark(NSApp.effectiveAppearance))
            return item
        default:
            return nil
        }
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
                model: model, actions: actions,
                onSheetChange: { [weak self] in self?.syncSheet() },
                onAssistantPanelChange: { [weak self] in self?.syncAssistantPanel() },
                onNotificationCenterChange: { [weak self] in self?.syncNotificationCenter() }))
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
        // The trailing theme toggle and "Assistant" button. Installed before the title
        // bar is measured: the toolbar is part of the inset.
        let toolbar = NSToolbar(identifier: MainWindowRules.toolbarIdentifier)
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        window.toolbar = toolbar
        window.toolbarStyle = .unifiedCompact
        observeAppearance()
        let titlebar = MainWindowRules.titlebarInset(
            frameHeight: window.frame.height, layoutHeight: window.contentLayoutRect.height)
        titlebarInset = titlebar
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
        model.notificationCenter.panelOpen = false
    }

    /// A restored frame from a since-disconnected or smaller display must
    /// not leave the title bar unreachable (clipping lessons, 2026-08-20).
    private func clampOnScreen(_ window: NSWindow) {
        guard let visible = (window.screen ?? NSScreen.main)?.visibleFrame else { return }
        let clamped = WindowGeometry.clamped(window.frame, into: visible)
        if clamped != window.frame { window.setFrame(clamped, display: true) }
    }
}

/// The keys that close the notification panel: Esc (kVK_Escape). Pure.
enum NotificationPanelKeys {
    static let escape: UInt16 = 53
    static func closes(keyCode: UInt16) -> Bool { keyCode == escape }
}

/// A sheet's window: Escape dismisses it, as a click on the scrim did for the
/// overlay it replaces.
private final class SheetWindow: NSWindow {
    var onCancel: (() -> Void)?

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }
}
