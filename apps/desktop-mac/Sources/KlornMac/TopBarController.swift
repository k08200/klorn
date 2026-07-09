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
    /// an OS banner as a fallback for when the bar isn't on the user's current Space
    /// (a no-op on unbundled `swift run`, which has no bundle id).
    func handleNewPush(_ items: [FirewallItem]) {
        items.forEach { PushNotifier.post($0) }
    }

    /// Global-hotkey entry point: expand the pill / collapse whatever is open,
    /// creating the bar first if it isn't on screen yet. Never steals focus.
    func toggle() {
        guard panel != nil else { show(); setState(.expanded); return }
        setState(state == .collapsed ? .expanded : .collapsed)
    }

    private func setState(_ newState: BarState) {
        state = newState
        render()
    }

    private func render() {
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
            onCollapse: { [weak self] in self?.setState(.collapsed) },
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
