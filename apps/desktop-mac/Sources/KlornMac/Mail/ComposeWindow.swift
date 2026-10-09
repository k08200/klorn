import AppKit
import SwiftUI

/// Pure rules for the compose window (productization plan, macOS M5),
/// pinned by the self-check.
enum ComposeWindowRules {
    /// NSWindow frame autosave name: position and size survive relaunch.
    static let frameAutosaveName = "KlornComposeWindow"
    /// To, subject, a few lines of body and the action row never clip.
    static let minSize = NSSize(width: 480, height: 360)
    static let defaultSize = NSSize(width: 620, height: 520)
    static let styleMask: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]

    /// The composer is its own window exactly while the main window is the
    /// full view. With the flag off it stays the bar's in-window overlay and
    /// no window object is ever made.
    static func usesWindow(macMainWindow: Bool) -> Bool {
        macMainWindow
    }

    /// Whether the composer covers the full view as a modal overlay. A
    /// separate window covers nothing, so the mail stays readable under it.
    static func overlayOpen(showCompose: Bool, macMainWindow: Bool) -> Bool {
        showCompose && !usesWindow(macMainWindow: macMainWindow)
    }

    /// The window refuses to close mid-send (same as the overlay's ✕), so a
    /// send result always has a composer to land in.
    static func mayClose(sending: Bool) -> Bool {
        !sending
    }

    /// What the window should do for the model's state. Closing never
    /// touches the draft; only Discard and a successful send clear it.
    enum Step: Equatable { case show, close, none }

    static func step(
        macMainWindow: Bool, signedIn: Bool, showCompose: Bool, windowVisible: Bool
    ) -> Step {
        // Switched off, or signed out, with the window up: close it. With
        // the flag off the overlay is the composer, and two must not coexist.
        guard usesWindow(macMainWindow: macMainWindow), signedIn else {
            return windowVisible ? .close : .none
        }
        if showCompose { return .show }
        return windowVisible ? .close : .none
    }

    /// Discarding asks first when there is something to lose.
    static func confirmsDiscard(to: String, subject: String, body: String) -> Bool {
        [to, subject, body].contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    static func title(editingDraft: Bool) -> String {
        L(editingDraft ? "compose.editDraft" : "compose.title")
    }
}

/// The compose window's content: the one composer, laid out to fill.
struct ComposeWindowRoot: View {
    let model: AppModel
    var onDiscard: () -> Void = {}

    var body: some View {
        ComposePanel(style: .window, onDiscard: onDiscard)
            .environment(model)
            // L() is not observable; rebuild on a language change.
            .id(model.settings.languageRevision)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

/// Owns the compose window: a plain AppKit NSWindow hosting the composer,
/// created lazily the first time the composer is asked for while
/// `macMainWindow` is on, and reused afterwards. The draft lives on the
/// model, so there is one composer and one window.
///
/// The model's `showCompose` is the single source of truth; `sync()` moves
/// the window to match it, and the window's own delegate callbacks write
/// back (closed → `showCompose = false`, draft kept).
@MainActor
final class ComposeWindowController: NSObject, NSWindowDelegate {
    private let model: AppModel
    private(set) var window: NSWindow?
    private var host: NSHostingController<ComposeWindowRoot>?
    /// True inside `windowWillClose`, so writing the model back does not
    /// close the window a second time.
    private var closing = false

    init(model: AppModel) {
        self.model = model
    }

    /// Bring the window in line with the model. Called on every composer
    /// request, so asking for an open composer brings it forward.
    func sync() {
        let step = ComposeWindowRules.step(
            macMainWindow: model.settings.macMainWindow, signedIn: model.phase == .signedIn,
            showCompose: model.showCompose,
            windowVisible: (window?.isVisible ?? false) || (window?.isMiniaturized ?? false))
        switch step {
        case .show: show()
        case .close: if !closing { window?.close() }
        case .none: break
        }
    }

    private func show() {
        let window = self.window ?? makeWindow()
        window.title = ComposeWindowRules.title(editingDraft: model.editingDraftGmailId != nil)
        if !window.isVisible {
            // A fresh view per open, so the To field takes the keyboard
            // again (the hosting view outlives a closed window).
            host?.rootView = root()
        }
        // Explicit user command (⌘N, the Compose button), so take focus.
        NSApp.activate(ignoringOtherApps: true)
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        model.composeWindowOpen = true
    }

    private func makeWindow() -> NSWindow {
        let host = NSHostingController(rootView: root())
        // The window owns its frame; SwiftUI content must never resize it
        // (clipping lessons, 2026-08-19).
        host.sizingOptions = []
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: ComposeWindowRules.defaultSize),
            styleMask: ComposeWindowRules.styleMask, backing: .buffered, defer: false)
        window.contentViewController = host
        window.contentMinSize = ComposeWindowRules.minSize
        window.isReleasedWhenClosed = false  // reused on reopen
        window.isRestorable = false  // our frame autosave is the only restoration
        window.tabbingMode = .disallowed
        window.delegate = self
        window.setContentSize(ComposeWindowRules.defaultSize)
        if !window.setFrameUsingName(ComposeWindowRules.frameAutosaveName) { window.center() }
        window.setFrameAutosaveName(ComposeWindowRules.frameAutosaveName)
        clampOnScreen(window)
        self.host = host
        self.window = window
        return window
    }

    private func root() -> ComposeWindowRoot {
        ComposeWindowRoot(model: model) { [weak self] in self?.discard() }
    }

    /// Discard Draft. With content it asks first, in a sheet on this window:
    /// Cancel is the default (Return), discarding is the marked destructive
    /// button and never the default.
    private func discard() {
        let confirm = ComposeWindowRules.confirmsDiscard(
            to: model.composeTo, subject: model.composeSubject, body: model.composeBody)
        guard confirm, let window else {
            discardNow()
            return
        }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = L("compose.discard.confirm.title")
        alert.informativeText = L("compose.discard.confirm.detail")
        alert.addButton(withTitle: L("compose.cancel"))
        alert.addButton(withTitle: L("compose.discard")).hasDestructiveAction = true
        alert.beginSheetModal(for: window) { [weak self] response in
            if response == .alertSecondButtonReturn { self?.discardNow() }
        }
    }

    private func discardNow() {
        guard !model.composeSending else { return }
        model.discardComposeDraft()
        model.showCompose = false
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        ComposeWindowRules.mayClose(sending: model.composeSending)
    }

    func windowWillClose(_ notification: Notification) {
        closing = true
        defer { closing = false }
        model.composeWindowOpen = false
        // Closing puts the composer away and keeps the draft: ⌘N reopens
        // where the user left off.
        if model.showCompose { model.showCompose = false }
    }

    /// A restored frame from a since-disconnected or smaller display must
    /// not leave the title bar unreachable (clipping lessons, 2026-08-20).
    private func clampOnScreen(_ window: NSWindow) {
        guard let visible = (window.screen ?? NSScreen.main)?.visibleFrame else { return }
        let clamped = KeyablePanel.clamped(window.frame, into: visible)
        if clamped != window.frame { window.setFrame(clamped, display: true) }
    }
}
