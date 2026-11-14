import SwiftUI

/// Header shared by Today's side panels: a title and one quiet link.
struct PanelHeader: View {
    let title: String
    let linkTitle: String
    let action: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(Theme.Typo.head).foregroundStyle(Theme.text)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: Theme.s2)
            Button(linkTitle, action: action)
                .buttonStyle(.plain).font(Theme.Typo.label).hoverDim()
        }
    }
}

/// "Today's schedule": what is on now and the rest of the day, side by
/// side, each with a 3pt bar in its calendar's color (Klorn's own calendar
/// in the accent, a linked one in gray, named under the title). Read from
/// the existing today summary.
struct TodaySchedule: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            TodayCaps(text: L("today.schedule"))
            if model.today == nil {
                Text(L("bar.loading")).font(Theme.Typo.body).foregroundStyle(Theme.todayInk2)
            } else {
                let events = TodayRules.events(model.today)
                if events.isEmpty {
                    Text(L("today.calendar.empty")).font(Theme.Typo.body).foregroundStyle(Theme.todayInk2)
                } else {
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: TodayLayout.eventMinWidth), spacing: Theme.s6,
                                           alignment: .leading)],
                        alignment: .leading, spacing: Theme.s3
                    ) {
                        ForEach(events, id: \.event.id) { entry in
                            TodayEventEntry(event: entry.event, isNow: entry.isNow)
                        }
                    }
                }
            }
        }
    }
}

/// One event: the bar, the title, the time range (or "Now"), and the
/// source by name when it is a linked calendar (the bar's color is never
/// the only signal). Joins the meeting when it has a safe link.
private struct TodayEventEntry: View {
    let event: CalendarEventWire
    let isNow: Bool

    private var time: String {
        let range = eventTimeLabel(startISO: event.startTime, endISO: event.endTime, allDay: event.allDay)
        return isNow ? "\(L("section.now")) · \(range)" : range
    }

    var body: some View {
        let source = calendarEventSourceLabel(event)
        let entry = HStack(alignment: .top, spacing: Theme.s2) {
            Capsule()
                .fill(source == nil ? Theme.accent : Theme.todayInk3)
                .frame(width: TodayLayout.eventBar)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: Theme.s1) {
                    Text(event.title).font(Theme.Typo.rowSender).foregroundStyle(Theme.todayInk1)
                        .lineLimit(1)
                    if MeetingLink.safeURL(event.meetingLink) != nil {
                        Image(systemName: "video").font(Theme.Typo.icon).foregroundStyle(Theme.todayInk3)
                            .accessibilityHidden(true)
                    }
                }
                Text(time).font(Theme.Typo.meta.monospacedDigit()).foregroundStyle(Theme.todayInk2)
                    .lineLimit(1)
                if let source {
                    Text(source).font(Theme.Typo.caption).foregroundStyle(Theme.todayInk3)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        if let url = MeetingLink.safeURL(event.meetingLink) {
            Button { NSWorkspace.shared.open(url) } label: { entry.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityLabel(L("calendar.join.a11y", event.title))
        } else {
            entry.accessibilityElement(children: .combine)
        }
    }
}

/// The P12 blocks, each only with its server flag (and, for free time, a
/// saved team), below the schedule. They were rail cards; the rail is gone
/// (M1), the features stay.
struct TodayExtras: View {
    @Environment(AppModel.self) private var model
    let now: Date

    var body: some View {
        let freeTime = FreeTimeRules.visible(teamMode: model.clientFlags.teamMode, teamCount: model.teams.count)
        if freeTime || model.clientFlags.files {
            HStack(alignment: .top, spacing: Theme.s3) {
                if freeTime {
                    TodayFreeTimePanel(renderNow: Theme.isRenderingOffscreen ? now : nil)
                }
                if model.clientFlags.files { TodayRecentFilesPanel() }
            }
        }
    }
}
