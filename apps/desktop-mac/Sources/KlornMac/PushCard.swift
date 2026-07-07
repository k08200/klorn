import SwiftUI

/// The single-item interrupt card shown in the HUD panel. Deliberately compact:
/// a glance (who · subject · why it's PUSH) plus two actions. No inbox, no list —
/// the full queue lives on web/mobile. Reuses `Theme` tokens for visual parity.
struct PushCard: View {
    let item: FirewallItem
    /// How many more PUSH items are queued behind this one (0 = last).
    let remaining: Int
    let onOpen: () -> Void
    let onDismiss: () -> Void

    private var sender: String {
        let from = item.email?.from
        return (from?.isEmpty == false) ? from! : "Unknown sender"
    }
    private var subject: String {
        let s = item.email?.subject
        return (s?.isEmpty == false) ? s! : item.title
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle().fill(Theme.tint(.push)).frame(width: 7, height: 7)
                Text("PUSH")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Theme.tint(.push))
                Spacer()
                if remaining > 0 {
                    Text("+\(remaining) more")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Button(action: onDismiss) {
                    Image(systemName: "xmark").font(.caption2)
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .help("Dismiss")
            }

            Text(sender).font(.callout.weight(.semibold)).lineLimit(1)
            Text(subject).font(.subheadline).lineLimit(2)
            if let reason = item.tierReason, !reason.isEmpty {
                Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }

            HStack(spacing: 8) {
                Spacer()
                Button("Dismiss", action: onDismiss)
                    .buttonStyle(.bordered).controlSize(.small)
                Button("Open", action: onOpen)
                    .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
            }
            .padding(.top, 2)
        }
        .padding(14)
        .frame(width: 340, alignment: .leading)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.line))
    }
}
