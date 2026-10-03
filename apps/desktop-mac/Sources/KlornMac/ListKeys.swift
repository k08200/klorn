import AppKit
import Carbon.HIToolbox
import SwiftUI
import WebKit

/// The bare keys the mail list answers to (productization plan §3, macOS M3).
enum ListKey: CaseIterable, Hashable {
    case up, down, j, k, returnKey, o, escape, e, r, slash
}

/// Which pane the list keys are talking to. `reader` is entered with
/// Return/o and left with Esc; while there the list keys pause so the
/// message can be scrolled with the arrows.
enum MailKeyZone: Equatable { case list, reader }

/// What a key press does. Every case is an action the UI already had.
enum ListKeyAction: Equatable {
    case move(Int)
    case openReader
    case backToList
    case dismiss
    case reply
    case focusSearch
}

/// What holds keyboard focus in the mail surface's window.
enum MailKeyResponder: Equatable {
    /// A text field or editor (search, inline reply, compose, assistant).
    case text
    /// The message body's web view.
    case web
    case other

    @MainActor
    static func classify(_ responder: NSResponder?) -> MailKeyResponder {
        // NSTextField edits through the window's field editor, an NSTextView.
        if responder is NSText { return .text }
        var view = responder as? NSView
        while let current = view {
            if current is WKWebView { return .web }
            view = current.superview
        }
        return .other
    }
}

/// Everything the key decision depends on.
struct ListKeyState: Equatable {
    /// The same slice the app menus use, so `e`/`r`/`/` share M1's guards.
    var menu: MenuState
    var textInputFocused: Bool
    /// The list column shows firewall rows (not search hits, not loading).
    var showsRows: Bool
    var itemCount: Int
    /// Focus is in the reading pane (Return/o, or a click in the message).
    var readerFocused: Bool
}

/// Pure rules for the mail list's keyboard, pinned by the self-check.
enum ListKeyRules {
    private static let byCharacter: [Character: ListKey] = [
        "j": .j, "k": .k, "o": .o, "e": .e, "r": .r, "/": .slash,
    ]
    /// US-ANSI positions, used only when the input source types non-Latin
    /// characters (Korean 2-set: the "j" key produces "ㅓ").
    private static let byKeyCode: [Int: ListKey] = [
        kVK_ANSI_J: .j, kVK_ANSI_K: .k, kVK_ANSI_O: .o, kVK_ANSI_E: .e, kVK_ANSI_R: .r,
        kVK_ANSI_Slash: .slash,
    ]

    /// Resolve a key press. ⌘/⌃/⌥ never match (those belong to the menus).
    /// Shift never matches a letter or an arrow (reserved for range
    /// select); it is allowed only where the layout needs it to type "/".
    static func key(
        characters: String?, keyCode: UInt16, shift: Bool, commandControlOrOption: Bool
    ) -> ListKey? {
        guard !commandControlOrOption else { return nil }
        let named: ListKey? = switch Int(keyCode) {
        case kVK_UpArrow: .up
        case kVK_DownArrow: .down
        case kVK_Return, kVK_ANSI_KeypadEnter: .returnKey
        case kVK_Escape: .escape
        default: nil
        }
        if let named { return shift ? nil : named }
        if let lowered = characters?.lowercased(), lowered.count == 1,
           let character = lowered.first, character.isASCII
        {
            guard let key = byCharacter[character] else { return nil }
            return shift && key != .slash ? nil : key
        }
        return shift ? nil : byKeyCode[Int(keyCode)]
    }

    /// The action for a key, or nil to let the event through untouched.
    /// Nothing fires unless the mail surface is key, signed in, with no
    /// modal over it and no text field or editor holding focus.
    static func action(for key: ListKey, isRepeat: Bool, in s: ListKeyState) -> ListKeyAction? {
        let m = s.menu
        guard m.signedIn, m.fullViewOpen, m.mailSurfaceIsKey, !m.modalOpen,
              !s.textInputFocused, m.listHasSearchField
        else { return nil }
        // In the reading pane only Esc is ours: the arrows scroll the
        // message, and a form field inside an email must get its letters.
        if s.readerFocused { return key == .escape ? .backToList : nil }
        // Moving the selection unmounts an open inline reply (M1's rule).
        let canMove = s.showsRows && s.itemCount > 0 && !m.readerReplying
        switch key {
        case .up, .k: return canMove ? .move(-1) : nil
        case .down, .j: return canMove ? .move(1) : nil
        case .escape: return nil
        // One press, one action: a held key must not open, dismiss a run
        // of mail or restart a draft.
        case .returnKey, .o: return !isRepeat && s.showsRows && m.targetTier != nil ? .openReader : nil
        case .e: return !isRepeat && s.showsRows && MenuRules.isEnabled(.dismiss, in: m) ? .dismiss : nil
        case .r: return !isRepeat && s.showsRows && MenuRules.isEnabled(.reply, in: m) ? .reply : nil
        case .slash: return !isRepeat && MenuRules.isEnabled(.find, in: m) ? .focusSearch : nil
        }
    }

