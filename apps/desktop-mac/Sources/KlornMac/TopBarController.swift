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
    /// Last state render() framed for — gates the snap-back-free re-render.
    private var renderedState: BarState?
    /// True while an explicit summon (⌥⌘K / Show-all) is showing the bar even
    /// though hidden-pill mode suppresses the ambient pill. Cleared on dismiss.
    private var summoned = false
    private static let topMargin: CGFloat = 8
    /// Persists the full window's user-chosen size after a drag-resize.
    private let resizeRecorder = PanelResizeRecorder()

    init(model: AppModel) {
        self.model = model
        resizeRecorder.onLiveResizeEnd = { [weak self] size in
            self?.model.settings.fullWindowSize = size
        }
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

    /// First launch + Finder/Dock reopen: show the real app window. An
    /// explicit summon, so hidden-pill mode must not eat it.
    func openFull() {
        summoned = true
        setState(.full)
    }

    /// What ⌥⌘K does, given whether the bar is on screen and its state. Pure so
    /// the self-check pins the cycle: nothing → the MINIMAL pill (not the big
    /// panel), pill → expanded → FULL (dogfood 2026-07-20: the shortcut must
    /// reach the largest view), full → dismiss back to rest.
    enum SummonAction: Equatable, Sendable { case showPill, expand, expandFull, dismissToRest }
    nonisolated static func summonAction(isVisible: Bool, state: BarState) -> SummonAction {
        guard isVisible else { return .showPill }
        switch state {
        case .collapsed: return .expand
        case .expanded: return .expandFull
        case .full: return .dismissToRest
        }
    }

    /// Global-hotkey entry point. Never steals focus on the first press; each
    /// further press steps up one size, and from full it closes back to rest.
    func toggle() {
        switch Self.summonAction(isVisible: panel?.isVisible ?? false, state: state) {
        case .showPill:
            summoned = true          // draw the pill even in hidden-pill mode
            setState(.collapsed)
        case .expand:
            setState(.expanded)
        case .expandFull:
            setState(.full)
        case .dismissToRest:
            dismiss()
        }
    }

    /// Return to the resting state: the ambient pill when it's enabled, else
    /// nothing (the menu-bar icon is the anchor in hidden-pill mode).
    private func dismiss() {
        summoned = false
        // Leaving via ⌥⌘K / "Close" must also drop the Preferences overlay —
        // otherwise the stale flag re-opens it on the NEXT full-view entry.
        model.showPreferences = false
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
        let size = panelSize(for: state)
        let root = TopBarRoot(state: state, actions: makeActions())
            .environment(model)
            // Localized strings are read through L(), which SwiftUI cannot
            // observe. Keying the tree on the language revision forces a full
            // rebuild so a language change lands without a relaunch.
            .id(model.settings.languageRevision)
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
        // Re-pinning on EVERY render fought the user: any same-state
        // refresh() snapped a dragged window back to top-center and
        // re-derived its size mid-session. Only a state change
        // (pill↔expanded↔full morph), a fresh panel, or a window that is no
        // longer on ANY screen (display unplugged/resized) may reposition —
        // a partially off-screen frame is respected as a deliberate drag.
        let frameLost = !(NSScreen.main?.visibleFrame.intersects(panel.frame) ?? true)
        if Self.shouldSetFrame(
            renderedState: renderedState, state: state,
            panelVisible: panel.isVisible, frameLost: frameLost)
        {
            setFrame(panel, size: size)
        }
        renderedState = state
        panel.applyGlassShape(cornerRadius: TopBarMetrics.corner(for: state))
        NSApp.setActivationPolicy(
            Self.activationPolicy(for: state, showInDock: model.settings.showInDock))
        if focusable {
            // Full is a real, focusable app window, so it takes focus outright —
            // the reply field has to be able to type.
            panel.makeKeyAndOrderFront(nil)
            NSApp.activate()
        } else {
            // Expanded is Cmd+Tab-able but still never steals focus.
            panel.orderFrontRegardless()
        }
    }

    /// Whether Klorn appears in Cmd+Tab and the Dock.
    ///
    /// Resting, Klorn is ambient — it must stay out of both, which is the whole
    /// point of the accessory policy. Once the user has deliberately opened the
    /// panel it stops being ambient and becomes something they switch back to,
    /// so from `.expanded` up it joins the app switcher (founder decision,
    /// 2026-07-28: regular only while open, not always).
    ///
    /// `showInDock` is the opt-in escape hatch (default off): people who expect
    /// Cmd+Tab to reach every running app get that, and the resting default
    /// stays ambient for everyone else. Pure, for the harness.
    nonisolated static func activationPolicy(
        for state: BarState,
        showInDock: Bool = false
    ) -> NSApplication.ActivationPolicy {
        if showInDock { return .regular }
        return state == .collapsed ? .accessory : .regular
    }

    /// Re-apply the activation policy for the current state. Called when the
    /// user flips show-in-Dock, so the Dock icon appears/disappears on the
    /// click rather than at the next panel state change.
    func refreshActivationPolicy() {
        NSApp.setActivationPolicy(
            Self.activationPolicy(for: state, showInDock: model.settings.showInDock))
    }

    /// Show one item in the full view's reading pane. The single in-app answer
    /// to "open this", shared by the panel rows and the urgent-mail card.
    func openInApp(_ item: FirewallItem) {
        setState(.full)
        Task { await model.select(item) }
    }

    private func makeActions() -> TopBarActions {
        TopBarActions(
            onExpand: { [weak self] in self?.setState(.expanded) },
            onExpandFull: { [weak self] in self?.setState(.full) },
            onRestore: { [weak self] in self?.setState(.expanded) },
            onCollapse: { [weak self] in self?.dismiss() },  // "Close" → back to rest
            onClose: { [weak self] in self?.dismiss() },     // header ✕ → back to rest
            onSignIn: { [weak self] in guard let self else { return }; Task { await self.model.signIn() } },
            onSignOut: { [weak self] in self?.model.signOut() },
            onOpenInApp: { [weak self] item in self?.openInApp(item) },
            onOpenTier: { [weak self] tier in
                guard let self else { return }
                self.model.showTier(tier)
                self.setState(.full)
            },
            onOpenFull: { [weak self] in self?.setState(.full) },
            onOpenProposals: { [weak self] in
                guard let self else { return }
                self.model.listMode = .proposals
                self.setState(.full)
            },
            onDismiss: { [weak self] item in guard let self else { return }; Task { await self.model.dismiss(item) } },
            onSnooze: { [weak self] item, option in
                guard let self else { return }
                Task { await self.model.snooze(item, until: option.resurface()) }
            },
            onSetTier: { [weak self] item, tier in
                guard let self else { return }
                Task { await self.model.setTier(item, to: tier) }
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

    /// The frame size for a state: full fits the screen (and honors the
    /// user's drag-resize); pill/expanded stay at their fixed metrics.
    private func panelSize(for state: BarState) -> NSSize {
        let ideal = state == .full
            ? (model.settings.fullWindowSize ?? TopBarMetrics.full)
            : TopBarMetrics.size(for: state)
        guard state == .full, let visible = NSScreen.main?.visibleFrame else { return ideal }
        return TopBarMetrics.fittedSize(
            ideal: ideal, visible: visible.size, floor: TopBarMetrics.fullMin)
    }

    /// Pure for the harness: when may render() move/resize the panel? Only a
    /// state morph, a not-yet-shown panel, or a frame stranded off every
    /// screen — never a same-state re-render (that was the snap-back bug).
    nonisolated static func shouldSetFrame(
        renderedState: BarState?, state: BarState, panelVisible: Bool, frameLost: Bool
    ) -> Bool {
        renderedState != state || !panelVisible || frameLost
    }

    /// Pure for the harness: full is a resizable key-able window (the fixed
    /// 1400×860 could not be shrunk — clipped-display report, 2026-08-05);
    /// pill/expanded stay non-focus-stealing and fixed.
    nonisolated static func styleMask(focusable: Bool) -> NSWindow.StyleMask {
        focusable ? [.borderless, .resizable] : [.borderless, .nonactivatingPanel]
    }

    private func makePanel(focusable: Bool) -> NSPanel {
        let rect = NSRect(origin: .zero, size: TopBarMetrics.collapsed)
        // Non-focus-stealing for pill/panel (`.nonactivatingPanel`); a key-able
        // window for full so the reply field can accept typing.
        let mask = Self.styleMask(focusable: focusable)
        let panel: NSPanel = focusable
            ? KeyablePanel(contentRect: rect, styleMask: mask, backing: .buffered, defer: false)
            : NSPanel(contentRect: rect, styleMask: mask, backing: .buffered, defer: false)
        if focusable {
            // Borderless windows still get native edge-drag with .resizable;
            // the floor keeps the fixed sidebar + list columns from clipping.
            // Screen-clamped below in setFrame — a floor wider than the
            // display would let live-resize park the window off-screen.
            panel.contentMinSize = TopBarMetrics.fullMin
            panel.delegate = resizeRecorder
        }
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = !focusable
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // Light v2: the panel is always a light surface — pin the effective
        // appearance so semantic colors resolve light even in system dark mode.
        panel.appearance = NSAppearance(named: .aqua)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        return panel
    }

    /// Keep the bar pinned top-center; animate the frame so expand/collapse morphs.
    private func setFrame(_ panel: NSPanel, size: NSSize) {
        guard let visible = NSScreen.main?.visibleFrame else { return }
        // The drag-resize floor must also respect the CURRENT screen: a
        // contentMinSize wider than the display would let AppKit's live
        // resize (and possibly programmatic frames) exceed the screen, which
        // is the exact clipping fittedSize exists to prevent.
        if panelIsFocusable {
            panel.contentMinSize = TopBarMetrics.fittedSize(
                ideal: TopBarMetrics.fullMin, visible: visible.size)
        }
        // Honor Reduce Motion (WCAG 2.3.3 + CLAUDE.md): a full-window morph up to
        // 1400px is exactly the large motion the setting exists to suppress.
        let animate = Self.shouldAnimateFrame(
            reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
        let frame = TopBarMetrics.pinnedFrame(
            size: size, visible: visible, topMargin: Self.topMargin)
        panel.setFrame(frame, display: true, animate: animate)
        if animate {
            // The shadow computed mid-morph is stale (square) — re-derive it
            // once the frame animation lands.
            let settle = panel.animationResizeTime(frame) + 0.05
            DispatchQueue.main.asyncAfter(deadline: .now() + settle) { [weak panel] in
                panel?.invalidateShadow()
            }
        }
    }

    /// Animate the panel morph unless the user asked for reduced motion. Pure for testing.
    nonisolated static func shouldAnimateFrame(reduceMotion: Bool) -> Bool { !reduceMotion }

}

/// NSWindowDelegate hook that reports the size a user drag-resize settled on,
/// so the full window's size survives state changes and relaunch. A separate
/// NSObject because the controller is a plain class.
@MainActor
final class PanelResizeRecorder: NSObject, NSWindowDelegate {
    var onLiveResizeEnd: ((NSSize) -> Void)?

    func windowDidEndLiveResize(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        onLiveResizeEnd?(window.frame.size)
    }
}
