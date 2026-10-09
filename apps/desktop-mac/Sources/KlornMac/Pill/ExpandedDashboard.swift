import SwiftUI

// MARK: - Expanded (3 columns)

/// Expanded panel: header + 3 columns (INBOX / RECENT PUSH / ACCOUNT).
struct ExpandedPanel: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Theme.line).padding(.horizontal, 18)
            HStack(alignment: .top, spacing: 0) {
                InboxColumn(actions: actions)
                columnDivider
                RecentPushColumn(actions: actions)
                columnDivider
                TodayColumn(actions: actions)
                columnDivider
                AccountColumn(actions: actions)
            }
        }
        .frame(width: TopBarMetrics.expanded.width, height: TopBarMetrics.expanded.height)
        // Fresh-release discovery: re-check (15-min debounced) every time the
        // panel opens instead of waiting for the 6h background tick.
        .onAppear { model.checkForUpdateOnPanelOpen() }
    }

    private var header: some View {
        HStack {
            // The ✕ on the right is the one way out (dogfood 2026-07-20) —
            // the old "— Close" here did the exact same thing, so it's gone.
            // Balance the ✕'s width so the wordmark stays optically centered.
            Color.clear.frame(width: 28, height: 28)

            Spacer()
            HStack(spacing: 8) { LogoRing(); Text("Klorn").font(.system(.callout, design: .rounded).weight(.bold)).foregroundStyle(Theme.text) }
            Spacer()

            HStack(spacing: 14) {
                AppearanceToggle()
                Button(action: actions.onExpandFull) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right").font(.callout).iconTarget()
                }
                .buttonStyle(.plain).hoverDim()
                .help(L("bar.fullView"))
                .accessibilityLabel(L("bar.fullView.a11y"))

                // Sign-out lives under the account heading, not here: two
                // controls for one destructive action reads as though they
                // differ, and this one sat directly beside the ✕. Log In stays
                // — signed out, it is the only thing worth offering.
                if model.phase == .signedOut {
                    Button(L("auth.logIn"), action: actions.onSignIn)
                        .buttonStyle(PrimaryButtonStyle())
                }

                // One click OUT from anywhere (dogfood 2026-07-20: the ✕ only
                // existed on the pill) — closes back to the resting state.
                Button(action: actions.onClose) {
                    Image(systemName: "xmark").font(.callout.weight(.semibold)).iconTarget()
                }
                .buttonStyle(.plain).hoverDim()
                .help(L("bar.close"))
                .accessibilityLabel(L("bar.close.a11y"))
            }
        }
        .padding(.horizontal, 18).frame(height: 56)
    }

    private var columnDivider: some View {
        Rectangle().fill(Theme.line).frame(width: 1).padding(.vertical, 14)
    }
}

