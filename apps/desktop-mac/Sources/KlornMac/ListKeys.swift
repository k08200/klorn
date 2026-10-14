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
/// message can be scrolled with the arrows. Owned by each FullView, so the
/// bar's panel and the main window never share it.
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
enum MailKeyResponder: Equatable, CaseIterable {
    /// Nothing in particular: the window itself, or a container the list
    /// sits in. The only state in which the list keys act on the list.
    case list
    /// A text field or editor (search, inline reply, compose, assistant).
    case text
    /// The message body's web view.
    case web
    /// Any other view that took focus (Tab / Full Keyboard Access): a
    /// button, segmented control, popup. Its keys are its own — Return and
    /// Space activate it, the arrows drive it.
    case control

    /// The facts `classify` reads off the responder chain. Pure, so the
    /// self-check can pin the decision without AppKit objects.
    struct Facts: Equatable {
        /// No first responder, or the window itself.
        var isWindowOrNil: Bool
        var isText: Bool
        var inWebView: Bool
        /// A view the list's key catcher lives inside (content view,
        /// hosting view): a container, never a control.
        var containsList: Bool
    }

    static func classify(_ facts: Facts) -> MailKeyResponder {
        if facts.isText { return .text }
        if facts.inWebView { return .web }
        if facts.isWindowOrNil || facts.containsList { return .list }
        return .control
    }

    @MainActor
    static func classify(_ responder: NSResponder?, listAnchor: NSView?) -> MailKeyResponder {
        let view = responder as? NSView
        return classify(Facts(
            isWindowOrNil: responder == nil || responder is NSWindow,
            // NSTextField edits through the window's field editor, an NSTextView.
            isText: responder is NSText,
            inWebView: webView(containing: view) != nil,
            containsList: view.map { listAnchor?.isDescendant(of: $0) ?? false } ?? false))
    }

    @MainActor
    static func webView(containing view: NSView?) -> WKWebView? {
        var current = view
        while let candidate = current {
            if let web = candidate as? WKWebView { return web }
            current = candidate.superview
        }
        return nil
    }
}

/// Everything the key decision depends on.
struct ListKeyState: Equatable {
    /// The same slice the app menus use, so `e`/`r`/`/` share M1's guards.
    var menu: MenuState
    var responder: MailKeyResponder
    /// An input method is composing (marked text) in the focused view.
    var composingText: Bool
    var zone: MailKeyZone
    /// The list column shows firewall rows (not search hits, not loading).
    var showsRows: Bool
    var itemCount: Int

    /// Focus is in the reading pane (Return/o, or a click in the message).
    var readerFocused: Bool { zone == .reader || responder == .web }
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
    /// modal over it, and focus is on the list or the message — never on a
    /// text field, an editor, a focused control, or mid-composition.
    static func action(for key: ListKey, isRepeat: Bool, in s: ListKeyState) -> ListKeyAction? {
        let m = s.menu
        guard m.signedIn, m.fullViewOpen, m.mailSurfaceIsKey, !m.modalOpen, m.listHasSearchField,
              s.responder == .list || s.responder == .web, !s.composingText
        else { return nil }
        // In the reading pane only Esc is ours: the arrows scroll the
        // message. Known limit: a caret in an email's own form field (no
        // composition under way) cannot be told apart from plain message
        // focus without asking the page, so Esc there still returns to the
        // list; letters typed into such a field are never taken.
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

    /// The row to select once `removed` leaves the list: the nearest row
    /// below it that is still present, else the nearest above, else none.
    /// `ids` is the list as it was when the key was pressed; `present` is
    /// the list after the removal (and any refresh) landed.
    static func selectionAfterRemoval(ids: [String], removed: String, present: Set<String>) -> String? {
        guard let index = ids.firstIndex(of: removed) else { return nil }
        let below = ids[(index + 1)...]
        let above = ids[..<index].reversed()
        return (Array(below) + Array(above)).first { $0 != removed && present.contains($0) }
    }

    /// Whether the focus a freshly shown window handed to a text field
    /// should be given back to the list. Only the search field's default
    /// focus is released: never one the user asked for (⌘F, `/`), never
    /// under a modal (compose owns its own field), never another field.
    static func releasesOpeningFocus(
        responder: MailKeyResponder, fieldIsSearch: Bool, searchRequested: Bool, modalOpen: Bool
    ) -> Bool {
        responder == .text && fieldIsSearch && !searchRequested && !modalOpen
    }
}

/// A key press as the catcher saw it, before any rule ran.
struct ListKeyPress {
    let key: ListKey
    let isRepeat: Bool
    let responder: MailKeyResponder
    let composingText: Bool
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
    /// Whether the search field's opening focus may be handed back
    /// (false once the user asked for search, or under a modal).
    let mayReleaseOpeningFocus: @MainActor () -> Bool

