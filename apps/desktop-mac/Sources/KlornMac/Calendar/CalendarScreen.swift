import SwiftUI

/// One UPCOMING row: start time + title, quiet at rest. Click opens a
/// lightweight detail popover (title / time / location, Join when there's a
/// meeting link) with "Open in Klorn" → the full view, which carries today and
/// the week ahead.
/// The real calendar (founder 2026-08-26: an empty week must show the
/// CALENDAR, not a "no events" line — the grid itself is the information).
/// Three scopes like the system Calendar app: 일 (one day's events), 월 (the
/// month grid), 년 (twelve mini-months). Month is the default; a day cell
/// drills into 일, a mini-month into 월. Events come from the existing
/// GET /api/calendar?start&end — fetched per visible range, keyed so stale
/// responses for a range the user already left are dropped.
struct CalendarScreen: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    enum Scope: String, CaseIterable, Identifiable {
        case day, week, month, year
        var id: String { rawValue }
        var label: String { L("cal.scope.\(rawValue)") }
    }

    /// Injectable so the offscreen renderer can pin the visible month to the
    /// fixture's dates (Date() would drift the shot every month). Explicit
    /// init because private @State demotes the memberwise one.
    let initialScope: Scope
    let initialAnchor: Date
    @State private var scope: Scope = .month
    /// The anchor date the visible range derives from (today at first).
    @State private var anchor = Date()

    /// `.window` in the main window: the month grid fills the height it is
    /// given and the month view wears the type roles. The default is the
    /// bar's calendar, unchanged.
    let style: ShellStyle
    private var m: CalendarMetrics { style == .window ? .window : .bar }

    init(
        actions: TopBarActions, initialScope: Scope = .month, initialAnchor: Date = Date(),
        style: ShellStyle = .bar
    ) {
        self.actions = actions
        self.initialScope = initialScope
        self.initialAnchor = initialAnchor
        self.style = style
    }

    private var calendar: Calendar { Calendar.current }
    private var buckets: [String: [CalendarEventWire]] {
        eventsByDay(model.calendarRangeEvents, calendar: calendar)
    }

    /// The fetch range for the current scope — month pads to the drawn grid,
    /// year covers the year, day fetches its month (so ‹› stays warm).
    private var range: (start: Date, end: Date) {
        let c = calendar
        switch scope {
        case .year:
            var comps = c.dateComponents([.year], from: anchor)
            comps.month = 1
            comps.day = 1
            let start = c.date(from: comps) ?? anchor
            let end = c.date(byAdding: DateComponents(year: 1, day: -1), to: start) ?? anchor
            return (start, c.date(byAdding: .day, value: 1, to: end) ?? end)
        case .month, .week, .day:
            // A week always sits inside its month's drawn grid (whole weeks
            // from the 1st's week to the last day's), so the month fetch
            // covers it and ‹› stays warm across the month boundary.
            let comps = c.dateComponents([.year, .month], from: anchor)
            let days = monthGridDays(year: comps.year ?? 2026, month: comps.month ?? 1, calendar: c)
            guard let first = days.first, let last = days.last else { return (anchor, anchor) }
            return (first, c.date(byAdding: .day, value: 1, to: last) ?? last)
        }
    }

    private var rangeTitle: String {
        if scope == .week {
            let days = weekDays(containing: anchor, calendar: calendar)
            guard let first = days.first, let last = days.last else { return "" }
            let interval = DateIntervalFormatter()
            interval.calendar = calendar
            interval.locale = L10n.activeLocale
            interval.dateTemplate = "yMMMd"
            return interval.string(from: first, to: last)
        }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = L10n.activeLocale
        switch scope {
        case .day: formatter.setLocalizedDateFormatFromTemplate("yMMMMdEEE")
        case .week, .month: formatter.setLocalizedDateFormatFromTemplate("yMMMM")
        case .year: formatter.setLocalizedDateFormatFromTemplate("y")
        }
        return formatter.string(from: anchor)
    }

    private func step(_ direction: Int) {
        let component: Calendar.Component =
            switch scope {
            case .day: .day
            case .week: .weekOfYear
            case .month: .month
            case .year: .year
            }
        anchor = calendar.date(byAdding: component, value: direction, to: anchor) ?? anchor
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Theme.line)
            Group {
                switch scope {
                case .day: dayView
                case .week: weekView
                case .month: monthView
                case .year: yearView
                }
            }
            .id("\(scope.rawValue)|\(localDayKey(anchor, calendar: calendar))")
        }
        .onAppear {
            scope = initialScope
            anchor = initialAnchor
        }
        .task(id: "\(scope.rawValue)|\(localDayKey(anchor, calendar: calendar))") {
            let r = range
            await model.loadCalendarRange(start: r.start, end: r.end)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text(rangeTitle).font(m.title).foregroundStyle(Theme.text)
                .contentTransition(.numericText())
            if model.calendarRangeLoading && !Theme.isRenderingOffscreen {
                ProgressView().controlSize(.mini)
            }
            Spacer()
            Button { model.beginNewEvent(at: anchor) } label: {
                Image(systemName: "plus").iconTarget(26)
            }
            .buttonStyle(.plain).foregroundStyle(Theme.textDim)
            .help(L("cal.new"))
            .accessibilityLabel(L("cal.new"))
            Button { step(-1) } label: {
                Image(systemName: "chevron.left").iconTarget(26)
            }
            .buttonStyle(.plain).foregroundStyle(Theme.textDim)
            .accessibilityLabel(L("cal.prev"))
            Button(L("cal.today")) { anchor = Date() }
                .buttonStyle(.plain).font(Theme.Typo.label)
                .foregroundStyle(Theme.textDim)
            Button { step(1) } label: {
                Image(systemName: "chevron.right").iconTarget(26)
            }
            .buttonStyle(.plain).foregroundStyle(Theme.textDim)
            .accessibilityLabel(L("cal.next"))
            if Theme.isRenderingOffscreen {
                // ImageRenderer draws NSSegmentedControl as a placeholder —
                // same stand-in pattern as menus and text fields.
                HStack(spacing: 2) {
                    ForEach(Scope.allCases) { item in
                        Text(item.label).font(Theme.Typo.label)
                            .foregroundStyle(item == scope ? Theme.text : Theme.textDim)
                            .padding(.horizontal, 10).padding(.vertical, 4)
                            .background(item == scope ? Theme.surfaceHover : .clear,
                                        in: RoundedRectangle(cornerRadius: 6))
                    }
                }
                .padding(2)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: m.scopeRadius))
            } else {
                Picker("", selection: $scope) {
                    ForEach(Scope.allCases) { s in
                        Text(s.label).tag(s)
                    }
                }
                .pickerStyle(.segmented).labelsHidden().fixedSize()
                .accessibilityLabel(L("cal.scope.a11y"))
            }
        }
        .padding(.horizontal, m.headerInset).padding(.vertical, m.headerVertical)
    }

    // MARK: 일 — one day, its events in order (all-day first).

    private var dayView: some View {
        let key = localDayKey(anchor, calendar: calendar)
        let events = (buckets[key] ?? []).sorted { $0.startTime < $1.startTime }
        return OffscreenFriendlyScroll {
            VStack(alignment: .leading, spacing: 0) {
                if events.isEmpty {
                    // The founder's rule, kept at day grain too: show the day
                    // frame, say it is open — never a bare "nothing".
                    VStack(alignment: .leading, spacing: Theme.s2) {
                        Text(L("cal.dayFree")).font(.callout).foregroundStyle(Theme.textDim)
                    }
                    .padding(24)
                } else {
                    ForEach(events) { event in
                        UpcomingEventRow(event: event, actions: actions)
                        Divider().overlay(Theme.line).padding(.leading, 24)
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: 주 — seven columns, the week containing the anchor. Each day's
    // events in time order (all-day first); every chip opens the detail.

    private var weekView: some View {
        let days = weekDays(containing: anchor, calendar: calendar)
        let todayKey = localDayKey(Date(), calendar: calendar)
        let symbols = orderedWeekdaySymbols
        return OffscreenFriendlyScroll {
            HStack(alignment: .top, spacing: 1) {
                ForEach(Array(days.enumerated()), id: \.element) { index, day in
                    weekColumn(day, symbol: index < symbols.count ? symbols[index] : "",
                               todayKey: todayKey)
                }
            }
            .background(Theme.line)
        }
    }

    private func weekColumn(_ day: Date, symbol: String, todayKey: String) -> some View {
        let key = localDayKey(day, calendar: calendar)
        let events = sortedForDay(buckets[key] ?? [])
        let isToday = key == todayKey
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(symbol).font(Theme.Typo.micro).foregroundStyle(Theme.textDim)
                Text("\(calendar.component(.day, from: day))")
                    .font(Theme.Typo.caption.monospacedDigit().weight(isToday ? .bold : .regular))
                    .foregroundStyle(isToday ? Color.white : Theme.text)
                    .frame(width: 22, height: 22)
                    .background(isToday ? Theme.accent : .clear, in: Circle())
            }
            .padding(.bottom, 2)
            ForEach(events) { event in
                WeekEventChip(
                    event: event,
                    continuation: eventStartDayKey(event, calendar: calendar) != key,
                    actions: actions)
            }
            Spacer(minLength: 0)
        }
        .padding(6)
        .frame(maxWidth: .infinity, minHeight: 360, alignment: .topLeading)
        .background(Theme.panel.opacity(isToday ? 1 : 0.85))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("cal.cell.a11y", key, events.count))
    }

    // MARK: 월 — the grid. Whole weeks, out-of-month days dim, today ringed.

    private var monthView: some View {
        let comps = calendar.dateComponents([.year, .month], from: anchor)
        let days = monthGridDays(year: comps.year ?? 2026, month: comps.month ?? 1,
                                 calendar: calendar)
        let todayKey = localDayKey(Date(), calendar: calendar)
        let symbols = orderedWeekdaySymbols
        let columns = Array(repeating: GridItem(.flexible(), spacing: 1), count: 7)
        let grid = { (rowHeight: CGFloat) in
            LazyVGrid(columns: columns, spacing: 1) {
                ForEach(days, id: \.self) { day in
                    monthCell(day, inMonth: calendar.component(.month, from: day) == comps.month,
                              todayKey: todayKey, rowHeight: rowHeight)
                }
            }
            .background(Theme.line)
        }
        return VStack(spacing: 0) {
            HStack(spacing: 1) {
                ForEach(symbols, id: \.self) { day in
                    Text(day).font(m.weekday).foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.vertical, 6)
            Divider().overlay(Theme.line)
            if style == .window {
                // The weeks share the height the window gives them, so a
                // large window has no empty band under the last week.
                GeometryReader { proxy in
                    grid(CalendarMetrics.monthRowHeight(
                        available: proxy.size.height, weeks: days.count / 7))
                }
            } else {
                grid(CalendarMetrics.minMonthRow)
                Spacer(minLength: 0)
            }
        }
    }

    private func monthCell(
        _ day: Date, inMonth: Bool, todayKey: String, rowHeight: CGFloat
    ) -> some View {
        let key = localDayKey(day, calendar: calendar)
        let events = sortedForDay(buckets[key] ?? [])
        let isToday = key == todayKey
        return Button {
            anchor = day
            scope = .day
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text("\(calendar.component(.day, from: day))")
                    .font(Theme.Typo.caption.monospacedDigit()
                        .weight(isToday ? .bold : .regular))
                    .foregroundStyle(isToday ? Color.white : inMonth ? Theme.text : Theme.textDim)
                    .frame(width: 22, height: 22)
                    .background(isToday ? Theme.accent : .clear, in: Circle())
                ForEach(events.prefix(2)) { event in
                    // A spanning event shows on every day it covers; days
                    // after its first carry an arrow so the chip reads as
                    // "continues", not as a second event.
                    let continues = eventStartDayKey(event, calendar: calendar) != key
                    HStack(spacing: 3) {
                        if continues {
                            Image(systemName: "arrow.right").font(.system(size: 8))
                                .accessibilityHidden(true)
                        }
                        Text(event.title).lineLimit(1)
                    }
                    .font(m.chip)
                    .foregroundStyle(inMonth ? Theme.text : Theme.textDim)
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.accent.opacity(inMonth ? 0.16 : 0.08),
                                in: RoundedRectangle(cornerRadius: m.chipRadius))
                }
                if events.count > 2 {
                    Text(L("cal.more", events.count - 2))
                        .font(m.chip).foregroundStyle(Theme.textDim)
                        .padding(.horizontal, 4)
                }
                Spacer(minLength: 0)
            }
            .padding(5)
            .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .topLeading)
            .background(Theme.panel.opacity(inMonth ? 1 : 0.6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L("cal.cell.a11y", key, events.count))
    }

    // MARK: 년 — twelve mini-months; a dot marks days with events.

    private var yearView: some View {
        let year = calendar.component(.year, from: anchor)
        let columns = Array(repeating: GridItem(.flexible(), spacing: 18), count: 3)
        return OffscreenFriendlyScroll {
            LazyVGrid(columns: columns, alignment: .leading, spacing: 18) {
                ForEach(1...12, id: \.self) { month in
                    miniMonth(year: year, month: month)
                }
            }
            .padding(20)
        }
    }

    private func miniMonth(year: Int, month: Int) -> some View {
        let days = monthGridDays(year: year, month: month, calendar: calendar)
        let columns = Array(repeating: GridItem(.flexible(minimum: 10), spacing: 2), count: 7)
        var comps = DateComponents()
        comps.year = year
        comps.month = month
        comps.day = 1
        let first = calendar.date(from: comps) ?? Date()
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = L10n.activeLocale
        formatter.setLocalizedDateFormatFromTemplate("MMMM")
        return Button {
            anchor = first
            scope = .month
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                Text(formatter.string(from: first))
                    .font(Theme.Typo.label).foregroundStyle(Theme.accentDeep)
                LazyVGrid(columns: columns, spacing: 2) {
                    ForEach(days, id: \.self) { day in
                        let inMonth = calendar.component(.month, from: day) == month
                        let hasEvents = !(buckets[localDayKey(day, calendar: calendar)] ?? [])
                            .isEmpty
                        Text("\(calendar.component(.day, from: day))")
                            .font(.system(size: 9).monospacedDigit())
                            .foregroundStyle(
                                inMonth
                                    ? (hasEvents ? Theme.accentDeep : Theme.text)
                                    : .clear)
                            .frame(maxWidth: .infinity)
                    }
                }
            }
            .padding(10)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(formatter.string(from: first))
    }

    /// Weekday symbols rotated to the calendar's firstWeekday.
    private var orderedWeekdaySymbols: [String] {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = L10n.activeLocale
        let base = formatter.shortWeekdaySymbols ?? []
        guard base.count == 7 else { return base }
        let shift = calendar.firstWeekday - 1
        return Array(base[shift...] + base[..<shift])
    }
}
