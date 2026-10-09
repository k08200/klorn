import SwiftUI

/// Mail in the main window (M4b): the lanes as the primary filter above the
/// existing list, the existing reader beside it. Folders and labels are the
/// sidebar's secondary facets; SILENT is reached only through "Show
/// silenced" (productization plan §1, FD-3).
struct MailSection: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions
    /// Which pane this window's list keys address (M3), as in `FullView`.
    @State private var keyZone: MailKeyZone = .list

    var body: some View {
        if model.queue == nil, let error = model.loadError {
            // The list would show its loading skeleton forever; say what
            // happened instead.
            StateMessage(
                icon: "exclamationmark.triangle", title: L("today.failed.title"),
                detail: error, actionTitle: L("today.retry"),
                action: { Task { await model.loadQueue() } })
        } else {
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    LaneBar()
                    Rectangle().fill(Theme.line).frame(height: 1)
                    FullList(
                        mode: model.listMode, actions: actions, keyZone: $keyZone,
                        keyCatcherInRender: false,
                        hidesLaneTitle: NavRules.laneFilter(for: model.listMode) != nil)
                }
                .frame(width: NavRules.listColumnWidth)
                Rectangle().fill(Theme.line).frame(width: 1)
                ReadingPane(actions: actions, keyZone: keyZone).frame(maxWidth: .infinity)
            }
            // Any new selection (click, key, card) starts in the list.
            .onChange(of: model.selectedItemId) { _, _ in keyZone = .list }
        }
    }
}

/// Push · Meeting · Queue · Info · All, and the menu that holds "Show
/// silenced". No segment is lit while a folder or a label is open.
private struct LaneBar: View {
    @Environment(AppModel.self) private var model

    private var selected: LaneFilter? { NavRules.laneFilter(for: model.listMode) }

    /// What the list under the tab holds (the same rows FullList shows).
    private func count(for filter: LaneFilter) -> Int? {
        guard let queue = model.queue else { return nil }
        return filter.tier.map { queue.items(for: $0).count } ?? queue.itemsByTime.count
    }

    private var segments: [BarSegment<LaneFilter>] {
        LaneFilter.allCases.map { filter in
            // The lit tab carries the count the list title used to show.
            BarSegment(
                value: filter, title: filter.title,
                count: filter == selected ? count(for: filter) : nil,
                dot: filter.tier.map(Theme.tint))
        }
    }

    var body: some View {
        let silenced = NavRules.showsSilenced(model.listMode)
        HStack(spacing: Theme.s1) {
            SegmentedBar(
                segments: segments, selection: selected,
                label: L("mail.lane.a11y"), onSelect: { model.showLane($0) })
            Spacer(minLength: 0)
            if Theme.isRenderingOffscreen {
                // ImageRenderer paints an AppKit menu as a placeholder.
                menuGlyph(active: silenced)
            } else {
                Menu {
                    Toggle(L("mail.lane.showSilenced"), isOn: Binding(
                        get: { silenced },
                        set: { model.go(to: $0 ? .tier(.silent) : NavRules.defaultMailMode) }))
                    Divider()
                    // The lane guide explains exactly these segments.
                    Button(L("guide.reopen")) { model.showTierGuide = true }
                } label: {
                    menuGlyph(active: silenced)
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help(L("mail.lane.filter"))
                .accessibilityLabel(L("mail.lane.filter"))
            }
        }
        .padding(.horizontal, Theme.s3)
        .frame(height: NavRules.topBarHeight)
    }

    private func menuGlyph(active: Bool) -> some View {
        Image(systemName: active
            ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
            .font(Theme.Typo.body)
            .foregroundStyle(active ? Theme.text : Theme.textDim)
            .iconTarget()
    }
}
