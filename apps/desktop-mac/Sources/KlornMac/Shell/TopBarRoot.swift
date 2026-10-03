import SwiftUI

/// The three sizes the bar can take: a glanceable pill, the compact 3-column
/// panel, and a full "real app" window.
enum BarState { case collapsed, expanded, full }

/// Actions the top bar delegates back to the controller / model.
struct TopBarActions {
    let onExpand: () -> Void        // collapsed → expanded
    let onExpandFull: () -> Void    // expanded → full
    let onRestore: () -> Void       // full → expanded
    let onCollapse: () -> Void      // → collapsed
    /// Close the open panel back to the resting state (pill, or nothing in
    /// hidden-pill mode) — the ✕ in the expanded/full headers.
    let onClose: () -> Void
    let onSignIn: () -> Void
    let onSignOut: () -> Void
    /// Open an item IN-APP: jump to the full view and show it in the reading pane.
    let onOpenInApp: (FirewallItem) -> Void
    /// Open a whole tier IN-APP: jump to the full view with that tier listed.
    let onOpenTier: (Tier) -> Void
    /// Jump to the full view without changing what it is showing.
    let onOpenFull: () -> Void
    /// Jump to the full view's proposals list — the actions awaiting approval.
    let onOpenProposals: () -> Void
    /// Dismiss (archive) an item out of the queue.
    let onDismiss: (FirewallItem) -> Void
    /// Snooze an item to resurface at the chosen time.
    let onSnooze: (FirewallItem, SnoozeOption) -> Void
    /// Tier correction — move an item to a different tier (teaches the judge).
    let onSetTier: (FirewallItem, Tier) -> Void
    /// Sender pin — "this sender is ALWAYS this lane" (a rule the judge obeys
    /// before any prediction, unlike corrections which only train a prior).
    let onPinSender: (FirewallItem, Tier) -> Void
    /// Remove the sender's pin; triage goes back to learned/predicted tiers.
    let onUnpinSender: (FirewallItem) -> Void
    /// Select a row in the full view — loads its email into the reading pane.
    let onSelect: (FirewallItem) -> Void
    /// Open the Settings window.
    let onOpenPreferences: () -> Void
    /// Hide the bar entirely (pill ✕) — the menu-bar icon takes over as anchor.
    let onHideBar: () -> Void
    let onQuit: () -> Void
}

enum TopBarMetrics {
    static let collapsed = NSSize(width: 400, height: 52)
    static let expanded = NSSize(width: 1140, height: 380)
    static let full = NSSize(width: 1400, height: 860)
    /// Smallest full window the user may drag-resize down to. 880 keeps the
    /// fixed sidebar (220) + list (420) columns with a readable ~240pt
    /// reading pane — the previous 1000×560 floor sat above many fitted
    /// window sizes, which made edge-drag feel dead ("can't shrink it",
    /// 2026-08-07). Floor for the panel's contentMinSize and screen fitting.
    static let fullMin = NSSize(width: 880, height: 520)
    /// Smallest expanded panel a drag-resize may reach. 720 keeps the tier
    /// columns readable; anything narrower belongs to the pill.
    static let expandedMin = NSSize(width: 720, height: 300)
    /// Gap kept to the screen edges when the ideal size doesn't fit.
    static let screenMargin: CGFloat = 12
    static let corner: CGFloat = 20

    /// The pill is a TRUE capsule (corner = height/2); panels soften to 20.
    static func corner(for state: BarState) -> CGFloat {
        state == .collapsed ? collapsed.height / 2 : corner
    }

    static func size(for state: BarState) -> NSSize {
        switch state {
        case .collapsed: collapsed
        case .expanded: expanded
        case .full: full
        }
    }

    /// `ideal` shrunk to fit inside `visible` (with a margin), lifted to
    /// `floor` when there is room. The SCREEN clamp wins over the floor: a
    /// window wider than the display is unreachable and clipped, which is
    /// strictly worse than temporarily cramped columns (the old floor-wins
    /// math re-introduced the 13"-clipping this function was added to fix).
    nonisolated static func fittedSize(
        ideal: NSSize, visible: NSSize, floor: NSSize = .zero
    ) -> NSSize {
        let maxW = max(visible.width - screenMargin * 2, 320)
        let maxH = max(visible.height - screenMargin * 2, 240)
        return NSSize(
            width: min(max(floor.width, min(ideal.width, maxW)), maxW),
            height: min(max(floor.height, min(ideal.height, maxH)), maxH))
    }

    /// Top-center placement clamped into the visible rect, so no state can
    /// put any part of the panel off-screen.
    nonisolated static func pinnedFrame(
        size: NSSize, visible: NSRect, topMargin: CGFloat
    ) -> NSRect {
        let x = min(
            max(visible.midX - size.width / 2, visible.minX),
            max(visible.maxX - size.width, visible.minX))
        let y = max(visible.maxY - size.height - topMargin, visible.minY)
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }
}

/// Root that switches between the three states. The controller animates the
/// window frame; this just renders the right content.
struct TopBarRoot: View {
    let state: BarState
    let actions: TopBarActions

    var body: some View {
        Group {
            switch state {
            case .collapsed: CollapsedBar(actions: actions)
            case .expanded: ExpandedPanel(actions: actions)
            case .full: FullView(actions: actions)
            }
        }
        .glassPanel(cornerRadius: TopBarMetrics.corner(for: state))
        // Root safety net: NSHostingView centers a root whose minimum exceeds
        // the window, which clips the app's own header row first. Pin to the
        // top so any overflow is always cut at the bottom instead.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
