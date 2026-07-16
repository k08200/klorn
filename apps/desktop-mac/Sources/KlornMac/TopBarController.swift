import AppKit
import SwiftUI

/// A borderless panel that can still become key — used only for the full state
/// so its reply text field can receive keyboard input. (A plain borderless
/// window returns false for canBecomeKey.)
final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

/// Owns the always-on top bar: a single non-focus-stealing panel pinned to the
/// top-center of the screen. Collapsed it's a slim pill; `☰` expands it (the
/// window frame animates) into the full panel, `— Close` collapses it back.
/// Surfacing must never pull the user out of their app — hence `.nonactivatingPanel`,
/// `.floating`, `hidesOnDeactivate = false`, and `orderFrontRegardless()`.
@MainActor
final class TopBarController {
    private let model: AppModel
    private var panel: NSPanel?
    private var state: BarState = .collapsed
    private var panelIsFocusable = false
    /// True while an explicit summon (⌥⌘K / Show-all) is showing the bar even
    /// though hidden-pill mode suppresses the ambient pill. Cleared on dismiss.
    private var summoned = false
    private static let topMargin: CGFloat = 8

    init(model: AppModel) {
        self.model = model
    }

    /// Show the bar (collapsed) at launch and keep it present for the session.
    func show() {
        guard NSScreen.main != nil else { return }  // headless: nothing to draw
        state = .collapsed
        render()
    }

    /// New PUSH arrived: the live count already updates via observation; also post
    /// an OS banner as a fallback (a no-op on unbundled `swift run`, which has no
    /// bundle id). `bannerFallback` is false when the PushCard is on screen — the
    /// card is the primary surface, so a banner on top of it would double-notify.
    func handleNewPush(_ items: [FirewallItem], bannerFallback: Bool = true) {
        guard !items.isEmpty else { return }
        // Announce for VoiceOver (WCAG 4.1.3 Status Messages): the AT-equivalent of
        // the always-live pill count, so it fires regardless of the OS-banner
        // preference (that toggle only gates the interruptive system banner below).
        AccessibilityNotification.Announcement(Self.pushAnnouncement(newCount: items.count)).post()
        // The pill's live count already updated via observation; the OS banner is
        // the opt-out-able extra (Preferences → Notifications).
        guard bannerFallback, model.settings.notificationsEnabled else { return }
        items.forEach { PushNotifier.post($0) }
    }

    /// VoiceOver announcement for newly-arrived PUSH. Pure for testing.
    nonisolated static func pushAnnouncement(newCount n: Int) -> String {
        n == 1 ? "1 new message needs you" : "\(n) new messages need you"
    }

    /// Re-render after an external settings change (menu-bar "Hide/Show top
    /// bar" — the Preferences toggle only takes effect on the next state
    /// change, but the menu item must apply immediately).
    func refresh() {
        render()
    }

    /// PushCard "Show all N": open the expanded panel (creating the bar if
    /// hidden-pill mode has nothing on screen yet).
    func expand() {
        summoned = true
        setState(.expanded)
    }

    /// Menu-bar "Preferences…": jump to the full view with the overlay open.
    func openPreferences() {
        summoned = true
        setState(.full)
        model.showPreferences = true
    }

    /// What ⌥⌘K does, given whether the bar is on screen and its state. Pure so
    /// the self-check pins the cycle: nothing → the MINIMAL pill (not the big
    /// panel), pill → expanded, expanded/full → dismiss back to rest.
    enum SummonAction: Equatable, Sendable { case showPill, expand, dismissToRest }
    nonisolated static func summonAction(isVisible: Bool, state: BarState) -> SummonAction {
        guard isVisible else { return .showPill }
        return state == .collapsed ? .expand : .dismissToRest
    }

    /// Global-hotkey entry point. Never steals focus; always shows the minimal
    /// pill first (a second press expands) instead of jumping to the big panel.
    func toggle() {
        switch Self.summonAction(isVisible: panel?.isVisible ?? false, state: state) {
        case .showPill:
            summoned = true          // draw the pill even in hidden-pill mode
            setState(.collapsed)
        case .expand:
            setState(.expanded)
        case .dismissToRest:
            dismiss()
        }
    }

    /// Return to the resting state: the ambient pill when it's enabled, else
    /// nothing (the menu-bar icon is the anchor in hidden-pill mode).
    private func dismiss() {
        summoned = false
        if model.settings.pillVisible {
            setState(.collapsed)
        } else {
            state = .collapsed
            panel?.orderOut(nil)
        }
    }

    private func setState(_ newState: BarState) {
        state = newState
        render()
    }

    /// Whether the bar draws at all for this state. Hidden-pill mode only
    /// suppresses the COLLAPSED pill — the expanded/full states are always
    /// user-summoned (☰, ⌥⌘K) and must never be eaten. Pure for testing.
    nonisolated static func shouldDraw(state: BarState, pillVisible: Bool) -> Bool {
        pillVisible || state != .collapsed
    }

