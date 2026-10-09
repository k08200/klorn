import SwiftUI

/// The lane on a main-window row or reader header: the one colored badge
/// (productization plan §1). 12pt on a 13% wash; the ink is `Theme.chipInk`,
/// measured at 4.5:1 or better on every surface the chip sits on.
struct WindowLaneChip: View {
    let tier: Tier

    var body: some View {
        Text(tier.label)
            .font(Theme.Typo.label)
            .foregroundStyle(Theme.chipInk(tier))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, Theme.s2)
            .frame(height: Self.height)
            .background(Theme.chipInk(tier).opacity(Theme.chipWashOpacity), in: Capsule())
            .accessibilityLabel(tier.label)
    }

    static let height: CGFloat = 18
}

/// What the reader header says about the open mail besides its lane: the
/// sender's category, the relationship, the reply state. Facts that used to
/// be colored chips on every row; here they are plain words.
enum ReaderMetaRules {
    /// The words, in reading order. Pure, so the self-check can pin them.
    static func parts(
        signal: RowSignal?, replyState: String?, draftReady: Bool
    ) -> [String] {
        var parts: [String] = []
        switch signal {
        case .category(let name): parts.append(L("chip.\(name)"))
        case .replied(let count): parts.append(L("chip.replied", count))
        case .first: parts.append(L("chip.first"))
        case nil: break
        }
        if let replyState,
           let kind = ReplyStateChip.kind(state: replyState, draftReady: draftReady)
        {
            switch kind {
            case .needsReply: parts.append(L("chip.needsReply"))
            case .draftReady: parts.append(L("chip.draftReady"))
            case .answered: parts.append(L("chip.answered"))
            }
        }
        return parts
    }
}

/// The reader header's meta line: the lane chip, then the neutral facts.
struct ReaderMetaLine: View {
    let item: FirewallItem

    var body: some View {
        let parts = ReaderMetaRules.parts(
            signal: item.email?.signal, replyState: item.email?.replyState,
            draftReady: item.email?.draftReady ?? false)
        HStack(spacing: Theme.s2) {
            WindowLaneChip(tier: item.tier)
            if !parts.isEmpty {
                Text(parts.joined(separator: " · "))
                    .font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
