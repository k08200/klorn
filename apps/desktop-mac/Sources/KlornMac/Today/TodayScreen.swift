import SwiftUI

/// Today — the main window's home (productization plan §1, FD-1). Composed
/// from what the app already holds: the firewall queue by lane, today's
/// calendar summary, the briefing and the pending approvals. It fetches
/// nothing of its own.
struct TodayScreen: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions
    /// Injectable so the offscreen renderer shows a fixed date.
    var now = Date()

    static let sideColumnWidth: CGFloat = 300

    private var state: TodayState {
        TodayRules.state(phase: model.phase, hasQueue: model.queue != nil, loadError: model.loadError)
    }

    private var dateLabel: String {
        let formatter = DateFormatter()
        formatter.locale = L10n.activeLocale
        formatter.setLocalizedDateFormatFromTemplate("EEEEMMMMd")
        return formatter.string(from: now)
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
                SignInMessage(signingIn: state == .signingIn, onSignIn: actions.onSignIn)
            case .loading:
                FirstSyncState()
                Spacer(minLength: 0)
            case .failed(let message):
                StateMessage(
                    icon: "exclamationmark.triangle", title: L("today.failed.title"),
                    detail: message, actionTitle: L("today.retry"),
                    action: { Task { await model.loadQueue() } })
            case .ready:
                if Theme.isRenderingOffscreen {
                    // ImageRenderer draws nothing inside a ScrollView; lay
                    // the content out directly and cut it at the frame.
                    Color.clear.overlay(alignment: .topLeading) { ready }.clipped()
                } else {
                    ScrollView { ready }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var ready: some View {
        HStack(alignment: .top, spacing: Theme.s6) {
            VStack(alignment: .leading, spacing: Theme.s6) {
                if model.loadError != nil { staleNotice }
                let lanes = model.queue.map(TodayRules.lanes) ?? []
                if lanes.isEmpty {
                    EmptyState(
                        icon: "checkmark.circle", title: L("today.clear.title"),
                        hint: L("today.clear.detail"))
                        .padding(.vertical, Theme.s6 * 2)
                } else {
                    ForEach(lanes, id: \.tier) { lane in
                        TodayLaneGroup(lane: lane, now: now, open: open)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            VStack(alignment: .leading, spacing: Theme.s4) {
                TodayCalendarPanel()
                TodayAssistantPanel()
            }
            .frame(width: Self.sideColumnWidth)
        }
        .padding(Theme.s6)
        .frame(maxWidth: 1080, alignment: .topLeading)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    /// The queue on screen is the last good one; say so, and offer a retry.
    private var staleNotice: some View {
        HStack(spacing: Theme.s2) {
            Image(systemName: "exclamationmark.triangle").font(Theme.Typo.icon)
                .foregroundStyle(Theme.textDim).accessibilityHidden(true)
            Text(L("today.stale")).font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
            Button(L("today.retry")) { Task { await model.loadQueue() } }
                .buttonStyle(.plain).font(Theme.Typo.caption.weight(.semibold))
                .foregroundStyle(Theme.text)
        }
    }

    /// A row opens in Mail: the list on a facet that holds it, the reader
    /// beside it.
    private func open(_ item: FirewallItem) {
        model.revealInMail(item)
        actions.onSelect(item)
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
                    Circle().fill(Theme.tint(lane.tier)).frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                    Text(lane.tier.label).font(Theme.Typo.head).foregroundStyle(Theme.text)
                    Text("\(lane.count)")
                        .font(Theme.Typo.body.monospacedDigit()).foregroundStyle(Theme.textDim)
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
            .accessibilityLabel(L("today.lane.a11y", lane.tier.label, lane.count))

            if lane.style == .rows, !lane.rows.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(lane.rows.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { rowDivider }
                        TodayMailRow(item: item, now: now, open: { open(item) })
                    }
                    if lane.remaining > 0 {
                        rowDivider
                        Button(action: openLane) {
                            Text(L("today.lane.more", lane.remaining))
                                .font(Theme.Typo.label).foregroundStyle(Theme.textDim)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, Theme.s3)
                                .frame(height: 32)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).hoverDim()
                    }
                }
                .todayPanel()
            }
        }
    }

    private var rowDivider: some View {
        Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, Theme.s3)
    }
}

/// A Today mail row: the subject is the statement, the sender and the
/// reason are the metadata under it. Two lines, so nine rows fit a screen.
private struct TodayMailRow: View {
    let item: FirewallItem
    let now: Date
    let open: () -> Void
    @State private var hovering = false

    private var sender: String {
        let name = senderDisplayName(item.email?.from.map(decodeHTMLEntities))
        return name.isEmpty ? (sourceBadgeLabel(item.source) ?? L("source.unknown")) : name
    }
    private var subject: String { decodeHTMLEntities(item.email?.subject ?? item.title) }
    private var time: String {
        mailTimeLabel(iso: item.email?.receivedAt ?? item.surfacedAt, now: now)
    }

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.s2) {
                    Text(subject).font(Theme.Typo.body.weight(.medium))
                        .foregroundStyle(Theme.text).lineLimit(1)
                    Spacer(minLength: Theme.s2)
                    Text(time).font(Theme.Typo.caption.monospacedDigit())
                        .foregroundStyle(Theme.textDim)
                }
                HStack(spacing: 6) {
                    Text(sender).font(Theme.Typo.label).foregroundStyle(Theme.textDim)
                        .lineLimit(1).layoutPriority(1)
                    ReplyStateChip(
                        state: item.email?.replyState, draftReady: item.email?.draftReady ?? false)
                    if let reason = rowTierReason(item.tierReason) {
                        Text(reason).font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(hovering ? Theme.surfaceHover : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(L("today.row.a11y", sender, subject))
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
