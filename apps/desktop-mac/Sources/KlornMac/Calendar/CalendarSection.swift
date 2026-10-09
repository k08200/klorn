import SwiftUI

/// Calendar in the main window (M4b): the existing calendar screen at the
/// content area's full width. Team availability stays reachable from here
/// while the server grants team mode (productization plan §4).
struct CalendarSection: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions
    /// Render seam: the offscreen shots pin the visible month.
    var initialScope: CalendarScreen.Scope = .month
    var initialAnchor = Date()

    private enum Pane: Hashable { case calendar, teams }

    private var pane: Pane {
        model.listMode == .teams && model.teamModeAvailable ? .teams : .calendar
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.teamModeAvailable {
                SegmentedBar(
                    segments: [
                        BarSegment(value: Pane.calendar, title: NavSection.calendar.title),
                        BarSegment(value: Pane.teams, title: L("teams.title")),
                    ],
                    selection: pane, label: NavSection.calendar.title,
                    onSelect: { model.go(to: $0 == .teams ? .teams : .calendar) })
                    .padding(.horizontal, Theme.s6)
                    .frame(height: NavRules.topBarHeight)
                Rectangle().fill(Theme.line).frame(height: Theme.hairline)
            }
            switch pane {
            case .calendar:
                CalendarScreen(
                    actions: actions, initialScope: initialScope, initialAnchor: initialAnchor,
                    style: .window)
            case .teams:
                // Built for the list column; keep its measure readable.
                TeamsColumn()
                    .frame(maxWidth: 560, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
