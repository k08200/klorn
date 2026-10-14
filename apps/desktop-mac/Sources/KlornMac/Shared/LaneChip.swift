import SwiftUI

/// The lane as a label (mail-first shell): tinted micro-pill. This is where
/// the classification now lives on the default view — on the row, not in the
/// navigation.
struct LaneChip: View {
    let tier: Tier
    /// `.window`: the main window's chip (12pt, the AA chip ink). `.bar`
    /// is the bar's chip, unchanged.
    var style: ShellStyle = .bar

    var body: some View {
        switch style {
        case .bar:
            Text(tier.label)
                .font(Theme.Typo.micro)
                .foregroundStyle(Theme.tint(tier))
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Theme.tint(tier).opacity(0.13), in: Capsule())
                .accessibilityLabel(tier.label)
        case .window:
            WindowLaneChip(tier: tier)
        }
    }
}

/// The row's one relationship/category chip. Renders nothing for nil —
/// a missing fact must never become a label.
struct SignalChip: View {
    @Environment(AppModel.self) private var model
    let signal: RowSignal?
    /// The row's From header — the chip is also the correction menu ("this
    /// sender is a customer") when an address can be read from it.
    var from: String? = nil
    /// The chip is the user's own correction → the menu offers "clear".
    var byUser = false

    private var text: String? {
        switch signal {
        case .category(let c): L("chip.\(c)")
        case .replied(let n): L("chip.replied", n)
        case .first: L("chip.first")
        case nil: nil
        }
    }

    var body: some View {
        if let text, let signal {
            let tint = Theme.signalTint(signal)
            let label = Text(text)
                .font(Theme.Typo.micro)
                .foregroundStyle(tint)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(tint.opacity(0.13), in: Capsule())
            if let address = mailAddress(in: from), !Theme.isRenderingOffscreen {
                Menu {
                    correctionItems(address: address)
                } label: {
                    label
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .accessibilityLabel(L("label.correct.a11y", text))
            } else {
                label.accessibilityLabel(text)
            }
        }
    }

    private func correctionItems(address: String) -> some View {
        SenderLabelMenuItems(address: address, byUser: byUser)
    }
}

/// The reply axis on a row (2026-09-14): "답장 필요" when the analysis judged
/// a reply is owed and none went out through Klorn; "답장함" once the user
/// answered through Klorn. Sits beside the relationship chip — a different
/// axis, the one Spark / Superhuman / Inbox Zero all label first.
struct ReplyStateChip: View {
    let state: String?
    /// A reply is already drafted (proactive drafts): the owed chip says so
    /// instead — one chip, the more useful fact.
    var draftReady: Bool = false

    var body: some View {
        if let state, let kind = Self.kind(state: state, draftReady: draftReady) {
            let text = Self.label(kind)
            let tint: Color = state == "needsReply" ? Theme.labelTint(.needsReply) : Theme.textDim
            Text(text)
                .font(Theme.Typo.micro)
                .foregroundStyle(tint)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(tint.opacity(0.13), in: Capsule())
                .accessibilityLabel(text)
        }
    }

    enum Kind: Equatable { case needsReply, draftReady, answered }

    /// What the chip says. Static and pure so --self-check can pin it.
    nonisolated static func kind(state: String, draftReady: Bool) -> Kind? {
        switch state {
        case "needsReply": draftReady ? .draftReady : .needsReply
        case "replied": .answered
        default: nil
        }
    }

    private static func label(_ kind: Kind) -> String {
        switch kind {
        case .needsReply: L("chip.needsReply")
        case .draftReady: L("chip.draftReady")
        // chip.replied is the "replied N×" relationship chip's key — this
        // axis has its own word.
        case .answered: L("chip.answered")
        }
    }
}

/// A row with no chip has no evidence yet — still a sender the user may know.
/// Shown on hover / focus only (a resting placeholder on every row would be
/// noise); opens the same correction menu as the chip.
struct AddLabelChip: View {
    let address: String

    var body: some View {
        if Theme.isRenderingOffscreen {
            EmptyView()
        } else {
            Menu {
                SenderLabelMenuItems(address: address, byUser: false)
            } label: {
                Text(L("label.add"))
                    .font(Theme.Typo.micro)
                    .foregroundStyle(Theme.textDim)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .overlay(Capsule().strokeBorder(Theme.line))
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .accessibilityLabel(L("label.add"))
        }
    }
}

/// The user's correction of who a sender IS — the strongest evidence a chip
/// can have. Address first; the whole domain as a submenu; clear when the
/// current chip is already the user's own. Shared by the signal chip and the
/// add-label placeholder on rows that have no chip at all.
struct SenderLabelMenuItems: View {
    @Environment(AppModel.self) private var model
    let address: String
    let byUser: Bool

    var body: some View {
        Section(L("label.correct")) {
            ForEach(userLabelCategories, id: \.self) { category in
                Button(L("chip.\(category)")) {
                    Task { await model.setSenderLabel(scope: "sender", value: address, category: category) }
                }
            }
        }
        if let domain = mailDomain(of: address) {
            Menu(L("label.correct.domain", domain)) {
                ForEach(userLabelCategories, id: \.self) { category in
                    Button(L("chip.\(category)")) {
                        Task { await model.setSenderLabel(scope: "domain", value: domain, category: category) }
                    }
                }
            }
        }
        if byUser {
            Divider()
            Button(L("label.correct.clear")) {
                Task { await model.clearSenderLabel(scope: "sender", value: address) }
            }
            if let domain = mailDomain(of: address) {
                Button(L("label.correct.clearDomain")) {
                    Task { await model.clearSenderLabel(scope: "domain", value: domain) }
                }
            }
        }
    }
}
