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
        var parts: [String] = signalWord(signal).map { [$0] } ?? []
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

    /// The sender's category or relationship as a word, nil when the row
    /// has no evidence yet.
    static func signalWord(_ signal: RowSignal?) -> String? {
        switch signal {
        case .category(let name): L("chip.\(name)")
        case .replied(let count): L("chip.replied", count)
        case .first: L("chip.first")
        case nil: nil
        }
    }
}

/// The reader header's meta line: the lane chip, the account the mail is on
/// (when there is more than one to tell apart), the neutral facts, then the
/// sender-label correction menu.
struct ReaderMetaLine: View {
    @Environment(AppModel.self) private var model
    let item: FirewallItem

    var body: some View {
        let parts = ReaderMetaRules.parts(
            signal: item.email?.signal, replyState: item.email?.replyState,
            draftReady: item.email?.draftReady ?? false)
        let source = WindowRowRules.showsAccounts(model.inboxes) ? item.email?.source : nil
        HStack(spacing: Theme.s2) {
            facts(parts: parts, source: source)
            SenderLabelCorrectionMenu(
                from: item.email?.from, signalWord: ReaderMetaRules.signalWord(item.email?.signal),
                byUser: item.email?.signalByUser ?? false)
        }
    }

    /// Read as one element; the correction menu stays its own control.
    private func facts(parts: [String], source: MailSource?) -> some View {
        HStack(spacing: Theme.s2) {
            WindowLaneChip(tier: item.tier)
            if let source {
                HStack(spacing: Theme.s1) {
                    SourceBadge(provider: source.provider, compact: true)
                    Text(source.label)
                        .font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                        .lineLimit(1).truncationMode(.middle)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(
                    sourceA11yLabel(provider: source.provider, label: source.label))
            }
            if !parts.isEmpty {
                Text(parts.joined(separator: " · "))
                    .font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The reader's sender-label correction (corrections become rules): who
/// this sender IS, for this address or the whole domain, and "clear" when
/// the current label is the user's own. The menu items are the ones the
/// row chips used to carry. Nothing when no address can be read from From.
struct SenderLabelCorrectionMenu: View {
    let from: String?
    /// The current category or relationship word, for the spoken label.
    let signalWord: String?
    let byUser: Bool

    var body: some View {
        if let address = mailAddress(in: from) {
            let title = Text(L("label.correct")) + Text(verbatim: " ")
                + Text(Image(systemName: "chevron.down"))
            if Theme.isRenderingOffscreen {
                title.font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
            } else {
                Menu {
                    SenderLabelMenuItems(address: address, byUser: byUser)
                } label: {
                    title.font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help(L("label.correct"))
                .accessibilityLabel(
                    signalWord.map { L("label.correct.a11y", $0) } ?? L("label.correct"))
            }
        }
    }
}
