import SwiftUI

/// Assistant in the main window (M4b): the thread, with Approvals,
/// Commitments and the Briefing as sub-sections beside it. "Approvals" is
/// the user-facing name of the proposals list (FD-1).
struct AssistantSection: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    private var segments: [BarSegment<AssistantPane>] {
        AssistantPane.allCases.map { pane in
            BarSegment(value: pane, title: pane.title, count: count(for: pane))
        }
    }

    private func count(for pane: AssistantPane) -> Int? {
        switch pane {
        case .approvals: model.pendingActions.count
        case .commitments: model.commitments?.count
        case .briefing: nil
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                SegmentedBar(
                    segments: segments, selection: model.mainNav.assistantPane,
                    label: NavSection.assistant.title,
                    onSelect: { model.showAssistantPane($0) })
                    .padding(.horizontal, Theme.s3)
                    .frame(height: NavRules.topBarHeight)
                Rectangle().fill(Theme.line).frame(height: 1)
                pane.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .frame(width: NavRules.listColumnWidth)
            Rectangle().fill(Theme.line).frame(width: 1)
            VStack(alignment: .leading, spacing: 0) {
                SectionHeader(title: NavSection.assistant.title)
                Rectangle().fill(Theme.line).frame(height: 1)
                AssistantThread(inlineWhenOffscreen: true)
                    .frame(maxWidth: 760, maxHeight: .infinity, alignment: .topLeading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    @ViewBuilder
    private var pane: some View {
        switch model.mainNav.assistantPane {
        case .approvals:
            ProposalsList(title: AssistantPane.approvals.title)
        case .commitments:
            CommitmentsList()
        case .briefing:
            if model.briefing != nil || model.briefingStructure != nil {
                // The card is a button elsewhere (it opens the full view);
                // here it is already the destination.
                OffscreenFriendlyScroll {
                    BriefingCard(briefing: model.briefing, structure: model.briefingStructure) {}
                        .allowsHitTesting(false)
                        .accessibilityRemoveTraits(.isButton)
                        .padding(Theme.s4)
                }
            } else {
                EmptyState(
                    icon: "sun.max", title: L("today.assistant.noBriefing"), style: .window)
                    .padding(.top, Theme.s12)
            }
        }
    }
}
