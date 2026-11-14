import SwiftUI

/// Today's day at a glance (founder, 2026-11-13, LOCKED): a right column
/// that does not scroll with the mail — the schedule as a timeline, the free
/// time, then the P12 blocks. Read from the existing today summary.
struct TodayCalendarColumn: View {
    @Environment(AppModel.self) private var model
    let now: Date

    var body: some View {
        // Its own scroll only for a day too long for the window; the mail
        // list beside it scrolls on its own.
        OffscreenFriendlyScroll {
            VStack(alignment: .leading, spacing: Theme.s6) {
                VStack(alignment: .leading, spacing: Theme.s2) {
                    TodayCaps(text: L("today.schedule"))
                    TodayTimeline(now: now)
                }
                VStack(alignment: .leading, spacing: Theme.s2) {
                    TodayCaps(text: L("today.free.title"))
                    TodayFreeSlots(now: now)
                }
                TodayExtras(now: now, stacked: true)
            }
            .padding(.bottom, Theme.s6)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .frame(width: TodayLayoutRules.columnWidth)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

/// The column folded into one line under the headline, for a narrow card or
/// an open assistant panel: what is on now, what is next, the first free
/// stretch. Never below the lanes.
struct TodayCalendarStrip: View {
    @Environment(AppModel.self) private var model
    let now: Date

    var body: some View {
        // An overlay never asks for width: chips past the card's edge are
        // cut instead of widening the whole Today column.
        Color.clear
            .frame(maxWidth: .infinity)
            .frame(height: TodayLayout.linkHeight)
            .overlay(alignment: .leading) { row.fixedSize() }
            .clipped()
    }

    private var row: some View {
        let entries = TodayTimelineRules.entries(model.today, now: now)
        let free = TodayTimelineRules.freeSlots(events: entries.map(\.event), now: now).first
        return HStack(spacing: Theme.s3) {
            TodayCaps(text: L("today.schedule"))
            if model.today == nil {
                Text(L("bar.loading")).font(Theme.Typo.body).foregroundStyle(Theme.todayInk2)
            } else if entries.isEmpty {
                Text(L("today.calendar.empty")).font(Theme.Typo.body).foregroundStyle(Theme.todayInk2)
            } else {
                ForEach(entries, id: \.event.id) { entry in
                    stripChip(entry)
                }
            }
            if let free {
                Text("\(L("today.free.title")) \(TodayFreeSlots.label(free))")
                    .font(Theme.Typo.meta.monospacedDigit()).foregroundStyle(Theme.todayInk2)
                    .lineLimit(1)
            }
        }
    }

    private func stripChip(_ entry: TodayTimelineRules.Entry) -> some View {
        let start = TodayTimelineRules.parseISO(entry.event.startTime).map { TodayTimelineRules.clock($0) }
        let time = entry.event.allDay ? L("calendar.allDay") : (start ?? "")
        let lead = entry.isNow ? L("section.now") : entry.isNext ? L("today.timeline.next") : time
        return HStack(spacing: Theme.s1) {
            Text(lead).font(Theme.Typo.meta.monospacedDigit())
                .foregroundStyle(entry.isNow || entry.isNext ? Theme.todayInk1 : Theme.todayInk3)
            Text(entry.event.title).font(Theme.Typo.rowSender).foregroundStyle(Theme.todayInk1)
        }
        .lineLimit(1).fixedSize()
        .padding(.horizontal, Theme.s2)
        .frame(height: TodayLayout.chipHeight + Theme.s1)
        .background(
            entry.isNext ? Theme.todayRaised : .clear, in: RoundedRectangle(cornerRadius: Theme.Radius.chip))
        .accessibilityElement(children: .combine)
    }
}

/// The schedule as a vertical timeline: start time, a bar in the
/// calendar's color, the title and range; a "now" line between what has
/// started and what has not; the next event on a raised fill.
private struct TodayTimeline: View {
    @Environment(AppModel.self) private var model
    let now: Date

    var body: some View {
        if model.today == nil {
            Text(L("bar.loading")).font(Theme.Typo.body).foregroundStyle(Theme.todayInk2)
        } else {
            let entries = TodayTimelineRules.entries(model.today, now: now)
            if entries.isEmpty {
                Text(L("today.calendar.empty")).font(Theme.Typo.body).foregroundStyle(Theme.todayInk2)
            } else {
                let marker = TodayTimelineRules.nowMarkerIndex(entries, now: now)
                VStack(alignment: .leading, spacing: Theme.s1) {
                    ForEach(Array(entries.enumerated()), id: \.element.event.id) { index, entry in
                        if marker == index { nowLine }
                        TodayTimelineRow(entry: entry)
                    }
                    if marker == entries.count { nowLine }
                }
            }
        }
    }

    private var nowLine: some View {
        HStack(spacing: Theme.s1) {
            Circle().fill(Theme.accent).frame(width: TodayLayout.nowDot, height: TodayLayout.nowDot)
            Text("\(L("section.now")) \(TodayTimelineRules.clock(now))")
                .font(Theme.Typo.caption.monospacedDigit()).foregroundStyle(Theme.todayInk2)
                .lineLimit(1).fixedSize()
            Rectangle().fill(Theme.accent).frame(height: Theme.hairline)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One event on the timeline. Joins the meeting when it has a safe link.
private struct TodayTimelineRow: View {
    let entry: TodayTimelineRules.Entry

    private var event: CalendarEventWire { entry.event }

    var body: some View {
        let source = calendarEventSourceLabel(event)
        let start = TodayTimelineRules.parseISO(event.startTime).map { TodayTimelineRules.clock($0) }
        let range = eventTimeLabel(startISO: event.startTime, endISO: event.endTime, allDay: event.allDay)
        let detail = entry.isNow ? "\(L("section.now")) · \(range)"
            : entry.isNext ? "\(L("today.timeline.next")) · \(range)" : range
        let row = HStack(alignment: .top, spacing: Theme.s2) {
            Text(event.allDay ? L("calendar.allDay") : (start ?? ""))
                .font(Theme.Typo.meta.monospacedDigit())
                .foregroundStyle(entry.isNext ? Theme.todayInk1 : Theme.todayInk3)
                .lineLimit(1)
                .frame(width: TodayLayout.timelineClock, alignment: .leading)
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
                Text(detail).font(Theme.Typo.meta.monospacedDigit()).foregroundStyle(Theme.todayInk2)
                    .lineLimit(1)
                if let source {
                    Text(source).font(Theme.Typo.caption).foregroundStyle(Theme.todayInk3)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 0)
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, Theme.s2).padding(.vertical, Theme.s1)
        .background(
            entry.isNext ? Theme.todayRaised : .clear, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
        if let url = MeetingLink.safeURL(event.meetingLink) {
            Button { NSWorkspace.shared.open(url) } label: { row.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityLabel(L("calendar.join.a11y", event.title))
        } else {
            row.accessibilityElement(children: .combine)
        }
    }
}

/// Free stretches left today, from the events themselves.
struct TodayFreeSlots: View {
    @Environment(AppModel.self) private var model
    let now: Date

    var body: some View {
        if model.today == nil {
            Text(L("bar.loading")).font(Theme.Typo.body).foregroundStyle(Theme.todayInk2)
        } else {
            let slots = TodayTimelineRules.freeSlots(
                events: TodayTimelineRules.entries(model.today, now: now).map(\.event), now: now)
            if slots.isEmpty {
                Text(L("today.free.none")).font(Theme.Typo.body).foregroundStyle(Theme.todayInk2)
            } else {
                VStack(alignment: .leading, spacing: Theme.s1) {
                    ForEach(slots, id: \.start) { slot in
                        Text(Self.label(slot))
                            .font(Theme.Typo.meta.monospacedDigit()).foregroundStyle(Theme.todayInk1)
                            .lineLimit(1)
                            .padding(.horizontal, Theme.s2)
                    }
                }
            }
        }
    }

    /// "09:00–09:30", or "After 12:00" for the rest of the day.
    static func label(_ slot: TodayTimelineRules.FreeSlot) -> String {
        let start = TodayTimelineRules.clock(slot.start)
        guard let end = slot.end else { return L("today.free.after", start) }
        return "\(start)–\(TodayTimelineRules.clock(end))"
    }
}