/// Column 1 — per-tier open counts; click opens that tier in the full view.
/// TODAY — the day's calendar at a glance (current meeting + what's next).
/// Rows with a meeting link open it directly; others are display-only.
private struct TodayColumn: View {
    let actions: TopBarActions
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ColumnHeader(title: L("section.todayShort"))
            // Scrollable: TODAY + the 7-day UPCOMING agenda share the column,
            // and a busy week must not push the receipt off a 380pt panel.
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 14) {
            if model.briefing != nil || model.briefingStructure != nil {
                BriefingCard(briefing: model.briefing, structure: model.briefingStructure) {
                    actions.onOpenFull()
                }
            }
            if let today = model.today, today.total > 0 {
                if let current = today.current {
                    eventRow(current, isNow: true)
                }
                ForEach(today.upcoming.prefix(4)) { event in
                    eventRow(event, isNow: false)
                }
                if today.upcoming.count > 4 {
                    Text(L("bar.more", today.upcoming.count - 4))
                        .font(.caption2).foregroundStyle(Theme.textDim)
                }
            } else {
                Text(model.today == nil ? L("bar.loading") : L("calendar.noEvents"))
                    .font(.caption).foregroundStyle(Theme.textDim)
            }

            // The agent's daily receipt — trust needs visibility. Hidden on
            // no-activity days (an empty receipt is noise). Click opens the
            // proposals list, where pending actions are approved or declined.
            if let agent = model.agentToday, let line = agentActivityLine(agent.totals) {
                Button { actions.onOpenProposals() } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 5) {
                            Image(systemName: "gearshape")
                                .font(.caption2).foregroundStyle(Theme.accent)
                                .accessibilityHidden(true)
                            Text(L("section.today")).font(.caption2.weight(.semibold))
                                .foregroundStyle(Theme.textDim)
                        }
                        Text(line).font(.caption).foregroundStyle(Theme.text)
                        if let first = (agent.pending.first ?? agent.executed.first),
                           let summary = first.summary {
                            Text(summary).font(.caption2).foregroundStyle(Theme.textDim)
                                .lineLimit(2).multilineTextAlignment(.leading)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8).padding(.leading, 6)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 1).fill(Theme.accent.opacity(0.7))
                            .frame(width: 2).padding(.vertical, 6)
                    }
                }
                .buttonStyle(.plain)
                .padding(.top, 6)
                .accessibilityLabel(L("today.a11y", line))
            }
            UpcomingSection(actions: actions)
                }
            }
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func eventRow(_ event: CalendarEventWire, isNow: Bool) -> some View {
        let time = eventTimeLabel(
            startISO: event.startTime, endISO: event.endTime, allDay: event.allDay)
        let row = HStack(alignment: .top, spacing: 8) {
            if isNow {
                Text(L("section.now"))
                    .font(.caption2.weight(.bold)).foregroundStyle(Theme.accent)
                    .padding(.top, 2)
            } else {
                Text(time)
                    .font(.caption.monospacedDigit()).foregroundStyle(Theme.textDim)
                    .frame(width: 82, alignment: .leading)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(event.title).font(.callout).foregroundStyle(Theme.text).lineLimit(1)
                if let location = event.location, !location.isEmpty {
                    Text(location).font(.caption2).foregroundStyle(Theme.textDim).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if MeetingLink.safeURL(event.meetingLink) != nil {
                Image(systemName: "video").font(.caption).foregroundStyle(Theme.textDim)
                    .accessibilityHidden(true)
            }
        }
        if let url = MeetingLink.safeURL(event.meetingLink) {
            Button { NSWorkspace.shared.open(url) } label: { row }
                .buttonStyle(.plain)
                .accessibilityLabel(L("calendar.join.a11y", event.title))
        } else {
            row.accessibilityElement(children: .combine)
        }
    }
}

private struct InboxColumn: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                ColumnHeader(title: L("section.inbox"))
                // "What is this?" — reopens the tier guide right where the
                // "inbox가 뭔지 모르겠다" question arises (both surfaces that
                // render this header: expanded panel and full-view sidebar).
                Button {
                    model.showTierGuide = true
                } label: {
                    Image(systemName: "questionmark.circle")
                        .font(.caption)
                        .foregroundStyle(Theme.textDim)
                }
                .buttonStyle(.plain)
                .help(L("guide.reopen"))
                .accessibilityLabel(L("guide.reopen"))
                Spacer()
                InboxSelectorMenu()
            }
            // Same two-level hierarchy as the full sidebar (founder
            // 2026-08-20): action lanes as rows, filed lanes as one summary
            // row that opens the full view inside the group.
            let lanes = Tier.sidebarLanes(counts: { model.queue?.summary.count(for: $0) ?? 0 })
            ForEach(lanes.primary) { tier in
                InboxTierRow(tier: tier, count: model.queue?.summary.count(for: tier) ?? 0) {
                    actions.onOpenTier(tier)
                }
            }
            FiledSummaryRow(count: lanes.filedTotal) { actions.onOpenTier(.info) }
            Spacer()
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One glanceable tier count in the expanded panel — clicking opens that tier
/// in the full view. Hover invites the click without shouting at rest.
private struct InboxTierRow: View {
    let tier: Tier
    let count: Int
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Circle().fill(Theme.tint(tier)).frame(width: 7, height: 7)
                Text(tier.label).font(.body).foregroundStyle(Theme.text)
                Spacer()
                Text("\(count)")
                    .font(.body.monospacedDigit().weight(.medium))
                    .foregroundStyle(Theme.textDim)
            }
            .padding(.horizontal, Theme.s2).padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(hovering ? Theme.surfaceHover : .clear, in: RoundedRectangle(cornerRadius: 8))
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

