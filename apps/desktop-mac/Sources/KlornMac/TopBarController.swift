import AppKit
import SwiftUI

/// A borderless panel that can still become key — used for the expanded and
/// full states so they can receive keyboard input and, critically, so the app
/// has a window Cmd+Tab can actually raise. (A plain borderless window returns
/// false for canBecomeKey; an app whose only window can't become key never
/// fronts when picked in the switcher — dogfood 2026-08-15.)
final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    /// HARD clamp, at the AppKit layer: no matter who sets the frame — our
    /// pin, a background drag, a display swap moving the window across
    /// screens, or any system placement — the top edge may never rise above
    /// the visible area and the size may never exceed it. A borderless
    /// window has no title-bar constraint, so without this the header can
    /// lodge above the menu bar where nothing can grab it (dogfood
    /// 2026-08-18, twice — the render-time self-heal only ran on state
    /// changes and missed frames moved between renders).
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        let base = super.constrainFrameRect(frameRect, to: screen)
        guard let visible = (screen ?? NSScreen.main)?.visibleFrame else { return base }
        return KeyablePanel.clamped(base, into: visible)
    }

    /// Pure for the harness: shrink to fit, then shift fully on-screen
    /// (top-priority: the grab area at the top must stay reachable).
    nonisolated static func clamped(_ frame: NSRect, into visible: NSRect) -> NSRect {
        var f = frame
        f.size.width = min(f.width, visible.width)
        f.size.height = min(f.height, visible.height)
        if f.maxY > visible.maxY { f.origin.y = visible.maxY - f.height }
        if f.minY < visible.minY { f.origin.y = visible.minY }
        if f.maxX > visible.maxX { f.origin.x = visible.maxX - f.width }
        if f.minX < visible.minX { f.origin.x = visible.minX }
        return f
    }
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

    private var screenObserver: NSObjectProtocol?

    init(model: AppModel) {
        self.model = model
        // A display change can strand or clip the window between renders —
        // re-clamp immediately rather than waiting for the next state change.
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.reclampIfLost() }
        }
        resizeRecorder.onMoveOrResize = { [weak self] in
            MainActor.assumeIsolated { self?.reclampIfLost() }
        }
        // Message-menu enablement needs to know the panel (not Settings) is key.
        resizeRecorder.onKeyChange = { [weak self] isKey in
            MainActor.assumeIsolated { self?.model.barPanelIsKey = isKey }
        }
        resizeRecorder.onLiveResizeEnd = { [weak self] size in
            guard let self else { return }
            switch self.state {
            case .full: self.model.settings.fullWindowSize = size
            case .expanded: self.model.settings.expandedWindowSize = size
            case .collapsed: break  // pill is never resizable
            }
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

    /// Opens the Settings window (wired by the AppDelegate to SettingsOpener).
    var onOpenSettings: (() -> Void)?

    /// Menu-bar "Preferences…" and the in-app Preferences buttons: open the
    /// Settings window. The bar's own state is left alone — Settings is its
    /// own window now, not an overlay that needs the full view under it.
    func openPreferences() {
        onOpenSettings?()
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
        if model.settings.pillVisible {
            setState(.collapsed)
        } else {
            state = .collapsed
            // orderOut skips render(): drop the policy back to ambient here
            // too, or the app lingers in Cmd+Tab after Close.
            NSApp.setActivationPolicy(Self.activationPolicy(
                for: .collapsed, showInDock: model.settings.showInDock,
                settingsOpen: model.settingsWindowOpen))
            panel?.orderOut(nil)
            model.isFullViewOpen = false
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
        // Activation policy is applied on EVERY render, BEFORE the draw guard:
        // the hidden-pill early-return below used to skip it, which left a
        // stored show-in-Dock=true unapplied at launch and (inversely) a
        // stale .regular in Cmd+Tab after Close (2026-08-10 diagnosis).
        NSApp.setActivationPolicy(Self.activationPolicy(
            for: state, showInDock: model.settings.showInDock,
            settingsOpen: model.settingsWindowOpen))
        model.isFullViewOpen = (state == .full)
        guard Self.shouldDraw(state: state, pillVisible: effectiveVisible) else {
            panel?.orderOut(nil)
            return
        }
        // Expanded and full are both user-summoned app windows: key-able so
        // Cmd+Tab has something to raise (policy promotion alone never
        // registered the app in the switcher — expanded-state bug, 2026-08-15).
        // Only the ambient pill stays non-focus-stealing.
        let focusable = (state != .collapsed)
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
        var inheritedFrame: NSRect?
        if let existing = self.panel, panelIsFocusable != focusable {
            // Seed the replacement with the old frame so the pill↔expanded
            // morph still animates from where the old window sat.
            inheritedFrame = existing.isVisible ? existing.frame : nil
            existing.orderOut(nil)
            self.panel = nil
        }
        let panel = self.panel ?? makePanel(focusable: focusable)
        if let inherited = inheritedFrame { panel.setFrame(inherited, display: false) }
        panelIsFocusable = focusable
        let host = NSHostingView(rootView: root)
        // The controller owns the window frame (setFrame + user drag). The
        // default sizingOptions let SwiftUI ideal-size changes resize the
        // window — growing UP in AppKit coordinates, pushing the title bar
        // off-screen whenever a sidebar section handle made content taller
        // (clipping recording, 2026-08-19). Content adapts to the window,
        // never the reverse.
        host.sizingOptions = []
        panel.contentView = host
        self.panel = panel
        // Re-pinning on EVERY render fought the user: any same-state
        // refresh() snapped a dragged window back to top-center and
        // re-derived its size mid-session. Only a state change
        // (pill↔expanded↔full morph), a fresh panel, or a window that is no
        // longer on ANY screen (display unplugged/resized) may reposition —
        // a partially off-screen frame is respected as a deliberate drag.
        let frameLost = Self.isFrameLost(
            frame: panel.frame, visible: (panel.screen ?? NSScreen.main)?.visibleFrame)
        if Self.shouldSetFrame(
            renderedState: renderedState, state: state,
            panelVisible: panel.isVisible, frameLost: frameLost)
        {
            setFrame(panel, size: size)
        }
        let stateChanged = renderedState != state
        renderedState = state
        panel.applyGlassShape(cornerRadius: TopBarMetrics.corner(for: state))
        defer { reclampIfLost() }
        if focusable {
            // Expanded/full are real app windows the user just summoned
            // (☰, Show-all, ⌥⌘K) — taking focus is the intent. Activation
            // also completes the .accessory→.regular promotion; without it
            // the app never appears in Cmd+Tab (expanded-state bug,
            // 2026-08-15). Activate only on a state CHANGE so a same-state
            // refresh() (settings/language) can't yank focus back.
            panel.makeKeyAndOrderFront(nil)
            if stateChanged { NSApp.activate() }
        } else {
            // The ambient pill must never steal focus.
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
    /// stays ambient for everyone else.
    ///
    /// `settingsOpen`: the Settings window is a summoned window too, so it
    /// counts as "open" under the same rule — otherwise a collapse while
    /// Settings is up would drop it out of Cmd+Tab and take the menu bar
    /// with it. Closing Settings re-runs this. Pure, for the harness.
    nonisolated static func activationPolicy(
        for state: BarState,
        showInDock: Bool = false,
        settingsOpen: Bool = false
    ) -> NSApplication.ActivationPolicy {
        if showInDock || settingsOpen { return .regular }
        return state == .collapsed ? .accessory : .regular
    }

    /// Re-apply the activation policy for the current state. Called when the
    /// user flips show-in-Dock, so the Dock icon appears/disappears on the
    /// click rather than at the next panel state change.
    func refreshActivationPolicy() {
        NSApp.setActivationPolicy(Self.activationPolicy(
            for: state, showInDock: model.settings.showInDock,
            settingsOpen: model.settingsWindowOpen))
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
            onPinSender: { [weak self] item, tier in
                guard let self else { return }
                Task { await self.model.pinSender(item, to: tier) }
            },
            onUnpinSender: { [weak self] item in
                guard let self else { return }
                Task { await self.model.unpinSender(item) }
            },
            onSelect: { [weak self] item in guard let self else { return }; Task { await self.model.select(item) } },
            onOpenPreferences: { [weak self] in self?.openPreferences() },
            onHideBar: { [weak self] in
                guard let self else { return }
                self.model.settings.pillVisible = false  // status icon takes over
                self.setState(.collapsed)                // render() hides the panel
            },
            onQuit: { NSApplication.shared.terminate(nil) })
    }

    /// The frame size for a state: expanded and full fit the screen (the
    /// fixed 1140pt expanded overflowed narrow displays — clipping report,
    /// 2026-08-15) and honor the user's drag-resize; the pill stays fixed.
    private func panelSize(for state: BarState) -> NSSize {
        let ideal: NSSize
        switch state {
        case .collapsed: return TopBarMetrics.collapsed
        case .expanded: ideal = model.settings.expandedWindowSize ?? TopBarMetrics.expanded
        case .full: ideal = model.settings.fullWindowSize ?? TopBarMetrics.full
        }
        guard let visible = (panel?.screen ?? NSScreen.main)?.visibleFrame else { return ideal }
        return TopBarMetrics.fittedSize(
            ideal: ideal, visible: visible.size, floor: Self.minSize(for: state))
    }

    /// Per-state drag-resize floor. Pure for the harness.
    nonisolated static func minSize(for state: BarState) -> NSSize {
        state == .full ? TopBarMetrics.fullMin : TopBarMetrics.expandedMin
    }

    /// Re-clamp the live panel when its frame went bad between renders
    /// (drag lodged it, or a display change moved it). Uses the same clamp
    /// the panel itself enforces, so this can never fight constrainFrameRect.
    private func reclampIfLost() {
        guard let panel, panel.isVisible,
              let visible = (panel.screen ?? NSScreen.main)?.visibleFrame,
              Self.isFrameLost(frame: panel.frame, visible: visible)
        else { return }
        panel.setFrame(KeyablePanel.clamped(panel.frame, into: visible), display: true)
    }

    /// A frame is lost when it is off every screen OR its top edge is above
    /// the visible area (the grab/title region is unreachable — the exact
    /// clipped-after-update failure, dogfood 2026-08-18). Pure for the harness.
    nonisolated static func isFrameLost(frame: NSRect, visible: NSRect?) -> Bool {
        guard let visible else { return false }
        if !visible.intersects(frame) { return true }
        return frame.maxY > visible.maxY + 2
    }

    /// Pure for the harness: when may render() move/resize the panel? Only a
    /// state morph, a not-yet-shown panel, or a frame stranded off every
    /// screen — never a same-state re-render (that was the snap-back bug).
    nonisolated static func shouldSetFrame(
        renderedState: BarState?, state: BarState, panelVisible: Bool, frameLost: Bool
    ) -> Bool {
        renderedState != state || !panelVisible || frameLost
    }

    /// Whether this window is an ambient utility overlay (the pill) or a real
    /// app window (expanded/full). Utility overlays float above everything and
    /// join every Space; real windows live at normal level so Cmd+Tab, Spaces,
    /// and full-screen treat the app like an app. Pure for the harness.
    nonisolated static func isUtilityWindow(focusable: Bool) -> Bool { !focusable }

    /// Pure for the harness: expanded/full are resizable key-able windows
    /// (fixed sizes could not be shrunk — clipped-display reports 2026-08-05
    /// and 2026-08-15); only the pill stays non-focus-stealing and fixed.
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
            // the per-state floor (set in setFrame, which also screen-clamps
            // it) keeps fixed columns from clipping.
            panel.delegate = resizeRecorder
        }
        // The window CLASS decides Cmd+Tab, not just the activation policy
        // (dogfood 2026-08-18: the FULL view still wasn't switchable). A
        // floating utility panel with .canJoinAllSpaces is exactly what the
        // window server treats as an overlay — it never registers the app as
        // something Cmd+Tab can raise. Expanded/full are the app's real
        // windows, so they get ordinary managed-window semantics; only the
        // ambient pill stays a floating always-on-top utility.
        panel.isFloatingPanel = Self.isUtilityWindow(focusable: focusable)
        panel.level = Self.isUtilityWindow(focusable: focusable) ? .floating : .normal
        panel.hidesOnDeactivate = false
        // Managed windows are state-restorable by default; restoration fought
        // our own pinning after the 2026-08-18 window-class change and
        // reopened the window top-clipped above the menu bar. Our persisted
        // sizes are the only restoration we want.
        panel.isRestorable = false
        panel.becomesKeyOnlyIfNeeded = !focusable
        panel.collectionBehavior = Self.isUtilityWindow(focusable: focusable)
            ? [.canJoinAllSpaces, .fullScreenAuxiliary]
            : [.managed, .fullScreenPrimary]
        // Light v2: the panel is always a light surface — pin the effective
        // appearance so semantic colors resolve light even in system dark mode.
        // Appearance follows NSApp (system or the Preferences override) —
        // the light pin predates dark mode (2026-08-15).
        panel.appearance = nil
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        return panel
    }

    /// Keep the bar pinned top-center; animate the frame so expand/collapse morphs.
    private func setFrame(_ panel: NSPanel, size: NSSize) {
        guard let visible = (panel.screen ?? NSScreen.main)?.visibleFrame else { return }
        // The drag-resize floor must also respect the CURRENT screen: a
        // contentMinSize wider than the display would let AppKit's live
        // resize (and possibly programmatic frames) exceed the screen, which
        // is the exact clipping fittedSize exists to prevent.
        if panelIsFocusable {
            panel.contentMinSize = TopBarMetrics.fittedSize(
                ideal: Self.minSize(for: state), visible: visible.size)
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
    var onMoveOrResize: (() -> Void)?
    var onKeyChange: ((Bool) -> Void)?

    func windowDidBecomeKey(_ notification: Notification) { onKeyChange?(true) }
    func windowDidResignKey(_ notification: Notification) { onKeyChange?(false) }

    func windowDidEndLiveResize(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        onLiveResizeEnd?(window.frame.size)
        onMoveOrResize?()
    }

    func windowDidMove(_ notification: Notification) {
        onMoveOrResize?()
    }

    // Programmatic/content-driven resizes never hit windowDidEndLiveResize or
    // constrainFrameRect — this is the only hook that sees them (2026-08-19).
    func windowDidResize(_ notification: Notification) {
        onMoveOrResize?()
    }

    func windowDidChangeScreen(_ notification: Notification) {
        onMoveOrResize?()
    }
}
