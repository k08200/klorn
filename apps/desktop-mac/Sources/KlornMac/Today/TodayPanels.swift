import SwiftUI

/// Header shared by Today's side panels: a title and one quiet link.
private struct PanelHeader: View {
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

/// Today's calendar, merged across the calendars Klorn reads: what is on
/// now, then what is left of the day. Read from the existing today summary.
struct TodayCalendarPanel: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            PanelHeader(title: NavSection.calendar.title, linkTitle: L("today.open")) {
                model.navigate(to: .calendar)
            }
            if model.today == nil {
                Text(L("bar.loading")).font(Theme.Typo.body).foregroundStyle(Theme.textDim)
            } else {
                let events = TodayRules.events(model.today)
                if events.isEmpty {
                    Text(L("today.calendar.empty"))
                        .font(Theme.Typo.body).foregroundStyle(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    VStack(alignment: .leading, spacing: Theme.s2) {
                        ForEach(events, id: \.event.id) { entry in
                            TodayEventRow(event: entry.event, isNow: entry.isNow)
                        }
                    }
                }
            }
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .todayPanel()
    }
}

/// One event: a 3pt source bar, the time, the title, and the source by name
/// when it is a linked calendar (the bar's color is never the only signal).
private struct TodayEventRow: View {
    let event: CalendarEventWire
    let isNow: Bool

    private var time: String {
        if event.allDay { return L("calendar.allDay") }
        return String(
            eventTimeLabel(startISO: event.startTime, endISO: event.endTime, allDay: false).prefix(5))
    }

    var body: some View {
        let source = calendarEventSourceLabel(event)
        let row = HStack(alignment: .top, spacing: Theme.s2) {
            Capsule()
                .fill(source == nil ? Theme.accent : Theme.textDim)
                .frame(width: 3)
                .accessibilityHidden(true)
            Text(isNow ? L("section.now") : time)
                .font(Theme.Typo.caption.monospacedDigit().weight(isNow ? .semibold : .regular))
                .foregroundStyle(isNow ? Theme.text : Theme.textDim)
                .frame(width: 44, alignment: .leading)
                .padding(.top, Theme.hairline)
            VStack(alignment: .leading, spacing: 1) {
                Text(event.title).font(Theme.Typo.body).foregroundStyle(Theme.text).lineLimit(1)
                if let source {
                    Text(source).font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 0)
            if MeetingLink.safeURL(event.meetingLink) != nil {
                Image(systemName: "video").font(Theme.Typo.icon).foregroundStyle(Theme.textDim)
                    .accessibilityHidden(true)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        if let url = MeetingLink.safeURL(event.meetingLink) {
            Button { NSWorkspace.shared.open(url) } label: { row.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityLabel(L("calendar.join.a11y", event.title))
        } else {
            row.accessibilityElement(children: .combine)
        }
    }
}

/// The assistant strip: the briefing's one line, what waits on the user,
/// and a way into the thread.
struct TodayAssistantPanel: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let approvals = model.pendingActions.count
        VStack(alignment: .leading, spacing: Theme.s3) {
            PanelHeader(title: NavSection.assistant.title, linkTitle: L("today.open")) {
                model.navigate(to: .assistant)
            }
            if let line = TodayRules.briefingLine(
                structure: model.briefingStructure, briefing: model.briefing)
            {
                Text(line).font(Theme.Typo.body).foregroundStyle(Theme.text)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel(L("briefing.a11y", line))
            } else {
                Text(L("today.assistant.noBriefing"))
                    .font(Theme.Typo.body).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Rectangle().fill(Theme.line).frame(height: Theme.hairline)
            if approvals > 0 {
                Button { model.showAssistantPane(.approvals) } label: {
                    HStack(spacing: Theme.s2) {
                        Text(L("today.approvals.waiting", approvals))
                            .font(Theme.Typo.label).foregroundStyle(Theme.text)
                        Spacer(minLength: Theme.s2)
                        Image(systemName: "chevron.right").font(Theme.Typo.caption)
                            .foregroundStyle(Theme.textDim).accessibilityHidden(true)
                    }
                    .frame(minHeight: 24)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                Text(L("today.approvals.none"))
                    .font(Theme.Typo.label).foregroundStyle(Theme.textDim)
            }
            // The ask box opens the thread; the composer there takes the keyboard.
            Button { model.navigate(to: .assistant) } label: {
                Text(L("assistant.placeholder"))
                    .font(Theme.Typo.body).foregroundStyle(Theme.textDim)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.s3)
                    .frame(height: 32)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.field))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L("today.ask.a11y"))
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .todayPanel()
    }
}
