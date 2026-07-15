import AppKit
import SwiftUI

/// Owns the PushCard panel: one non-focus-stealing card below the top bar,
/// presented when a new PUSH item arrives, with the 3 quick-reply drafts
/// prefetched on appear.
///
/// Focus contract (same as TopBarController's pill): the card appears with
/// `orderFrontRegardless()` and never takes the keyboard on its own. Keys
/// (1/2/3/⏎/esc) only work after an explicit arm — a click on the card or the
/// global hotkey — which makes the nonactivating panel key WITHOUT activating
/// the app. A stray "1" typed into the user's editor must never send an email.
@MainActor
final class PushCardController {
    private let model: AppModel
    private let state = PushCardState()
    private var queue = PushCardQueue()
    private var panel: NSPanel?
    private var keyMonitor: Any?
    private var resignObserver: NSObjectProtocol?
    /// Gap between the pill (52 high, 8 inset — TopBarMetrics/TopBarController)
    /// and the card, so the card visually hangs off the bar like the reference.
    private static let topOffset: CGFloat = 8 + 52 + 8

    var isVisible: Bool { panel?.isVisible ?? false }

    init(model: AppModel) {
        self.model = model
    }

    // No deinit teardown: the AppDelegate owns exactly one controller for the
    // app's whole lifetime, so the key monitor is never orphaned.

    /// New PUSH items from the firewall diff. Returns whether a card is on
    /// screen (the caller uses this to decide the OS-banner fallback).
    @discardableResult
    func present(_ items: [FirewallItem]) -> Bool {
        guard NSScreen.main != nil else { return false }  // headless: banner instead
        let hadCurrent = queue.current != nil
        queue.enqueue(items)
        if !hadCurrent { showCurrent() } else { state.pendingCount = queue.pendingCount }
        return queue.current != nil
    }

    /// Global-hotkey entry point while a card is visible: give the card the
    /// keyboard (or release it if it already has it).
    func armKeyboard() {
        guard let panel, panel.isVisible else { return }
        if panel.isKeyWindow {
            // resignKey() is an AppKit notification hook, not an action: it
            // flips our isKeyWindow flag but the WindowServer never returns
            // real key status to the user's previous app, so their next
            // keystrokes are silently lost. orderOut IS a window-server
            // action that hands the keyboard back; re-fronting without
            // makeKey keeps the card visible but unarmed.
            panel.orderOut(nil)
            panel.orderFrontRegardless()
            state.keysArmed = false
        } else {
            panel.makeKey()  // nonactivating: our app stays in the background
            state.keysArmed = panel.isKeyWindow
        }
    }

    // MARK: - Card lifecycle

    private func showCurrent() {
        guard let item = queue.current else { hide(); return }
        state.item = item
        state.pendingCount = queue.pendingCount
        state.drafts = .loading
        state.sendingIndex = nil
        state.sentIndex = nil
        state.sendError = nil
        render()
        fetchDrafts(for: item)
    }

    private func fetchDrafts(for item: FirewallItem) {
        Task { [weak self] in
            guard let self else { return }
            let fetch = await self.model.fetchReplyOptions(item)
            // The card may have advanced to another item while the LLM drafted.
            guard self.state.item?.id == item.id else { return }
            switch fetch {
            case .ready(let options): self.state.drafts = .ready(options.options)
            case .needsPro: self.state.drafts = .needsPro
            case .failed(let message): self.state.drafts = .failed(message)
            }
        }
    }

    private func advance() {
        queue.advance()
        if queue.current != nil { showCurrent() } else { hide() }
    }

    private func hide() {
        queue.clear()
        state.item = nil
        state.keysArmed = false
        panel?.orderOut(nil)
    }

    // MARK: - Actions

    private func makeActions() -> PushCardActions {
        PushCardActions(
            onSend: { [weak self] index in self?.send(index) },
            onOpen: { [weak self] in self?.openOnWeb() },
            onDismiss: { [weak self] in self?.advance() },  // local only — never archives
            onRetry: { [weak self] in
                guard let self, let item = self.state.item else { return }
                self.state.drafts = .loading
                self.fetchDrafts(for: item)
            },
            onArm: { [weak self] in self?.armKeyboard() })
    }

    private func send(_ index: Int) {
        guard let item = state.item,
              case .ready(let options) = state.drafts,
              options.indices.contains(index),
              state.sendingIndex == nil, state.sentIndex == nil
        else { return }
        state.sendingIndex = index
        state.sendError = nil
        Task { [weak self] in
            guard let self else { return }
            // sendReply (not reply): the card owns its own error channel and
            // must never clear/overwrite the reading-pane composer's live
            // replyError while that surface is mid-send for another email.
            let error = await self.model.sendReply(item, body: options[index].body)
            guard self.state.item?.id == item.id else { return }
            self.state.sendingIndex = nil
            if let error {
                self.state.sendError = error
            } else {
                self.state.sentIndex = index
                AccessibilityNotification.Announcement("Reply sent").post()
                try? await Task.sleep(for: .seconds(1.2))  // let the ✓ land
                guard self.state.item?.id == item.id else { return }
                self.advance()
            }
        }
    }

    private func openOnWeb() {
        if let url = TopBarController.resolveURL(state.item) {
            NSWorkspace.shared.open(url)
        }
        advance()
    }

    // MARK: - Panel

    private func render() {
        let panel = self.panel ?? makePanel()
        self.panel = panel
        if panel.contentView == nil || !(panel.contentView is NSHostingView<PushCardRoot>) {
            panel.contentView = NSHostingView(
                rootView: PushCardRoot(state: state, actions: makeActions()))
        }
        position(panel)
        panel.orderFrontRegardless()  // never makeKey here — see focus contract
    }

    private func makePanel() -> NSPanel {
        let rect = NSRect(origin: .zero, size: PushCardMetrics.size)
        // KeyablePanel + .nonactivatingPanel: CAN become key (for armed keys)
        // but only when we ask, and without activating the app.
        let panel = KeyablePanel(
            contentRect: rect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        installKeyHandling(panel)
        return panel
    }

    private func position(_ panel: NSPanel) {
        guard let visible = NSScreen.main?.visibleFrame else { return }
        let size = PushCardMetrics.size
        let origin = NSPoint(
            x: visible.midX - size.width / 2,
            y: visible.maxY - Self.topOffset - size.height)
        panel.setFrame(NSRect(origin: origin, size: size), display: true, animate: false)
    }

    private func installKeyHandling(_ panel: NSPanel) {
        // Local monitor = events already routed to OUR app; combined with the
        // isKeyWindow guard this can only fire after an explicit arm.
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, let panel = self.panel, panel.isKeyWindow,
                  let action = PushCardKeymap.action(
                      chars: event.charactersIgnoringModifiers, keyCode: event.keyCode)
            else { return event }
            switch action {
            case .send(let index): self.send(index)
            case .open: self.openOnWeb()
            case .dismiss: self.advance()
            }
            return nil  // consumed
        }
        resignObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification, object: panel, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.state.keysArmed = false }
        }
    }
}

/// Wrapper so the hosting view has a concrete root type (needed for the
/// contentView reuse check above).
struct PushCardRoot: View {
    let state: PushCardState
    let actions: PushCardActions

    var body: some View {
        PushCard(state: state, actions: actions)
    }
}
