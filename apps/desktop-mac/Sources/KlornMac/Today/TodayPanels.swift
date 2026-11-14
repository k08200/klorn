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

/// The P12 blocks, each only with its server flag (and, for free time, a
/// saved team). They sit under the day in the calendar column (stacked), or
/// at the foot of the page when the column folds into a strip (side by side).
struct TodayExtras: View {
    @Environment(AppModel.self) private var model
    let now: Date
    var stacked = false

    var body: some View {
        let freeTime = FreeTimeRules.visible(teamMode: model.clientFlags.teamMode, teamCount: model.teams.count)
        if freeTime || model.clientFlags.files {
            let layout = stacked
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: Theme.s3))
                : AnyLayout(HStackLayout(alignment: .top, spacing: Theme.s3))
            layout {
                if freeTime {
                    TodayFreeTimePanel(renderNow: Theme.isRenderingOffscreen ? now : nil)
                }
                if model.clientFlags.files { TodayRecentFilesPanel() }
            }
        }
    }
}
