import SwiftUI

enum Theme {
    static let bg = Color(red: 0.043, green: 0.043, blue: 0.059)
    static let accent = Color.orange
    static let line = Color.white.opacity(0.08)

    /// The top bar is always a dark floating surface regardless of system
    /// appearance, so its text uses explicit light tones (not semantic colors).
    static let panel = Color.black.opacity(panelDefaultOpacity)
    static let panelDefaultOpacity = 0.92

    /// Panel fill opacity: fully opaque when the user asked to reduce transparency
    /// (the 8% see-through can drop contrast over a busy backdrop), else the
    /// translucent default. Pure for testing.
    static func panelOpacity(reduceTransparency: Bool) -> Double {
        reduceTransparency ? 1.0 : panelDefaultOpacity
    }
    static let text = Color.white
    static let textDim = Color.white.opacity(0.55)

    /// Input-field boundary. `line` (white@0.08 ≈ 1.2:1) is fine for decorative
    /// dividers but fails WCAG 1.4.11 (≥3:1) for a control boundary; 0.40 ≈ 3:1
    /// on the dark panel. Use only where a control edge must be perceivable.
    static let field = Color.white.opacity(0.40)

    /// The web engagement graph's "you engage with this sender" pink — reused by
    /// the reading pane's learned-engagement chip so desktop matches the web signal.
    static let engage = Color(red: 0.96, green: 0.45, blue: 0.71)

    /// Per-tier accent: loud (red) for PUSH down to quiet (gray) for SILENT.
    static func tint(_ tier: Tier) -> Color {
        switch tier {
        case .push: .red
        case .queue: .orange
        case .silent: .gray
        case .auto: .blue
        }
    }

    // MARK: Surface ladder (design pass 2026-07-20)
    // One opacity scale for every interactive rest→hover→selected state, so
    // "how raised is this?" reads consistently across the app. Never invent
    // ad-hoc `Color.white.opacity(…)` fills in views — pick a rung.
    static let surfaceRaised = Color.white.opacity(0.05)   // cards, chips at rest
    static let surfaceHover = Color.white.opacity(0.09)    // pointer feedback
    static let surfaceSelected = Color.white.opacity(0.14) // the active row

    // MARK: Spacing (4pt grid)
    // s2/s3 within a control, s4 between controls, s6 between sections.
    static let s1: CGFloat = 4
    static let s2: CGFloat = 8
    static let s3: CGFloat = 12
    static let s4: CGFloat = 16
    static let s6: CGFloat = 24
}

/// Dim at rest, full text on hover — the standard treatment for every
/// secondary icon/text control (header buttons, row utilities). One modifier
/// so "quiet until you reach for it" is a property of the system, not a
/// per-view accident.
struct HoverDim: ViewModifier {
    @State private var hovering = false
    func body(content: Content) -> some View {
        content
            .foregroundStyle(hovering ? Theme.text : Theme.textDim)
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

extension View {
    func hoverDim() -> some View { modifier(HoverDim()) }
}

/// The standard quiet empty/guidance state: dim icon, one calm line, and an
/// optional hint. Every "nothing here" moment uses this instead of a bare
/// dim string, so emptiness reads as designed rather than unfinished.
struct EmptyState: View {
    let icon: String
    let title: String
    var hint: String? = nil

    var body: some View {
        VStack(spacing: Theme.s3) {
            Image(systemName: icon)
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(Theme.textDim.opacity(0.7))
                .accessibilityHidden(true)
            Text(title).font(.callout).foregroundStyle(Theme.textDim)
            if let hint {
                Text(hint).font(.caption).foregroundStyle(Theme.textDim.opacity(0.7))
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// Compact per-tier count chip for the queue header.
struct TierBadge: View {
    let tier: Tier
    let count: Int

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(Theme.tint(tier)).frame(width: 7, height: 7)
            Text(tier.label).font(.caption).foregroundStyle(.secondary)
            Text("\(count)").font(.caption.monospacedDigit().weight(.semibold))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.white.opacity(0.05), in: Capsule())
    }
}

/// One classified item in the decision queue.
struct FirewallRow: View {
    let item: FirewallItem

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(Theme.tint(item.tier)).frame(width: 8, height: 8).padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.email?.subject ?? item.title)
                    .font(.body.weight(.medium)).lineLimit(1)
                if let from = item.email?.from, !from.isEmpty {
                    Text(from).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                if let reason = item.tierReason, !reason.isEmpty {
                    Text(reason).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
            Spacer()
            if item.hashStale == true {
                Text("re-classifying").font(.caption2).foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 4)
        .listRowBackground(Color.clear)
    }
}