    /// The row a move lands on, or nil when it stays put (list edge, empty
    /// list). With nothing selected either direction starts at the top.
    static func movedSelection(ids: [String], selected: String?, delta: Int) -> String? {
        guard !ids.isEmpty else { return nil }
        guard let selected, let index = ids.firstIndex(of: selected) else { return ids.first }
        let next = min(max(index + delta, 0), ids.count - 1)
        return next == index ? nil : ids[next]
    }

    /// The row to select once `removed` leaves the list: the one that takes
    /// its place, else the one above, else none.
    static func selectionAfterRemoval(ids: [String], removed: String) -> String? {
        guard let index = ids.firstIndex(of: removed) else { return nil }
        if index + 1 < ids.count { return ids[index + 1] }
        return index > 0 ? ids[index - 1] : nil
    }
}

/// A key press as the catcher saw it, before any rule ran.
struct ListKeyPress {
    let key: ListKey
    let isRepeat: Bool
    let responder: MailKeyResponder
    let window: NSWindow
}

/// Feeds the mail list its key presses. A local event monitor rather than
/// SwiftUI focus: the rows are plain buttons that never take focus on
/// click, and the message web view keeps first responder once clicked, so
/// `.focusable` + `.onKeyPress` would go deaf after the first mouse use.
/// The monitor only sees events already routed to this app, and acts only
/// on those addressed to the window this view sits in while it is key.
struct MailListKeyCatcher: NSViewRepresentable {
    /// Returns true when the press was handled (the event is consumed).
    let onKey: @MainActor (ListKeyPress) -> Bool
    /// A click outside the message body: focus is back in the list.
    let onClickOutsideReader: @MainActor () -> Void

    func makeNSView(context _: Context) -> MailListKeyView {
        let view = MailListKeyView()
        view.onKey = onKey
        view.onClickOutsideReader = onClickOutsideReader
        return view
    }

    func updateNSView(_ view: MailListKeyView, context _: Context) {
        view.onKey = onKey
        view.onClickOutsideReader = onClickOutsideReader
    }

    static func dismantleNSView(_ view: MailListKeyView, coordinator _: ()) {
        view.removeMonitor()
    }
}

final class MailListKeyView: NSView {
    var onKey: (@MainActor (ListKeyPress) -> Bool)?
    var onClickOutsideReader: (@MainActor () -> Void)?
    private var monitor: Any?
    /// Windows whose opening focus was already handed back to the list.
    private static let focusReleased = NSHashTable<NSWindow>.weakObjects()

    // Invisible and never in the way of a click.
    override func hitTest(_: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        removeMonitor()
        guard window != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown]) {
            [weak self] event in
            guard let self else { return event }
            return self.handle(event) ? nil : event
        }
        releaseOpeningFocus()
    }

    /// AppKit gives a freshly shown window's focus to its first text field,
    /// here the search field, which would swallow every list key. Hand it
    /// back once per window; `/` and ⌘F are how search takes the keyboard.
    /// Next runloop turn: the window is shown after this view is attached,
    /// and a pending Find or Compose focus is queued later, so it still wins.
    private func releaseOpeningFocus() {
        guard let window, !Self.focusReleased.contains(window) else { return }
        Self.focusReleased.add(window)
        DispatchQueue.main.async { [weak window] in
            guard let window, MailKeyResponder.classify(window.firstResponder) == .text else { return }
            window.makeFirstResponder(nil)
        }
    }

    func removeMonitor() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    /// True when the event was consumed.
    private func handle(_ event: NSEvent) -> Bool {
        guard let window, event.window === window, window.isKeyWindow else { return false }
        let responder = MailKeyResponder.classify(window.firstResponder)
        if event.type == .leftMouseDown {
            let hit = window.contentView?.hitTest(event.locationInWindow)
            if MailKeyResponder.classify(hit) != .web {
                if responder == .web { window.makeFirstResponder(nil) }
                onClickOutsideReader?()
            }
            return false  // clicks always go on to their target
        }
        let flags = event.modifierFlags
        guard let key = ListKeyRules.key(
            characters: event.charactersIgnoringModifiers, keyCode: event.keyCode,
            shift: flags.contains(.shift),
            commandControlOrOption: !flags.isDisjoint(with: [.command, .control, .option]))
        else { return false }
        return onKey?(ListKeyPress(
            key: key, isRepeat: event.isARepeat, responder: responder, window: window)) ?? false
    }
}

/// Moving keyboard focus into and out of the message body.
@MainActor
enum MailReaderFocus {
    /// Make the message web view first responder so the arrows, Space and
    /// Page Up/Down scroll it. A plain-text message has no web view; the
    /// zone alone marks the pane then.
    static func enter(in window: NSWindow) {
        guard let web = firstWebView(in: window.contentView) else { return }
        window.makeFirstResponder(web)
    }

    static func leave(in window: NSWindow) {
        if MailKeyResponder.classify(window.firstResponder) == .web {
            window.makeFirstResponder(nil)
        }
    }

    private static func firstWebView(in view: NSView?) -> WKWebView? {
        guard let view else { return nil }
        if let web = view as? WKWebView { return web }
        for subview in view.subviews {
            if let web = firstWebView(in: subview) { return web }
        }
        return nil
    }
}
