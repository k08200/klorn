import SwiftUI

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

/// The user's correction of who a sender IS — the strongest evidence a chip
/// can have. Address first; the whole domain as a submenu; clear when the
/// current label is already the user's own. The reader header's
/// SenderLabelCorrectionMenu hosts it.
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
