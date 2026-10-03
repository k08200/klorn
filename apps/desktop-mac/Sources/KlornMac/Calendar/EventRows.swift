import SwiftUI

/// UPCOMING — tomorrow through the next 7 days, grouped by day (calendar
/// parity with the web: the desktop must not know less about the week
/// than it knows about the day). Rows open a detail popover. Shared by the
/// compact panel's TodayColumn and the full-mode sidebar — same view, same
/// `model.weekAhead` + `upcomingAgenda` data path.
struct UpcomingSection: View {
    let actions: TopBarActions
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ColumnHeader(title: L("section.upcoming"))
            if let week = model.weekAhead {
                let days = upcomingAgenda(now: Date(), events: week)
                if days.isEmpty {
                    EmptyState(icon: "calendar", title: L("calendar.noEventsWeek"))
                        .padding(.vertical, Theme.s2)
                } else {
                    ForEach(days) { day in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(day.label)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Theme.textDim)
                            ForEach(day.events) { event in
                                UpcomingEventRow(event: event, actions: actions)
                            }
                        }
                    }
                }
            } else {
                Text(L("bar.loading")).font(.caption).foregroundStyle(Theme.textDim)
            }
        }
        .padding(.top, 6)
    }
}

struct UpcomingEventRow: View {
    let event: CalendarEventWire
    let actions: TopBarActions
    @State private var showDetail = false
    @State private var hovering = false

    private var timeLabel: String {
        eventTimeLabel(startISO: event.startTime, endISO: event.endTime, allDay: event.allDay)
    }