/// The filed-lanes summary in the expanded panel — same chrome as
/// InboxTierRow; opens the full view inside the group (INFO first).
private struct FiledSummaryRow: View {
    let count: Int
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "tray.full").font(.caption2)
                    .foregroundStyle(Theme.textDim).frame(width: 7)
                    .accessibilityHidden(true)
                Text(L("section.filed")).font(.body).foregroundStyle(Theme.textDim)
                Spacer()
                Text("\(count)")
                    .font(.body.monospacedDigit().weight(.medium))
                    .foregroundStyle(Theme.textDim)
            }
            .padding(.horizontal, Theme.s2).padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(hovering ? Theme.surfaceHover : .clear, in: RoundedRectangle(cornerRadius: 8))
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .accessibilityLabel(L("filed.a11y", count))
    }
}

/// Column 2 — the recent PUSH items; click opens that item.
private struct RecentPushColumn: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    private var items: [FirewallItem] { model.queue?.items(for: .push) ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ColumnHeader(title: L("section.recentPush"))
            if SurfaceStateRules.isBlocking(model.surfaceState) {
                // Signed out, offline or failed (M6): never the skeleton.
                SurfaceStateView(state: model.surfaceState, compact: true)
            } else if model.queue == nil {
                FirstSyncState()
            } else if items.isEmpty {
                EmptyState(icon: Tier.push.emptyIcon, title: Tier.push.emptyTitle)
                    .padding(.top, Theme.s6)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.s1) {
                        ForEach(items) { item in
                            RecentPushRow(item: item, actions: actions)
                        }
                    }
                }
            }
            Spacer()
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One PUSH ticker row — the same quiet-at-rest / hover-reveal language as
/// the full-view list, at ticker density.
private struct RecentPushRow: View {
    let item: FirewallItem
    let actions: TopBarActions
    @State private var hovering = false

    private var sender: String { senderDisplayName(item.email?.from.map(decodeHTMLEntities)) }

    var body: some View {
        HStack(spacing: Theme.s2) {
            Button { actions.onOpenInApp(item) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(sender).font(.callout.weight(.semibold))
                        .foregroundStyle(Theme.text).lineLimit(1)
                    Text(decodeHTMLEntities(item.email?.subject ?? item.title)).font(.caption)
                        .foregroundStyle(Theme.text.opacity(0.75)).lineLimit(1)
                    if let reason = rowTierReason(item.tierReason) {
                        Text(reason).font(.caption2).foregroundStyle(Theme.textDim).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            SnoozeMenu(item: item, onSnooze: actions.onSnooze) {
                Image(systemName: "moon.zzz").font(.caption2).iconTarget()
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .foregroundStyle(Theme.textDim)
            .help(L("mail.snooze"))
            .accessibilityLabel(L("mail.snooze.a11y", a11ySenderLabel(item)))
            .opacity(hovering ? 1 : 0)
            Button { actions.onDismiss(item) } label: {
                Image(systemName: "xmark").font(.caption2).iconTarget()
            }
            .buttonStyle(.plain).foregroundStyle(Theme.textDim)
            .help(L("mail.dismiss"))
            .accessibilityLabel(L("mail.dismiss.a11y", a11ySenderLabel(item)))
            .opacity(hovering ? 1 : 0)
        }
        .padding(.horizontal, Theme.s2).padding(.vertical, 6)
        .background(hovering ? Theme.surfaceHover : .clear, in: RoundedRectangle(cornerRadius: 8))
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}