    private func render() {
        // A summon (⌥⌘K / Show-all) draws the pill even in hidden-pill mode —
        // pillVisible only governs the RESTING ambient pill, not explicit intent.
        let effectiveVisible = model.settings.pillVisible || summoned
        guard Self.shouldDraw(state: state, pillVisible: effectiveVisible) else {
            panel?.orderOut(nil)
            return
        }
        let focusable = (state == .full)
        let size = TopBarMetrics.size(for: state)
        let root = TopBarRoot(state: state, actions: makeActions())
            .environment(model)
        // Recreate the window when the focus model flips: pill/panel are
        // non-focus-stealing; full is a key-able app window so its reply field
        // can accept keyboard input.
        if let existing = self.panel, panelIsFocusable != focusable {
            existing.orderOut(nil)
            self.panel = nil
        }
        let panel = self.panel ?? makePanel(focusable: focusable)
        panelIsFocusable = focusable
        panel.contentView = NSHostingView(rootView: root)
        self.panel = panel
        setFrame(panel, size: size)
        if focusable {
            // Full is a real, focusable app window: switch to a regular activation
            // policy (Dock icon + menu + real focus) so the reply field can type.
            NSApp.setActivationPolicy(.regular)
            panel.makeKeyAndOrderFront(nil)
            NSApp.activate()
        } else {
            // Ambient: no Dock icon, never steal focus from the user's app.
            NSApp.setActivationPolicy(.accessory)
            panel.orderFrontRegardless()
        }
    }

    private func makeActions() -> TopBarActions {
        TopBarActions(
            onExpand: { [weak self] in self?.setState(.expanded) },
            onExpandFull: { [weak self] in self?.setState(.full) },
            onRestore: { [weak self] in self?.setState(.expanded) },
            onCollapse: { [weak self] in self?.dismiss() },  // "Close" → back to rest
            onSignIn: { [weak self] in guard let self else { return }; Task { await self.model.signIn() } },
            onSignOut: { [weak self] in self?.model.signOut() },
            onOpenWeb: { [weak self] item in self?.open(item) },
            onOpenInApp: { [weak self] item in
                guard let self else { return }
                self.setState(.full)
                Task { await self.model.select(item) }
            },
            onDismiss: { [weak self] item in guard let self else { return }; Task { await self.model.dismiss(item) } },
            onSnooze: { [weak self] item, option in
                guard let self else { return }
                Task { await self.model.snooze(item, until: option.resurface()) }
            },
            onSelect: { [weak self] item in guard let self else { return }; Task { await self.model.select(item) } },
            onOpenPreferences: { [weak self] in
                guard let self else { return }
                self.setState(.full)          // the overlay lives in the full view
                self.model.showPreferences = true
            },
            onHideBar: { [weak self] in
                guard let self else { return }
                self.model.settings.pillVisible = false  // status icon takes over
                self.setState(.collapsed)                // render() hides the panel
            },
            onQuit: { NSApplication.shared.terminate(nil) })
    }

    private func makePanel(focusable: Bool) -> NSPanel {
        let rect = NSRect(origin: .zero, size: TopBarMetrics.collapsed)
        // Non-focus-stealing for pill/panel (`.nonactivatingPanel`); a key-able
        // window for full so the reply field can accept typing.
        let mask: NSWindow.StyleMask = focusable ? [.borderless] : [.borderless, .nonactivatingPanel]
        let panel: NSPanel = focusable
            ? KeyablePanel(contentRect: rect, styleMask: mask, backing: .buffered, defer: false)
            : NSPanel(contentRect: rect, styleMask: mask, backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = !focusable
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        return panel
    }

    /// Keep the bar pinned top-center; animate the frame so expand/collapse morphs.
    private func setFrame(_ panel: NSPanel, size: NSSize) {
        guard let visible = NSScreen.main?.visibleFrame else { return }
        let origin = NSPoint(
            x: visible.midX - size.width / 2,
            y: visible.maxY - size.height - Self.topMargin)
        // Honor Reduce Motion (WCAG 2.3.3 + CLAUDE.md): a full-window morph up to
        // 1400px is exactly the large motion the setting exists to suppress.
        let animate = Self.shouldAnimateFrame(
            reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
        panel.setFrame(NSRect(origin: origin, size: size), display: true, animate: animate)
    }

    /// Animate the panel morph unless the user asked for reduced motion. Pure for testing.
    nonisolated static func shouldAnimateFrame(reduceMotion: Bool) -> Bool { !reduceMotion }

    private func open(_ item: FirewallItem?) {
        guard let url = Self.resolveURL(item) else {
            Log.app.debug("top bar open: no resolvable URL")
            return
        }
        NSWorkspace.shared.open(url)
    }

    /// Prefer an absolute item link; otherwise join a relative href onto the web
    /// base; with no item (or no href) fall back to the inbox root.
    nonisolated static func resolveURL(_ item: FirewallItem?) -> URL? {
        let base = Config.webBaseURL
        guard let item else { return URL(string: base) }
        if let href = item.href, let url = URL(string: href),
           let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
            return url
        }
        if let href = item.href, !href.isEmpty {
            let joined = href.hasPrefix("/") ? base + href : base + "/" + href
            return URL(string: joined)
        }
        return URL(string: base)
    }
}
