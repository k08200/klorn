import AppKit
import SwiftUI

/// Owns the ambient interrupt surface: a non-focus-stealing floating panel that
/// shows one PUSH card at a time in the top-right corner. The whole point is that
/// surfacing a PUSH must never pull the user out of the app they're working in —
/// hence `.nonactivatingPanel`, `.floating`, `hidesOnDeactivate = false`, and
/// `orderFrontRegardless()` (never `makeKeyAndOrderFront`).
@MainActor
final class HudController {
    private var panel: NSPanel?
    private var pending: [FirewallItem] = []

    private static let cardWidth: CGFloat = 340
    private static let margin: CGFloat = 12

    /// Enqueue newly-arrived PUSH items. If nothing is on screen, show the first.
    func present(_ items: [FirewallItem]) {
        guard !items.isEmpty else { return }
        // No screen to draw on (e.g. headless) → fall back to an OS banner so a
        // PUSH is never silently dropped.
        guard NSScreen.main != nil else {
            items.forEach { PushNotifier.post($0) }
            return
        }
        pending.append(contentsOf: items)
        if panel == nil { showNext() }
    }

    private func showNext() {
        guard let item = pending.first else { close(); return }
        let card = PushCard(
            item: item,
            remaining: pending.count - 1,
            onOpen: { [weak self] in self?.open(item); self?.advance() },
            onDismiss: { [weak self] in self?.advance() })

        let hosting = NSHostingView(rootView: card)
        hosting.setFrameSize(hosting.fittingSize)

        let panel = self.panel ?? makePanel()
        panel.setContentSize(hosting.fittingSize)
        panel.contentView = hosting
        self.panel = panel
        position(panel)
        panel.orderFrontRegardless()  // show WITHOUT activating or taking focus
    }

    private func advance() {
        if !pending.isEmpty { pending.removeFirst() }
        if pending.isEmpty { close() } else { showNext() }
    }

    private func close() {
        panel?.orderOut(nil)
        panel = nil
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.cardWidth, height: 140),
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

    private func position(_ panel: NSPanel) {
        guard let visible = NSScreen.main?.visibleFrame else { return }
        let size = panel.frame.size
        panel.setFrameOrigin(NSPoint(
            x: visible.maxX - size.width - Self.margin,
            y: visible.maxY - size.height - Self.margin))
    }

    private func open(_ item: FirewallItem) {
        guard let url = Self.resolveURL(item) else {
            Log.app.debug("HUD open: no resolvable URL for \(item.id, privacy: .public)")
            return
        }
        NSWorkspace.shared.open(url)
    }

    /// Prefer an absolute item link; otherwise join a relative href onto the web
    /// base, and fall back to the inbox root when there's no usable href.
    nonisolated static func resolveURL(_ item: FirewallItem) -> URL? {
        if let href = item.href, let url = URL(string: href),
           let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
            return url
        }
        let base = Config.webBaseURL
        if let href = item.href, !href.isEmpty {
            let joined = href.hasPrefix("/") ? base + href : base + "/" + href
            return URL(string: joined)
        }
        return URL(string: base)
    }
}
