import SwiftUI

enum Theme {
    static let bg = Color(red: 0.043, green: 0.043, blue: 0.059)
    static let accent = Color.orange
    static let line = Color.white.opacity(0.08)

    /// The top bar is always a dark floating surface regardless of system
    /// appearance, so its text uses explicit light tones (not semantic colors).
    static let panel = Color.black.opacity(0.92)
    static let text = Color.white
    static let textDim = Color.white.opacity(0.55)

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
