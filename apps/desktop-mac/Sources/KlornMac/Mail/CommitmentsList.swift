import SwiftUI

struct CommitmentsList: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let groups = commitmentGroups(model.commitments ?? [])
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "checklist").font(.body).foregroundStyle(Theme.accent)
                    .accessibilityHidden(true)
                Text(L("section.commitments")).font(Theme.Typo.display).foregroundStyle(Theme.text)
                Text("\(model.commitments?.count ?? 0)")
                    .font(.title3.monospacedDigit()).foregroundStyle(Theme.textDim)
            }
            .padding(.horizontal, 24).padding(.vertical, 18)
            Divider().overlay(Theme.line)

            if model.commitments == nil {
                Spacer()
                if model.commitmentsFailed {
                    Text(L("commitments.loadFailed"))
                        .font(.callout).foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity).multilineTextAlignment(.center)
                } else {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                }
                Spacer()
            } else if groups.waitingOn.isEmpty && groups.iOwe.isEmpty {
                Spacer()
                Text(L("commitments.empty")).font(.title3).foregroundStyle(Theme.textDim)
                    .frame(maxWidth: .infinity)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if !groups.waitingOn.isEmpty {
                            ColumnHeader(title: L("section.waitingOn"))
                                .padding(.horizontal, 24).padding(.top, 14).padding(.bottom, 4)
                            ForEach(groups.waitingOn) { CommitmentRow(item: $0) }
                        }
                        if !groups.iOwe.isEmpty {
                            ColumnHeader(title: L("section.iOwe"))
                                .padding(.horizontal, 24).padding(.top, 14).padding(.bottom, 4)
                            ForEach(groups.iOwe) { CommitmentRow(item: $0) }
                        }
                    }
                    .padding(.bottom, 14)
                }
            }
        }
    }
}

private struct CommitmentRow: View {
    @Environment(AppModel.self) private var model
    let item: CommitmentItem
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(decodeHTMLEntities(item.title))
                    .font(.callout).foregroundStyle(Theme.text).lineLimit(2)
                HStack(spacing: 6) {
                    if let who = item.counterpartyLabel {
                        Text(who).font(.caption).foregroundStyle(Theme.textDim).lineLimit(1)
                    }
                    if let due = item.dueText, !due.isEmpty {
                        Text(due).font(.caption).foregroundStyle(Theme.accent)
                    }
                }
            }
            Spacer(minLength: 0)
            // Same hover-reveal language as the mail rows: quiet at rest.
            Button {
                Task { await model.resolveCommitment(item, as: "DONE") }
            } label: { Image(systemName: "checkmark").iconTarget() }
                .buttonStyle(.plain).foregroundStyle(Theme.textDim).help(L("commitments.markDone"))
                .accessibilityLabel(L("commitments.markDone.a11y", item.title))
                .opacity(hovering ? 1 : 0)
            Button {
                Task { await model.resolveCommitment(item, as: "DISMISSED") }
            } label: { Image(systemName: "xmark").iconTarget() }
                .buttonStyle(.plain).foregroundStyle(Theme.textDim).help(L("mail.dismiss"))
                .accessibilityLabel(L("commitments.dismiss.a11y", item.title))
                .opacity(hovering ? 1 : 0)
        }
        .padding(.horizontal, 24).padding(.vertical, 8)
        .background(hovering ? Theme.surfaceHover : .clear)
        .onHover { hovering = $0 }
    }
}
