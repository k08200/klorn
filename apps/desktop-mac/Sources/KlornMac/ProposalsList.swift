import SwiftUI

/// The actions Klorn is waiting on approval for, with Approve / Decline.
///
/// This is the surface that closes the last non-login reason to leave the app:
/// the agent's daily receipt could show that N actions were pending, but the
/// only place to act on them was the web inbox.
///
/// Deliberately plain — an approval screen is not somewhere to be clever. Each
/// row states the action, what it targets, and why Klorn proposed it, and the
/// two buttons are equally weighted: nudging someone toward Approve is exactly
/// the wrong instinct on a screen whose whole job is informed consent.
struct ProposalsList: View {
    @Environment(AppModel.self) private var model
    /// The main window calls this list "Approvals" (FD-1); the bar's full
    /// view keeps its own title until it is retired (M8).
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
                // Same visual weight both ways: this screen exists so the user
                // decides, not so Klorn gets a yes.
                Button(L("proposals.approve"), action: onApprove)
                    .buttonStyle(.bordered).controlSize(.regular)
                Button(L("proposals.decline"), action: onDecline)
                    .buttonStyle(.bordered).controlSize(.regular)
                Spacer()
            }
            .disabled(busy)
            .padding(.top, 2)
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
