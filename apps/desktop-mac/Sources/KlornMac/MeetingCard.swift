import AppKit
import SwiftUI

/// State for the one visible meeting-prep card.
@MainActor
@Observable
final class MeetingCardState {
    var event: CalendarEventWire?
    var pack: MeetingPrepPack?
}

struct MeetingCardActions {
    let onJoin: () -> Void
    let onDismiss: () -> Void
}

/// The pre-meeting interrupt: title · time · readiness + the prep checklist,
/// with Join as the one primary action. Mouse-only by design (nothing here is
/// send-like enough to deserve armed keys); appears in the same top-center
/// slot and morph as the PushCard.
struct MeetingCard: View {
    let state: MeetingCardState
    let actions: MeetingCardActions

    private var readinessColor: Color {
        switch state.pack?.readiness {
        case "ready": .green
        case "watch": .orange
        case "needs_review": .red
        default: .blue
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            Divider().overlay(Theme.line)
            checklist
            Spacer(minLength: 0)
            footer
        }
        .padding(14)
        .frame(width: PushCardMetrics.compact.width, height: PushCardMetrics.compact.height,
               alignment: .top)
        .glassPanel(cornerRadius: PushCardMetrics.corner)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("calendar.card.a11y"))
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "calendar.badge.clock")
                .font(.callout).foregroundStyle(Theme.accent).padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(state.event?.title ?? "")
                    .font(.callout.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(1)
                if let event = state.event {
                    Text([
                        eventTimeLabel(startISO: event.startTime, endISO: event.endTime,
                                       allDay: event.allDay),
                        event.location ?? "",
                    ].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(Theme.textDim).lineLimit(1)
                }
            }
            Spacer()
            if let pack = state.pack {
                Text(readinessLabel(pack.readiness))
                    .font(.caption2.weight(.semibold)).foregroundStyle(readinessColor)
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(readinessColor.opacity(0.15), in: Capsule())
            }
            Button(action: actions.onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold)).foregroundStyle(Theme.textDim)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L("calendar.dismiss.a11y"))
        }
    }

    @ViewBuilder
    private var checklist: some View {
        if let pack = state.pack, !pack.checklist.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(pack.checklist.prefix(4), id: \.self) { line in
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "checkmark.circle")
                            .font(.caption).foregroundStyle(Theme.textDim).padding(.top, 1)
                            .accessibilityHidden(true)
                        Text(line).font(.caption).foregroundStyle(Theme.text)
                            .lineLimit(2).multilineTextAlignment(.leading)
                    }
                }
            }
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(L("calendar.prepPack")).font(.caption).foregroundStyle(Theme.textDim)
            }
            .frame(maxWidth: .infinity, minHeight: 120)
        }
    }

    private var footer: some View {
        HStack {
            Text(L("calendar.startingSoon")).font(.caption2).foregroundStyle(Theme.textDim)
            Spacer()
            if MeetingLink.safeURL(state.event?.meetingLink) != nil {
                Button(L("calendar.join"), action: actions.onJoin)
                    .buttonStyle(PrimaryButtonStyle())
            }
        }
    }
}
