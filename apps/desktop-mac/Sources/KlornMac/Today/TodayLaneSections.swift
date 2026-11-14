import SwiftUI

/// A lane other than PUSH on Today (MEETING, QUEUE's top rows, INFO as a
/// header only): a caps header with "See all", then compact rows. The lane
/// grouping is `TodayRules.lanes`; only the look changed (M1).
struct TodayLaneSection: View {
    @Environment(AppModel.self) private var model
    let lane: TodayLane
    let now: Date
    let open: (FirewallItem) -> Void

    private var note: String {
        switch lane.tier {
        case .meeting: L("today.lane.note.meeting")
        case .queue: L("today.lane.note.queue")
        default: L("today.lane.note.info")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                // No count (founder decision 2026-10-24): the headline counts
                // what is waiting; the lane opens in Mail.
                TodayCaps(text: "\(lane.tier.label) · \(note)")
                    .accessibilityLabel(lane.tier.label)
                Spacer(minLength: Theme.s2)
                Button { model.go(to: .tier(lane.tier)) } label: {
                    Text(L("today.seeAll")).font(Theme.Typo.label).foregroundStyle(Theme.todayInk2)
                        .frame(minHeight: TodayLayout.linkHeight)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(lane.tier.blurb)
            }
            if lane.style == .rows {
                ForEach(lane.rows, id: \.id) { item in
                    TodayCompactRow(item: item, now: now, open: { open(item) })
                    Rectangle().fill(Theme.todayLine).frame(height: Theme.hairline)
                }
            }
        }
    }
}

/// A caps-tracked 12pt line in t3: section heads and the schedule's title.
struct TodayCaps: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Theme.Typo.todayCaps).tracking(TodayTracking.caps)
            .textCase(.uppercase)
            .foregroundStyle(Theme.todayInk3)
            .lineLimit(1)
            .accessibilityAddTraits(.isHeader)
    }
}

/// One compact row: a face ringed in the account's color, the sender, the
/// subject, why it is in its lane as a quiet gray chip, and the time.
private struct TodayCompactRow: View {
    @Environment(AppModel.self) private var model
    let item: FirewallItem
    let now: Date
    let open: () -> Void
    @State private var hovering = false

    var body: some View {
        let content = WindowRowRules.content(
            for: item, mixedLanes: false, inboxes: model.inboxes, opened: model.openedEmailIds, now: now)
        Button(action: open) {
            HStack(spacing: Theme.s3) {
                TodayFace(
                    name: content.sender, key: item.email?.from ?? content.sender,
                    ring: AccountIdentity.color(of: item, among: model.inboxes),
                    diameter: TodayLayout.rowFace)
                Text(content.sender).font(Theme.Typo.rowSender).foregroundStyle(Theme.todayInk1)
                    .lineLimit(1)
                    .frame(width: TodayLayout.senderColumn, alignment: .leading)
                Text(content.subject).font(Theme.Typo.body).foregroundStyle(Theme.todayInk2)
                    .lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let reason = content.reason {
                    Text(reason).font(Theme.Typo.reasonChip).foregroundStyle(Theme.todayInk2)
                        .lineLimit(1)
                        .padding(.horizontal, Theme.s2)
                        .frame(height: TodayLayout.chipHeight)
                        .background(Theme.todayChip, in: RoundedRectangle(cornerRadius: Theme.Radius.chip))
                        .frame(maxWidth: TodayLayout.chipMaxWidth, alignment: .trailing)
                        .layoutPriority(1)
                }
                Text(content.time).font(Theme.Typo.meta.monospacedDigit()).foregroundStyle(Theme.todayInk3)
                    .lineLimit(1)
                    .frame(width: TodayLayout.timeColumn, alignment: .trailing)
            }
            .frame(minHeight: TodayLayout.rowHeight)
            .background(hovering ? Theme.todayChip : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(
            WindowRowRules.a11yLabel(
                content, lead: L("today.row.a11y", content.sender, content.subject)))
    }
}