    func makeNSView(context _: Context) -> MailListKeyView {
        let view = MailListKeyView()
        apply(to: view)
        return view
    }

    func updateNSView(_ view: MailListKeyView, context _: Context) {
        apply(to: view)
    }

    private func apply(to view: MailListKeyView) {
        view.onKey = onKey
        view.onClickOutsideReader = onClickOutsideReader
        view.mayReleaseOpeningFocus = mayReleaseOpeningFocus
    }

    static func dismantleNSView(_ view: MailListKeyView, coordinator _: ()) {
        view.removeMonitor()
    }
}

final class MailListKeyView: NSView {
    var onKey: (@MainActor (ListKeyPress) -> Bool)?
    var onClickOutsideReader: (@MainActor () -> Void)?
    var mayReleaseOpeningFocus: (@MainActor () -> Bool)?
    /// Only written on the main thread; unsafe so deinit can release it.
    nonisolated(unsafe) private var monitor: Any?
    /// Windows whose opening focus was already looked at.
    private static let focusReleased = NSHashTable<NSWindow>.weakObjects()

    deinit {
        if let monitor { NSEvent.removeMonitor(monitor) }
    }

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

    func removeMonitor() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    /// AppKit gives a freshly shown window's focus to its first text field,
    /// here the search field, which would swallow every list key. Hand it
    /// back once per window; `/` and ⌘F are how search takes the keyboard.
    /// Decided on the next runloop turn (the window is shown after this
    /// view is attached) by `ListKeyRules.releasesOpeningFocus`.
    private func releaseOpeningFocus() {
        guard let window, !Self.focusReleased.contains(window) else { return }
        Self.focusReleased.add(window)
        DispatchQueue.main.async { [weak self, weak window] in
            guard let self, let window else { return }
            let responder = MailKeyResponder.classify(window.firstResponder, listAnchor: self)
            guard ListKeyRules.releasesOpeningFocus(
                responder: responder, fieldIsSearch: self.isSearchField(window.firstResponder),
                searchRequested: !(self.mayReleaseOpeningFocus?() ?? false),
                modalOpen: window.attachedSheet != nil)
            else { return }
            window.makeFirstResponder(nil)
        }
    }

    /// The search field is the only text field laid out inside the list
    /// column, which is exactly this view's frame (it is the column's
    /// background). A field editor stands in for the field it edits.
    private func isSearchField(_ responder: NSResponder?) -> Bool {
        var field = responder as? NSView
        if let editor = responder as? NSText, let owner = editor.delegate as? NSView { field = owner }
        guard let field, field.window === window else { return false }
        return convert(bounds, to: nil).contains(field.convert(field.bounds, to: nil))
    }

    /// True when the event was consumed.
    private func handle(_ event: NSEvent) -> Bool {
        guard let window, event.window === window, window.isKeyWindow else { return false }
        let first = window.firstResponder
        let responder = MailKeyResponder.classify(first, listAnchor: self)
        if event.type == .leftMouseDown {
            let hit = window.contentView?.hitTest(event.locationInWindow)
            if MailKeyResponder.webView(containing: hit) == nil {
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
        // An input method mid-composition owns every key, Esc included
        // (it cancels the composition). Covers the message web view too.
        let composing = (first as? NSTextInputClient)?.hasMarkedText()
            ?? (MailKeyResponder.webView(containing: first as? NSView) as? NSTextInputClient)?
            .hasMarkedText() ?? false
        return onKey?(ListKeyPress(
            key: key, isRepeat: event.isARepeat, responder: responder,
            composingText: composing, window: window)) ?? false
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
        if MailKeyResponder.webView(containing: window.firstResponder as? NSView) != nil {
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
