import SwiftUI

/// The commitments column: WAITING ON (their promises to you) above I OWE
/// (your promises to them). ✓ marks done, ✕ dismisses — both optimistic.
/// One standard folder — Sent / Drafts / Archived. Live Gmail listing,
/// fetched on entry; rows share the mail list's grammar (sender label /
/// subject statement / snippet, time on the right) so the folders read as
/// the same product, not a bolted-on debug view.
/// Mail I sent that nobody answered (2026-09-18). Oldest wait first; a
/// row opens my own message through the live folder path so the thread
/// can be re-read before nudging. The floor (N days) comes from the server.
struct WaitingOnList: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "clock.arrow.circlepath").font(.body).foregroundStyle(Theme.textDim)
                    .accessibilityHidden(true)
                Text(L("waiting.title")).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                Text("\(model.waitingOn.count)").font(.title3.monospacedDigit())
                    .foregroundStyle(Theme.textDim)
                Spacer()
                Button {
                    Task { await model.loadWaitingOn() }
                } label: {
                    Image(systemName: "arrow.clockwise").font(.callout.weight(.medium))
                        .iconTarget(30)
                }
                .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                .help(L("mailbox.refresh"))
                .accessibilityLabel(L("mailbox.refresh"))
            }
            .padding(.horizontal, 24).padding(.top, 18).padding(.bottom, 6)
            Text(L("waiting.hint", model.waitingOnMinDays))
                .font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                .padding(.horizontal, 24).padding(.bottom, 12)

            Divider().overlay(Theme.line)

            if model.waitingOn.isEmpty {
                Spacer()
                EmptyState(icon: "checkmark.circle", title: L("waiting.empty"))
                Spacer()
            } else if Theme.isRenderingOffscreen {
                VStack(spacing: 0) {
                    ForEach(model.waitingOn.prefix(8)) { item in
                        WaitingOnRow(item: item)
                        Divider().overlay(Theme.line).padding(.leading, 20)
                    }
                }
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(model.waitingOn) { item in
                            WaitingOnRow(item: item)
                            Divider().overlay(Theme.line).padding(.leading, 20)
                        }
                    }
                }
            }
        }
    }
}

struct WaitingOnRow: View {
    @Environment(AppModel.self) private var model
    let item: WaitingOnItem
    @State private var hovering = false

    private var selected: Bool { model.selectedMailboxItem?.gmailId == item.gmailId }
    private var counterparty: String {
        let name = senderDisplayName(decodeHTMLEntities(item.to))
        return name.isEmpty ? item.to : name
    }

    var body: some View {
        Button { model.openWaitingOn(item) } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(counterparty).font(Theme.Typo.label)
                        .foregroundStyle(Theme.textDim).lineLimit(1)
                    Text(decodeHTMLEntities(item.subject.isEmpty
                        ? L("mailbox.noSubject") : item.subject))
                        .font(Theme.Typo.head)
                        .foregroundStyle(Theme.text).lineLimit(1)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(L("waiting.days", item.daysWaiting))
                        .font(Theme.Typo.micro)
                        .foregroundStyle(Theme.labelTint(.needsReply))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Theme.labelTint(.needsReply).opacity(0.13), in: Capsule())
                    let time = mailTimeLabel(iso: item.sentAt, now: Date())
                    if !time.isEmpty {
                        Text(time).font(Theme.Typo.caption.monospacedDigit())
                            .foregroundStyle(Theme.textDim)
                    }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 20).padding(.vertical, 10)
        .background(selected ? Theme.surfaceSelected : hovering ? Theme.surfaceHover : .clear)
        .onHover { hovering = $0 }
        .accessibilityLabel(L("waiting.row.a11y", counterparty, item.subject, item.daysWaiting))
    }
}
