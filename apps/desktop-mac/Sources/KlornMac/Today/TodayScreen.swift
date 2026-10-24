import SwiftUI

/// Today — the main window's home (productization plan §1, FD-1). Composed
/// from what the app already holds: the firewall queue by lane, today's
/// calendar summary, the briefing and the pending approvals. It fetches
/// nothing of its own.
struct TodayScreen: View {
    @Environment(AppModel.self) private var model
    let actions: ShellActions
    /// Injectable so the offscreen renderer shows a fixed date.
    var now = Date()

    static let sideColumnWidth: CGFloat = 300

    private var state: SurfaceState { model.surfaceState }

    /// No date in a preview render (`TodayRules.headerDetail`); the shipping
    /// app always shows today's date.
    private var dateLabel: String? {
        TodayRules.headerDetail(
            now: now, renderingOffscreen: Theme.isRenderingOffscreen, locale: L10n.activeLocale)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: NavSection.today.title, detail: dateLabel) {
                // The unified list is the default; this only narrows it.
                InboxSelectorMenu()
            }
            Rectangle().fill(Theme.line).frame(height: 1)
            switch state {
            case .signedOut, .signingIn:
                SurfaceStateView(state: state)
            case .offline, .failed:
                // The error replaces the lanes, not the day: the calendar and
                // the assistant still have something true to say.
                columns {
                    SurfaceStateView(state: state, anchorInset: TodayLayout.anchorInColumn)
                        .frame(maxWidth: .infinity, alignment: .top)
                }
            case .loading:
                // The skeleton is the loaded Today's shape: lane headers and
                // rows on the left, the rail on the right.
                columns { TodaySkeleton() }
            case .ready:
                if Theme.isRenderingOffscreen {
                    // ImageRenderer draws nothing inside a ScrollView; lay
                    // the content out directly and cut it at the frame.
                    Color.clear.overlay(alignment: .topLeading) { ready }.clipped()
                } else {
                    // The bottom clears the floating assistant button, so
                    // the last rail card is never stuck under it.
                    ScrollView { ready.padding(.bottom, AssistantDock.contentClearance) }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var ready: some View {
        columns {
            VStack(alignment: .leading, spacing: Theme.s6) {
                let lanes = model.queue.map(TodayRules.lanes) ?? []
                if lanes.isEmpty {
                    EmptyState(
                        icon: "checkmark.circle", title: L("today.clear.title"),
                        hint: L("today.clear.detail"))
                        .padding(.top, TodayLayout.anchorInColumn)
                } else {
                    TodayHeaderLine(summary: TodayRules.headerSummary(lanes))
                    ForEach(lanes, id: \.tier) { lane in
                        TodayLaneGroup(lane: lane, now: now, open: open)
                    }
                }
            }
        }
    }

    /// The Today frame every state shares: the main column and the rail.
    private func columns(@ViewBuilder _ main: () -> some View) -> some View {
        HStack(alignment: .top, spacing: Theme.s6) {
            main().frame(maxWidth: .infinity, alignment: .topLeading)
            rail.frame(width: Self.sideColumnWidth)
        }
        .padding(Theme.s6)
        .frame(maxWidth: 1080, alignment: .topLeading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private var rail: some View {
        if state == .loading {
            TodayRailSkeleton()
        } else {
            VStack(alignment: .leading, spacing: Theme.s4) {
                TodayCalendarPanel()
                // P12: each only with its server flag (and, for free time, a saved team).
                if FreeTimeRules.visible(teamMode: model.clientFlags.teamMode, teamCount: model.teams.count) {
                    TodayFreeTimePanel(renderNow: Theme.isRenderingOffscreen ? now : nil)
                }
                if model.clientFlags.files { TodayRecentFilesPanel() }
                TodayAssistantPanel()
            }
        }
    }

    /// A row opens in Mail: the list on a facet that holds it, the reader
    /// beside it.
    private func open(_ item: FirewallItem) {
        model.revealInMail(item)
        actions.onSelect(item)
    }
}

/// The day in one calm line (founder decision 2026-10-24): counts for Push
/// and Meeting only, else "Nothing needs you right now", then one quiet
/// "N waiting in Mail" for Queue + Info that opens Mail. Silent never shows.
private struct TodayHeaderLine: View {
    @Environment(AppModel.self) private var model
    let summary: TodayHeaderSummary

    var body: some View {
        HStack(spacing: Theme.s4) {
            ForEach(summary.needs, id: \.tier) { need in
                HStack(spacing: Theme.s1) {
                    Circle().fill(Theme.tint(need.tier)).frame(width: 6, height: 6)
                        .accessibilityHidden(true)
                    Text(L("today.header.lane", need.count, need.tier.label))
                        .foregroundStyle(Theme.text)
                }
            }
            if summary.calm {
                Text(L("tier.push.empty")).foregroundStyle(Theme.textDim)
            }
            if summary.waiting > 0 {
                Button { model.go(to: .tier(.queue)) } label: {
                    Text(TodayRules.waitingLine(summary.waiting))
                        .foregroundStyle(Theme.textDim)
                        .frame(minHeight: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).hoverDim()
            }
        }
        .font(Theme.Typo.caption.monospacedDigit())
        .lineLimit(1)
        .padding(.horizontal, Theme.s1)
    }
}

/// One lane on Today: a header that opens the lane in Mail, then its rows
/// in a hairline group (or just the header for a collapsed lane).
private struct TodayLaneGroup: View {
    @Environment(AppModel.self) private var model
    let lane: TodayLane
    let now: Date
    let open: (FirewallItem) -> Void

    private func openLane() {
        model.go(to: .tier(lane.tier))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            Button(action: openLane) {
                HStack(spacing: Theme.s2) {
                    // The one chip spec (X1) heads the group, as on the web.
                    // No count (founder decision 2026-10-24): the Today
                    // header already counts Push and Meeting and the wait.
                    WindowLaneChip(tier: lane.tier)
                    Spacer(minLength: Theme.s2)
                    if lane.style == .collapsed {
                        Image(systemName: "chevron.right").font(Theme.Typo.caption)
                            .foregroundStyle(Theme.textDim).accessibilityHidden(true)
                    }
                }
                .padding(.horizontal, Theme.s1)
                .frame(minHeight: 24)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(lane.tier.blurb)
            .accessibilityLabel(lane.tier.label)

            if lane.style == .rows, !lane.rows.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(lane.rows.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { rowDivider }
                        TodayMailRow(item: item, now: now, open: { open(item) })
                    }
                    if lane.remaining > 0 {
                        rowDivider
                        laneLink(L("today.lane.more", lane.remaining))
                    } else if lane.older > 0 {
                        rowDivider
                        laneLink(L("today.lane.push.older", lane.tier.label))
                    }
                }
                .todayPanel()
            } else if lane.style == .rows, lane.older > 0 {
                // Nothing inside Today's window: a calm line, and older PUSH
                // one click away in Mail so nothing becomes unreachable.
                VStack(spacing: 0) {
                    Text(L("tier.push.empty"))
                        .font(Theme.Typo.label).foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s2)
                    rowDivider
                    laneLink(L("today.lane.push.older", lane.tier.label))
                }
                .todayPanel()
            }
        }
    }

    /// A quiet link row that opens this lane in Mail, in caption ink.
    private func laneLink(_ title: String) -> some View {
        Button(action: openLane) {
            Text(title)
                .font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Theme.s3)
                .frame(height: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).hoverDim()
    }

    private var rowDivider: some View {
        Rectangle().fill(Theme.line).frame(height: Theme.hairline).padding(.leading, Theme.s3)
    }
}

/// A Today mail row under the one-badge rule: who, what, when, and why (the
/// lane reason, or the snippet). The lane is the group it sits in; the reply
/// state is in the reader.
private struct TodayMailRow: View {
    @Environment(AppModel.self) private var model
    let item: FirewallItem
    let now: Date
    let open: () -> Void
    @State private var hovering = false

    var body: some View {
        // Mixed lanes never happen inside a lane group: no chip.
        let content = WindowRowRules.content(
            for: item, mixedLanes: false, inboxes: model.inboxes,
            opened: model.openedEmailIds, now: now)
        Button(action: open) {
            WindowRowBody(content: content)
                .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s2)
                .frame(maxWidth: .infinity, minHeight: Theme.mailRowHeight, alignment: .leading)
                .background(hovering ? Theme.surfaceHover : .clear)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(
            WindowRowRules.a11yLabel(
                content, lead: L("today.row.a11y", content.sender, content.subject)))
    }
}

extension View {
    /// A Today group: the raised surface with a hairline, no shadow.
    func todayPanel() -> some View {
        background(Theme.panel, in: RoundedRectangle(cornerRadius: Theme.Radius.md))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).strokeBorder(Theme.line))
    }
}