    var body: some View {
        Button { showDetail = true } label: {
            HStack(alignment: .top, spacing: 8) {
                Text(event.allDay ? L("calendar.allDay") : String(timeLabel.prefix(5)))
                    .font(.caption.monospacedDigit()).foregroundStyle(Theme.textDim)
                    .frame(width: 48, alignment: .leading)
                VStack(alignment: .leading, spacing: 1) {
                    Text(event.title).font(.callout).foregroundStyle(Theme.text).lineLimit(1)
                    if let location = event.location, !location.isEmpty {
                        Text(location).font(.caption2).foregroundStyle(Theme.textDim).lineLimit(1)
                    }
                    if let source = calendarEventSourceLabel(event) {
                        Text(source).font(.caption2).foregroundStyle(Theme.textDim)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
                Spacer(minLength: 0)
                if MeetingLink.safeURL(event.meetingLink) != nil {
                    Image(systemName: "video").font(.caption).foregroundStyle(Theme.textDim)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, Theme.s2).padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(hovering ? Theme.surfaceHover : .clear, in: RoundedRectangle(cornerRadius: 8))
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .accessibilityLabel(
            L("calendar.eventRow.a11y", event.title, event.allDay ? L("calendar.allDay") : timeLabel))
        .popover(isPresented: $showDetail, arrowEdge: .trailing) {
            EventDetailPopover(event: event, actions: actions)
        }
    }
}

/// One event in a week column: title (+ continuation arrow on days after
/// its first), start time for timed events. Opens the same detail popover
/// as the agenda rows.
struct WeekEventChip: View {
    let event: CalendarEventWire
    let continuation: Bool
    let actions: TopBarActions
    @State private var showDetail = false

    private var timeLabel: String {
        eventTimeLabel(startISO: event.startTime, endISO: event.endTime, allDay: event.allDay)
    }

    var body: some View {
        Button { showDetail = true } label: {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 3) {
                    if continuation {
                        Image(systemName: "arrow.right").font(.system(size: 8))
                            .accessibilityHidden(true)
                    }
                    Text(event.title).lineLimit(2)
                }
                .font(Theme.Typo.micro).foregroundStyle(Theme.text)
                if !event.allDay, !timeLabel.isEmpty {
                    Text(String(timeLabel.prefix(5)))
                        .font(.system(size: 9).monospacedDigit()).foregroundStyle(Theme.textDim)
                }
            }
            .padding(.horizontal, 5).padding(.vertical, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.accent.opacity(event.allDay ? 0.24 : 0.14),
                        in: RoundedRectangle(cornerRadius: 4))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            L("calendar.eventRow.a11y", event.title, event.allDay ? L("calendar.allDay") : timeLabel))
        .popover(isPresented: $showDetail, arrowEdge: .trailing) {
            EventDetailPopover(event: event, actions: actions)
        }
    }
}

/// The event detail every calendar surface opens — agenda rows, week chips.
private struct EventDetailPopover: View {
    @Environment(AppModel.self) private var model
    let event: CalendarEventWire
    let actions: TopBarActions
    /// Delete is two clicks inside the popover (no system dialog over a
    /// floating panel): 삭제 → 정말 삭제.
    @State private var confirmDelete = false
    @State private var deleteFailed = false

    private var timeLabel: String {
        eventTimeLabel(startISO: event.startTime, endISO: event.endTime, allDay: event.allDay)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            Text(event.title).font(.headline).foregroundStyle(Theme.text).lineLimit(3)
            if !timeLabel.isEmpty {
                Text(timeLabel).font(.caption.monospacedDigit()).foregroundStyle(Theme.textDim)
            }
            if let location = event.location, !location.isEmpty {
                HStack(spacing: 5) {
                    Image(systemName: "mappin.and.ellipse").font(.caption2)
                        .accessibilityHidden(true)
                    Text(location).font(.caption).lineLimit(2)
                }
                .foregroundStyle(Theme.textDim)
            }
            if let source = calendarEventSourceLabel(event) {
                HStack(spacing: 5) {
                    Image(systemName: "link").font(.caption2).accessibilityHidden(true)
                    // Visible, not only for VoiceOver: why edit and delete are missing.
                    Text("\(source) · \(L("cal.readOnly"))").font(.caption).lineLimit(1)
                        .truncationMode(.middle)
                }
                .foregroundStyle(Theme.textDim)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(L("cal.source.a11y", source))
            }
            // A link MeetingLink.safeURL refuses is shown as inert text, never opened.
            if let link = event.meetingLink, !link.isEmpty, MeetingLink.safeURL(link) == nil {
                Text(verbatim: link).font(.caption).foregroundStyle(Theme.textDim)
                    .lineLimit(2).truncationMode(.middle).textSelection(.enabled)
            }
            HStack(spacing: 8) {
                if let url = MeetingLink.safeURL(event.meetingLink) {
                    Button(L("calendar.join")) { NSWorkspace.shared.open(url) }
                        .buttonStyle(PrimaryButtonStyle())
                        .accessibilityLabel(L("calendar.join.a11y", event.title))
                }
                Button(L("calendar.openInKlorn")) { actions.onOpenFull() }
                .buttonStyle(.bordered).controlSize(.small)
            }
            .padding(.top, 4)
            // Edit / delete (2026-09-11) — the server pushes both to Google. A linked
            // calendar's event is a read-only mirror (step C7): neither is offered.
            if calendarEventIsEditable(event) {
                HStack(spacing: 8) {
                    Button(L("cal.edit")) { model.beginEditingEvent(event) }
                        .buttonStyle(.bordered).controlSize(.small)
                    if confirmDelete {
                        Button(L("cal.delete.confirm")) {
                            Task { deleteFailed = !(await model.deleteEvent(event)) }
                        }
                        .buttonStyle(.bordered).controlSize(.small).tint(Theme.tint(.push))
                    } else {
                        Button(L("cal.delete")) { confirmDelete = true }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                }
            }
            if deleteFailed {
                Text(L("cal.delete.failed")).font(.caption2).foregroundStyle(Theme.tint(.push))
            }
        }
        .padding(Theme.s4)
        .frame(width: 250, alignment: .leading)
    }
}
