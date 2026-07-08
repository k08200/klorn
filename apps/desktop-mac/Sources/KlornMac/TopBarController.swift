import AppKit
import SwiftUI

/// Owns the always-on top bar: a single non-focus-stealing panel pinned to the
/// top-center of the screen. Collapsed it's a slim pill; `☰` expands it (the
/// window frame animates) into the full panel, `— Close` collapses it back.
/// Surfacing must never pull the user out of their app — hence `.nonactivatingPanel`,
/// `.floating`, `hidesOnDeactivate = false`, and `orderFrontRegardless()`.
@MainActor
final class TopBarController {
    private let model: AppModel
    private var panel: NSPanel?
    private var expanded = false
    private static let topMargin: CGFloat = 8

    init(model: AppModel) {
        self.model = model
    }

    /// Show the bar (collapsed) at launch and keep it present for the session.
    func show() {
        guard NSScreen.main != nil else { return }  // headless: nothing to draw
        expanded = false
        render()
        panel?.orderFrontRegardless()  // visible WITHOUT activating or taking focus
    }

    /// New PUSH arrived: the live count already updates via observation; also post
    /// an OS banner as a fallback for when the bar isn't on the user's current Space
    /// (a no-op on unbundled `swift run`, which has no bundle id).
    func handleNewPush(_ items: [FirewallItem]) {
        items.forEach { PushNotifier.post($0) }
    }

    /// Global-hotkey entry point: expand if collapsed / collapse if expanded,
    /// creating the bar first if it isn't on screen yet. Never steals focus.
    func toggle() {
        guard panel != nil else { show(); setExpanded(true); panel?.orderFrontRegardless(); return }
        setExpanded(!expanded)
        panel?.orderFrontRegardless()
    }

    private func setExpanded(_ value: Bool) {
        expanded = value
        render()
    }

    private func render() {
        let size = expanded ? TopBarMetrics.expanded : TopBarMetrics.collapsed
        let root = TopBarRoot(expanded: expanded, actions: makeActions())
            .environment(model)
        let panel = self.panel ?? makePanel()
        panel.contentView = NSHostingView(rootView: root)
        self.panel = panel
        setFrame(panel, size: size)
    }

    private func makeActions() -> TopBarActions {
        TopBarActions(
            onExpand: { [weak self] in self?.setExpanded(true) },
            onCollapse: { [weak self] in self?.setExpanded(false) },
            onSignIn: { [weak self] in guard let self else { return }; Task { await self.model.signIn() } },
            onSignOut: { [weak self] in self?.model.signOut() },
            onOpenWeb: { [weak self] item in self?.open(item) },
            onDismiss: { [weak self] item in guard let self else { return }; Task { await self.model.dismiss(item) } },
            onSnooze: { [weak self] item in guard let self else { return }; Task { await self.model.snooze(item) } },
            onQuit: { NSApplication.shared.terminate(nil) })
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: TopBarMetrics.collapsed),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
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
        panel.setFrame(NSRect(origin: origin, size: size), display: true, animate: true)
    }

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
