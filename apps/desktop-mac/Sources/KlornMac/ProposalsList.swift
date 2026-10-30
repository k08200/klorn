import SwiftUI

/// The actions Klorn is waiting on approval for, with Approve / Decline.
///
/// This is the surface that closes the last non-login reason to leave the app:
/// the agent's daily receipt could show that N actions were pending, but the
/// only place to act on them was the web inbox.
///
/// Deliberately plain — an approval screen is not somewhere to be clever. Each
/// row states the action, what it targets, and why Klorn proposed it. Approve
/// is the primary button, Decline the secondary, and a 12pt line under them
/// says what Approve does (sends now / runs now), matching the web
/// (audit M4): the weight follows the decision, the consequence is in words.
struct ProposalsList: View {
    @Environment(AppModel.self) private var model
    /// The Assistant section calls this list "Approvals" (FD-1); the list
    /// mode switch in FullList keeps the default title.
    var title = L("proposals.title")

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                Text("\(model.pendingActions.count)")
                    .font(.title3.monospacedDigit()).foregroundStyle(Theme.textDim)
                Spacer()
            }
            .padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 10)

            if let error = model.pendingActionError {
                Text(error).font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 20).padding(.bottom, 8)
                if PlanUpgrade.offersUpgrade(for: error) {
                    UpgradeToProLink().padding(.horizontal, 20).padding(.bottom, 8)
                }
            }

            if model.pendingActions.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L("proposals.empty")).font(.title3).foregroundStyle(Theme.textDim)
                    Text(L("proposals.empty.detail"))
                        .font(.caption).foregroundStyle(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 20).padding(.top, Theme.s4)
                Spacer()
            } else {
                OffscreenFriendlyScroll {
                    VStack(alignment: .leading, spacing: Theme.s2) {
                        ForEach(model.pendingActions) { action in
                            ProposalRow(
                                action: action,
                                busy: model.resolvingActions.contains(action.id),
                                onApprove: { model.resolvePendingAction(action, approve: true) },
                                onDecline: { model.resolvePendingAction(action, approve: false) })
                        }
                    }
                    .padding(.horizontal, 14).padding(.bottom, 14)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct ProposalRow: View {
    let action: PendingActionsResponse.Action
    let busy: Bool
    let onApprove: () -> Void
    let onDecline: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(action.title).font(.body.weight(.semibold)).foregroundStyle(Theme.text)

            if let target = action.targetLabel, !target.isEmpty {
                Text(target).font(.callout).foregroundStyle(Theme.text.opacity(0.8))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let reasoning = action.reasoning, !reasoning.isEmpty {
                Text(reasoning).font(.caption).foregroundStyle(Theme.textDim)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: Theme.s2) {
                Button(action: onApprove) {
                    Text(ProposalRules.approveTitle(action)).fontWeight(.semibold)
                        .foregroundStyle(Theme.onAccentSolid)
                }
                .buttonStyle(.borderedProminent).tint(Theme.accentSolid).controlSize(.regular)
                Button(L("proposals.decline"), action: onDecline)
                    .buttonStyle(.bordered).controlSize(.regular)
                Spacer()
            }
            .disabled(busy)
            .padding(.top, 2)
            Text(ProposalRules.consequence(action))
                .font(.system(size: ProposalRules.captionSize))
                .foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Theme.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line))
        .opacity(busy ? 0.6 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("proposals.row.a11y", action.title, action.targetLabel ?? ""))
    }
}

/// The approval row's words, pure for the self-check.
enum ProposalRules {
    static let captionSize: CGFloat = 12

    static func approveTitle(_ action: PendingActionsResponse.Action) -> String {
        action.sendsMail ? L("proposals.approveSend") : L("proposals.approve")
    }

    static func consequence(_ action: PendingActionsResponse.Action) -> String {
        action.sendsMail ? L("proposals.sendsNow") : L("proposals.runsNow")
    }
}
