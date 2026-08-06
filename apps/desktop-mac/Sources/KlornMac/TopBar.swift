import SwiftUI

/// The three sizes the bar can take: a glanceable pill, the compact 3-column
/// panel, and a full "real app" window.
enum BarState { case collapsed, expanded, full }

/// Actions the top bar delegates back to the controller / model.
struct TopBarActions {
    let onExpand: () -> Void        // collapsed → expanded
    let onExpandFull: () -> Void    // expanded → full
    let onRestore: () -> Void       // full → expanded
    let onCollapse: () -> Void      // → collapsed
    /// Close the open panel back to the resting state (pill, or nothing in
    /// hidden-pill mode) — the ✕ in the expanded/full headers.
    let onClose: () -> Void
    let onSignIn: () -> Void
    let onSignOut: () -> Void
    /// Open an item IN-APP: jump to the full view and show it in the reading pane.
    let onOpenInApp: (FirewallItem) -> Void
    /// Open a whole tier IN-APP: jump to the full view with that tier listed.
    let onOpenTier: (Tier) -> Void
    /// Jump to the full view without changing what it is showing.
    let onOpenFull: () -> Void
    /// Jump to the full view's proposals list — the actions awaiting approval.
    let onOpenProposals: () -> Void
    /// Dismiss (archive) an item out of the queue.
    let onDismiss: (FirewallItem) -> Void
    /// Snooze an item to resurface at the chosen time.
    let onSnooze: (FirewallItem, SnoozeOption) -> Void
    /// Tier correction — move an item to a different tier (teaches the judge).
    let onSetTier: (FirewallItem, Tier) -> Void
    /// Select a row in the full view — loads its email into the reading pane.
    let onSelect: (FirewallItem) -> Void
    /// Open the Preferences overlay (switches to the full view first).
    let onOpenPreferences: () -> Void
    /// Hide the bar entirely (pill ✕) — the menu-bar icon takes over as anchor.
    let onHideBar: () -> Void
    let onQuit: () -> Void
}

enum TopBarMetrics {
    static let collapsed = NSSize(width: 400, height: 52)
    static let expanded = NSSize(width: 1140, height: 380)
    static let full = NSSize(width: 1400, height: 860)
    /// Smallest full window the user may drag-resize down to. 880 keeps the
    /// fixed sidebar (220) + list (420) columns with a readable ~240pt
    /// reading pane — the previous 1000×560 floor sat above many fitted
    /// window sizes, which made edge-drag feel dead ("can't shrink it",
    /// 2026-08-07). Floor for the panel's contentMinSize and screen fitting.
    static let fullMin = NSSize(width: 880, height: 520)
    /// Gap kept to the screen edges when the ideal size doesn't fit.
    static let screenMargin: CGFloat = 12
    static let corner: CGFloat = 20

    /// The pill is a TRUE capsule (corner = height/2); panels soften to 20.
    static func corner(for state: BarState) -> CGFloat {
        state == .collapsed ? collapsed.height / 2 : corner
    }

    static func size(for state: BarState) -> NSSize {
        switch state {
        case .collapsed: collapsed
        case .expanded: expanded
        case .full: full
        }
    }

    /// `ideal` shrunk to fit inside `visible` (with a margin), lifted to
    /// `floor` when there is room. The SCREEN clamp wins over the floor: a
    /// window wider than the display is unreachable and clipped, which is
    /// strictly worse than temporarily cramped columns (the old floor-wins
    /// math re-introduced the 13"-clipping this function was added to fix).
    nonisolated static func fittedSize(
        ideal: NSSize, visible: NSSize, floor: NSSize = .zero
    ) -> NSSize {
        let maxW = max(visible.width - screenMargin * 2, 320)
        let maxH = max(visible.height - screenMargin * 2, 240)
        return NSSize(
            width: min(max(floor.width, min(ideal.width, maxW)), maxW),
            height: min(max(floor.height, min(ideal.height, maxH)), maxH))
    }

    /// Top-center placement clamped into the visible rect, so no state can
    /// put any part of the panel off-screen.
    nonisolated static func pinnedFrame(
        size: NSSize, visible: NSRect, topMargin: CGFloat
    ) -> NSRect {
        let x = min(
            max(visible.midX - size.width / 2, visible.minX),
            max(visible.maxX - size.width, visible.minX))
        let y = max(visible.maxY - size.height - topMargin, visible.minY)
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }
}

/// Root that switches between the three states. The controller animates the
/// window frame; this just renders the right content.
struct TopBarRoot: View {
    let state: BarState
    let actions: TopBarActions

    var body: some View {
        Group {
            switch state {
            case .collapsed: CollapsedBar(actions: actions)
            case .expanded: ExpandedPanel(actions: actions)
            case .full: FullView(actions: actions)
            }
        }
        .glassPanel(cornerRadius: TopBarMetrics.corner(for: state))
    }
}

/// Klorn wordmark ring — the small circular logo from the reference bar.
private struct LogoRing: View {
    var size: CGFloat = 16
    var body: some View {
        // The K mark — the app icon in miniature, so pill, panel, menu bar,
        // and Dock all say the same thing: Klorn. Ink on the light panel,
        // matching the B&W brand icon (founder direction 2026-07-20: no orange).
        Text("K")
            .font(.system(size: size * 0.82, weight: .heavy, design: .rounded))
            .foregroundStyle(Theme.text)
            .frame(width: size, height: size)
            .accessibilityHidden(true)  // decorative wordmark mark
    }
}

private extension View {
    /// Enlarge an icon control's hit area to clear WCAG 2.5.8 Target Size (24pt AA;
    /// 28 gives margin) without changing the glyph size. Frame the label content.
    func iconTarget(_ side: CGFloat = 28) -> some View {
        frame(width: side, height: side).contentShape(Rectangle())
    }
}

struct ColumnHeader: View {
    let title: String

    /// Wide tracking is a Latin small-caps device: it makes "RECENT PUSH" read
    /// as a deliberate micro-label rather than a shrunken heading. Hangul
    /// syllable blocks already carry their own internal spacing, so the same
    /// value pulls "최근 PUSH" apart and costs legibility. Tracking is
    /// script-specific; one value was always going to be wrong for one script.
    nonisolated static func tracking(for title: String) -> CGFloat {
        title.contains(where: \.isHangul) ? 0 : 1.4
    }

    var body: some View {
        Text(title).font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Theme.textDim).tracking(Self.tracking(for: title))
    }
}

extension Character {
    /// Hangul syllables, plus the Jamo blocks a decomposed string can carry.
    var isHangul: Bool {
        unicodeScalars.contains { s in
            (0xAC00...0xD7A3).contains(s.value)  // syllables
                || (0x1100...0x11FF).contains(s.value)  // conjoining jamo
                || (0x3130...0x318F).contains(s.value)  // compatibility jamo
        }
    }
}

/// A quiet text action: dim at rest, full text color on hover. The standard
/// for secondary actions (headers, ACCOUNT rows) so emphasis stays reserved
/// for primary content and the accent.
struct SubtleTextButton: View {
    let title: String
    var dim = true
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title).font(.body)
                .foregroundStyle(hovering || !dim ? Theme.text : Theme.textDim)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

/// Sidebar nav row chrome: the same selection language as list rows — accent
/// leading bar + the surface ladder's selected rung; hover uses the hover rung.
/// One modifier so every nav row (tiers, Commitments, Assistant) stays in sync.
struct SidebarRowChrome: ViewModifier {
    let selected: Bool
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(alignment: .leading) {
                if selected {
                    RoundedRectangle(cornerRadius: 1.5).fill(Theme.accent)
                        .frame(width: 3).padding(.vertical, 5)
                }
            }
            .background(
                selected ? Theme.surfaceSelected : hovering ? Theme.surfaceHover : .clear,
                in: RoundedRectangle(cornerRadius: 8))
            .onHover { hovering = $0 }
    }
}

/// A snooze control that pops the option list. Shared by every snooze site so the
/// choices stay identical; the caller supplies the label (icon vs. text button).
private struct SnoozeMenu<Label: View>: View {
    let item: FirewallItem
    let onSnooze: (FirewallItem, SnoozeOption) -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        Menu {
            ForEach(SnoozeOption.allCases) { option in
                Button(option.label) { onSnooze(item, option) }
            }
        } label: { label() }
    }
}

/// Tier-correction control: pick the tier this item SHOULD be. Shared by the
/// list row (dot) and the reading pane (text button). The current tier shows a
/// checkmark; picking another calls onSetTier — the correction persists via the
/// override endpoint and (≥2 identical for a sender) trains future triage.
private struct TierMenu<Label: View>: View {
    let item: FirewallItem
    let onSetTier: (FirewallItem, Tier) -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        Menu {
            ForEach(Tier.displayOrder) { tier in
                Button {
                    onSetTier(item, tier)
                } label: {
                    HStack {
                        Text(tier.label)
                        if tier == item.tier { Image(systemName: "checkmark") }
                    }
                }
                .disabled(tier == item.tier)
            }
        } label: { label() }
    }
}

// MARK: - Collapsed

/// Collapsed pill: always visible at the top, glanceable state.
struct CollapsedBar: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    private var pushCount: Int { model.queue?.summary.push ?? 0 }

    var body: some View {
        HStack(spacing: 12) {
            Button(action: actions.onExpand) {
                Image(systemName: "line.3.horizontal").font(.body.weight(.medium)).iconTarget(30)
            }
            .buttonStyle(.plain).foregroundStyle(Theme.text)
            .focusEffectDisabled()  // the default ring reads as an artifact on the capsule
            .help(L("bar.expand"))
            .accessibilityLabel(L("bar.expand.a11y"))

            LogoRing()
            Text("Klorn").font(.system(.callout, design: .rounded).weight(.bold)).foregroundStyle(Theme.text)

            Spacer()

            switch model.phase {
            case .signedIn:
                if pushCount > 0 {
                    // The one loud element Klorn allows itself: a glowing
                    // signal dot + tinted chip. Everything else stays quiet
                    // so this is unmissable at a glance.
                    HStack(spacing: 5) {
                        Circle().fill(Theme.tint(.push)).frame(width: 7, height: 7)
                            .shadow(color: Theme.tint(.push).opacity(0.8), radius: 3)
                        Text(L("bar.push", pushCount))
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(Theme.text)
                    }
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Theme.tint(.push).opacity(0.12), in: Capsule())
                } else if model.loadError != nil {
                    HStack(spacing: 5) {
                        Circle().fill(Theme.tint(.push).opacity(0.7)).frame(width: 6, height: 6)
                        Text(L("bar.offline")).font(.caption)
                    }
                    .foregroundStyle(Theme.textDim)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Theme.surfaceRaised, in: Capsule())
                } else {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark").font(.caption2.weight(.semibold))
                            .accessibilityHidden(true)
                        Text(L("bar.allClear")).font(.caption)
                    }
                    .foregroundStyle(Theme.textDim)
                }
            case .signingIn:
                Text(L("bar.signingIn")).font(.caption).foregroundStyle(Theme.textDim)
            case .signedOut:
                Button(L("auth.logIn"), action: actions.onSignIn)
                    .buttonStyle(PrimaryButtonStyle())
            }

            Button(action: actions.onHideBar) {
                Image(systemName: "xmark").font(.caption.weight(.semibold)).iconTarget(30)
            }
            .buttonStyle(.plain).hoverDim()
            .focusEffectDisabled()
            .help(L("bar.hide"))
            .accessibilityLabel(L("bar.hide.a11y"))
        }
        .padding(.leading, 18).padding(.trailing, 16)
        .frame(width: TopBarMetrics.collapsed.width, height: TopBarMetrics.collapsed.height)
    }
}

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
            if let briefing = model.briefing {
                BriefingCard(briefing: briefing) { actions.onOpenFull() }
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
            if event.meetingLink != nil {
                Image(systemName: "video").font(.caption).foregroundStyle(Theme.textDim)
                    .accessibilityHidden(true)
            }
        }
        if let link = event.meetingLink, let url = URL(string: link) {
            Button { NSWorkspace.shared.open(url) } label: { row }
                .buttonStyle(.plain)
                .accessibilityLabel(L("calendar.join.a11y", event.title))
        } else {
            row.accessibilityElement(children: .combine)
        }
    }
}

/// BRIEFING preview card — the day's AI briefing. One view shared by the
/// compact panel's TodayColumn and the full-mode sidebar so both surfaces
/// render the same card (dogfood 2026-07-23). Clicking opens the full view,
/// which is where the day is actually worked.
private struct BriefingCard: View {
    let briefing: String
    let onOpen: () -> Void

    var body: some View {
        Button { onOpen() } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Image(systemName: "sun.max").font(.caption2).foregroundStyle(Theme.accent)
                        .accessibilityHidden(true)
                    Text(L("section.briefing")).font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
                }
                Text(briefing).font(.caption).foregroundStyle(Theme.text)
                    .lineLimit(3).multilineTextAlignment(.leading)
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
        .accessibilityLabel(L("briefing.a11y", briefing))
    }
}

/// UPCOMING — tomorrow through the next 7 days, grouped by day (calendar
/// parity with the web: the desktop must not know less about the week
/// than it knows about the day). Rows open a detail popover. Shared by the
/// compact panel's TodayColumn and the full-mode sidebar — same view, same
/// `model.weekAhead` + `upcomingAgenda` data path.
private struct UpcomingSection: View {
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

/// One UPCOMING row: start time + title, quiet at rest. Click opens a
/// lightweight detail popover (title / time / location, Join when there's a
/// meeting link) with "Open in Klorn" → the full view, which carries today and
/// the week ahead.
private struct UpcomingEventRow: View {
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
                }
                Spacer(minLength: 0)
                if event.meetingLink != nil {
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
        .popover(isPresented: $showDetail, arrowEdge: .trailing) { detail }
    }

    private var detail: some View {
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
            HStack(spacing: 8) {
                if let link = event.meetingLink, let url = URL(string: link) {
                    Button(L("calendar.join")) { NSWorkspace.shared.open(url) }
                        .buttonStyle(PrimaryButtonStyle())
                        .accessibilityLabel(L("calendar.join.a11y", event.title))
                }
                Button(L("calendar.openInKlorn")) { actions.onOpenFull() }
                .buttonStyle(.bordered).controlSize(.small)
            }
            .padding(.top, 4)
        }
        .padding(Theme.s4)
        .frame(width: 250, alignment: .leading)
    }
}

/// Per-inbox scope selector (web parity: email/page.tsx InboxSelector) —
/// rendered only when the account actually has 2+ mailboxes. Values: "all",
/// "primary", or a linked inbox id; addresses come straight from the API,
/// never hardcoded. Selecting re-scopes the mail list end-to-end.
struct InboxSelectorMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.inboxes.count >= 2 {
            let current = inboxSelectorLabel(selected: model.selectedInbox, inboxes: model.inboxes)
            Menu {
                row(value: "all", label: L("mail.allInboxes"), needsReconnect: false)
                ForEach(model.inboxes) { inbox in
                    row(value: inbox.selectionValue,
                        label: inboxDisplayLabel(email: inbox.email, kind: inbox.kind),
                        needsReconnect: inbox.needsReconnect)
                }
                if model.inboxes.contains(where: \.needsReconnect) {
                    Divider()
                    // Re-runs the link-inbox consent; the server upserts the
                    // re-linked account, which clears needsReconnect.
                    Button(L("account.reconnect")) { Task { await model.addAccount() } }
                }
            } label: {
                // Chevron lives INSIDE the one Text (concatenation) — a
                // separate Image in a menu label is reordered to the leading
                // edge by the label styling (screen-verified 0.4.80007).
                (Text(current + " ")
                    + Text(Image(systemName: "chevron.down"))
                    .font(.caption2.weight(.semibold)))
                    .font(.caption)
                    .foregroundStyle(Theme.textDim)
                    .lineLimit(1)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .help(L("mail.filterByInbox"))
            .accessibilityLabel(L("mail.filterByInbox.a11y", current))
        }
    }

    private func row(value: String, label: String, needsReconnect: Bool) -> some View {
        Button {
            model.selectInbox(value)
        } label: {
            HStack {
                // Text suffix, not the web's sky dot: the AppKit borderless
                // menu drops SwiftUI shapes and renders symbols colorless
                // (see the tier-dot note on FullRow) — words keep the
                // reconnect signal perceivable, and color-independent.
                Text(needsReconnect ? L("mail.needsReconnect", label) : label)
                if value == model.selectedInbox { Image(systemName: "checkmark") }
            }
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
                Spacer()
                InboxSelectorMenu()
            }
            ForEach(Tier.displayOrder) { tier in
                InboxTierRow(tier: tier, count: model.queue?.summary.count(for: tier) ?? 0) {
                    actions.onOpenTier(tier)
                }
            }
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

/// Column 2 — the recent PUSH items; click opens that item.
private struct RecentPushColumn: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    private var items: [FirewallItem] { model.queue?.items(for: .push) ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ColumnHeader(title: L("section.recentPush"))
            if items.isEmpty {
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
            .accessibilityLabel(L("mail.snooze.a11y", sender))
            .opacity(hovering ? 1 : 0)
            Button { actions.onDismiss(item) } label: {
                Image(systemName: "xmark").font(.caption2).iconTarget()
            }
            .buttonStyle(.plain).foregroundStyle(Theme.textDim)
            .help(L("mail.dismiss"))
            .accessibilityLabel(L("mail.dismiss.a11y", sender))
            .opacity(hovering ? 1 : 0)
        }
        .padding(.horizontal, Theme.s2).padding(.vertical, 6)
        .background(hovering ? Theme.surfaceHover : .clear, in: RoundedRectangle(cornerRadius: 8))
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

/// Column 3 — account + resources.
private struct AccountColumn: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions
    @State private var updating = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ColumnHeader(title: L("prefs.section.account"))
            if model.phase == .signedIn {
                if let version = model.updateAvailable {
                    UpdateRow(version: version)
                }
                SubtleTextButton(title: L("prefs.account.signOut")) { actions.onSignOut() }
                SubtleTextButton(title: L("account.add")) { Task { await model.addAccount() } }
                if let error = model.linkAccountError {
                    Text(error).font(.caption2).foregroundStyle(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                SubtleTextButton(title: L("auth.signInGoogle"), dim: false) { actions.onSignIn() }
            }
            if model.phase == .signedIn, let usage = model.usage {
                VStack(alignment: .leading, spacing: 5) {
                    Text(L("section.aiToday")).font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.surfaceHover)
                            Capsule()
                                .fill(LinearGradient(
                                    colors: [Theme.accent, Theme.accentDeep],
                                    startPoint: .leading, endPoint: .trailing))
                                .frame(width: geo.size.width
                                       * usageFillFraction(used: usage.dailyUsed, cap: usage.dailyCap))
                        }
                    }
                    .frame(height: 5)
                    Text(usageLabel(used: usage.dailyUsed, cap: usage.dailyCap))
                        .font(.caption2.monospacedDigit()).foregroundStyle(Theme.textDim)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(L("aiUsage.a11y", usage.dailyUsed, usage.dailyCap))
                .padding(.top, 4)
            }

            SubtleTextButton(title: L("prefs.title")) { actions.onOpenPreferences() }
            SubtleTextButton(title: L("menu.quit")) { actions.onQuit() }
            Spacer()
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Full ("real app" window)

/// The largest state: a tier sidebar + a big scrollable list of the selected
/// tier — a real desktop-app view of the whole firewall.
/// What the full view's list column shows: a firewall tier, commitments, or
/// the assistant chat.
enum ListMode: Equatable {
    case tier(Tier)
    case commitments
    case assistant
    /// Actions Klorn wants approved. Approving these used to require the web
    /// app, which is what kept the agent receipt linking out of Klorn.
    case proposals
}

struct FullView: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    var body: some View {
        // The list mode lives on the model, not in @State: opening the full
        // view from somewhere else — a tier count in the compact panel, an
        // urgent-mail card — has to be able to say which tier to land on.
        @Bindable var model = model

        ZStack {
            // Sky behind everything. The header sits directly on it so the view
            // opens on air rather than on a toolbar; the working columns get a
            // translucent panel so running text never lands on a gradient.
            AmbientBackdrop()
            VStack(spacing: 0) {
                // Chrome floats directly on the sky, the way the reference's
                // nav pill does — the window opens on air, not on a toolbar.
                header
                // The working columns are one card lifted off that sky. The
                // inset is the whole point: without a margin the panel is just
                // an opaque page and the backdrop may as well not exist.
                HStack(spacing: 0) {
                    FullSidebar(selected: $model.listMode, actions: actions).frame(width: 220)
                    Rectangle().fill(Theme.line).frame(width: 1)
                    FullList(mode: model.listMode, actions: actions).frame(width: 420)
                    Rectangle().fill(Theme.line).frame(width: 1)
                    ReadingPane(actions: actions).frame(maxWidth: .infinity)
                }
                .background(Theme.panelGradient(opacity: 0.90))
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.line))
                .shadow(color: Theme.panelShadow.opacity(0.5), radius: 20, y: 6)
                .padding(.horizontal, 14)
                .padding(.bottom, 14)
            }
            .onAppear { model.presentTierGuideIfFirstRun() }
            if model.showPreferences {
                // Scrim: click-off dismiss (a11y users use the Done button instead).
                // Slate-navy tint, not pure black — matches the light theme.
                Theme.text.opacity(0.45)
                    .onTapGesture { model.showPreferences = false }
                    .accessibilityHidden(true)
                PreferencesView(actions: actions)
            }
            // Preferences wins if both are up: the guide is ambient explanation,
            // a settings panel is something the user just asked for.
            if model.showTierGuide && !model.showPreferences {
                Theme.text.opacity(0.45)
                    .onTapGesture { model.dismissTierGuide() }
                    .accessibilityHidden(true)
                TierGuide { model.dismissTierGuide() }
            }
        }
        // Fill whatever frame the controller fitted to the screen (and the
        // user's drag-resize); the old fixed 1400×860 clipped on smaller
        // displays instead of compressing.
        .frame(
            minWidth: TopBarMetrics.fullMin.width, maxWidth: .infinity,
            minHeight: TopBarMetrics.fullMin.height, maxHeight: .infinity)
    }

    private var header: some View {
        HStack(spacing: 14) {
            Button(action: actions.onRestore) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.down.right.and.arrow.up.left").font(.callout).accessibilityHidden(true)
                    Text(L("bar.smaller")).font(.callout)
                }
            }
            .buttonStyle(.plain).hoverDim()
            .help(L("bar.smaller.help"))
            // The old "—" (collapse-to-rest) duplicated the header ✕ — gone.

            Spacer()
            HStack(spacing: 8) {
                LogoRing(size: 20)
                Text("Klorn").font(.system(.title3, design: .rounded).weight(.bold)).foregroundStyle(Theme.text)
            }
            Spacer()

            // Sign-out lives in the sidebar's account area, not here — one
            // way out per surface, and never beside the ✕. Log In stays: it is
            // the whole point of the header when signed out.
            if model.phase == .signedOut {
                Button(L("auth.logIn"), action: actions.onSignIn)
                    .buttonStyle(PrimaryButtonStyle())
            }

            // One click OUT from anywhere (dogfood 2026-07-20).
            Button(action: actions.onClose) {
                Image(systemName: "xmark").font(.callout.weight(.semibold)).iconTarget()
            }
            .buttonStyle(.plain).hoverDim()
            .padding(.leading, 6)
            .help(L("bar.close"))
            .accessibilityLabel(L("bar.close.a11y"))
        }
        // Chrome carries its own light surface instead of sitting bare on the
        // sky. Two reasons, and the accessibility one is the binding constraint:
        // secondary labels are slate-500, which clears 4.5:1 on the near-white
        // panel but not on the gradient's darker top, and a floating bar with
        // its own ground is also what the reference does with its nav.
        .padding(.horizontal, 18)
        .frame(height: 48)
        .background(Theme.panelGradient(opacity: 0.92), in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.line))
        .shadow(color: Theme.panelShadow.opacity(0.35), radius: 14, y: 4)
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 12)
    }
}

private struct FullSidebar: View {
    @Environment(AppModel.self) private var model
    @Binding var selected: ListMode
    let actions: TopBarActions

    /// Compact event row for the 220pt sidebar: NOW badge or start time,
    /// title, and a click-through to the meeting link when present.
    @ViewBuilder
    private func sidebarEventRow(_ event: CalendarEventWire, isNow: Bool) -> some View {
        let time = eventTimeLabel(
            startISO: event.startTime, endISO: event.endTime, allDay: event.allDay)
        let row = HStack(alignment: .top, spacing: 8) {
            if isNow {
                Text(L("section.now")).font(.caption2.weight(.bold)).foregroundStyle(Theme.accent)
            } else {
                Text(String(time.prefix(5)))
                    .font(.caption.monospacedDigit()).foregroundStyle(Theme.textDim)
            }
            Text(event.title).font(.caption).foregroundStyle(Theme.text).lineLimit(1)
            Spacer(minLength: 0)
            if event.meetingLink != nil {
                Image(systemName: "video").font(.caption2).foregroundStyle(Theme.textDim)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 3)
        if let link = event.meetingLink, let url = URL(string: link) {
            Button { NSWorkspace.shared.open(url) } label: { row }
                .buttonStyle(.plain)
                .accessibilityLabel(L("calendar.join.a11y", event.title))
        } else {
            row.accessibilityElement(children: .combine)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                ColumnHeader(title: L("section.inbox"))
                Spacer()
                InboxSelectorMenu()
            }
            .padding(.horizontal, 20).padding(.bottom, 6)
            ForEach(Tier.displayOrder) { tier in
                Button { selected = .tier(tier) } label: {
                    HStack(spacing: 10) {
                        Circle().fill(Theme.tint(tier)).frame(width: 8, height: 8)
                        Text(tier.label)
                            .font(.body.weight(selected == .tier(tier) ? .semibold : .regular))
                            .foregroundStyle(Theme.text)
                        Spacer()
                        Text("\(model.queue?.summary.count(for: tier) ?? 0)")
                            .font(.body.monospacedDigit()).foregroundStyle(Theme.textDim)
                    }
                    .modifier(SidebarRowChrome(selected: selected == .tier(tier)))
                }
                .buttonStyle(.plain)
                .help(tier.blurb)
                .accessibilityLabel(
                    L("tier.row.a11y", tier.label, model.queue?.summary.count(for: tier) ?? 0, tier.blurb))
            }

            // Commitments: promises made / replies awaited — the follow-through
            // half of the firewall (what mail asked of you, and of them).
            Button { selected = .commitments } label: {
                HStack(spacing: 10) {
                    Image(systemName: "checklist").font(.caption)
                        .foregroundStyle(Theme.accent).frame(width: 8)
                        .accessibilityHidden(true)
                    Text(L("section.commitments"))
                        .font(.body.weight(selected == .commitments ? .semibold : .regular))
                        .foregroundStyle(Theme.text)
                    Spacer()
                    Text("\(model.commitments?.count ?? 0)")
                        .font(.body.monospacedDigit()).foregroundStyle(Theme.textDim)
                }
                .modifier(SidebarRowChrome(selected: selected == .commitments))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L("commitments.a11y", model.commitments?.count ?? 0))

            // Proposals: what Klorn wants to do and hasn't done yet.
            Button { selected = .proposals } label: {
                HStack(spacing: 10) {
                    Image(systemName: "hand.raised").font(.caption)
                        .foregroundStyle(Theme.accent).frame(width: 8)
                        .accessibilityHidden(true)
                    Text(L("proposals.title"))
                        .font(.body.weight(selected == .proposals ? .semibold : .regular))
                        .foregroundStyle(Theme.text)
                    Spacer()
                    Text("\(model.pendingActions.count)")
                        .font(.body.monospacedDigit()).foregroundStyle(Theme.textDim)
                }
                .modifier(SidebarRowChrome(selected: selected == .proposals))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L("proposals.a11y", model.pendingActions.count))

            // Assistant: ask/act across mail, calendar, and the briefing.
            Button { selected = .assistant } label: {
                HStack(spacing: 10) {
                    Image(systemName: "sparkles").font(.caption)
                        .foregroundStyle(Theme.accent).frame(width: 8)
                        .accessibilityHidden(true)
                    Text(L("section.assistant"))
                        .font(.body.weight(selected == .assistant ? .semibold : .regular))
                        .foregroundStyle(Theme.text)
                    Spacer()
                }
                .modifier(SidebarRowChrome(selected: selected == .assistant))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L("section.assistant"))

            // TODAY lives in the full view too — the biggest surface must not
            // know less about the day than the compact panel (dogfood 2026-07-16).
            // Briefing + today + UPCOMING mirror the panel's TodayColumn (same
            // shared views, dogfood 2026-07-23); scrollable so a busy week never
            // pushes ACCOUNT off the sidebar.
            // Only label the section when it has something in it. An empty
            // "TODAY" heading over 300pt of nothing reads as a broken pane, not
            // as a calm one.
            let hasToday = model.briefing != nil || (model.today?.total ?? 0) > 0
            if hasToday {
                ColumnHeader(title: L("section.todayShort"))
                    .padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 6)
            }
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 8) {
                    if let briefing = model.briefing {
                        BriefingCard(briefing: briefing) { actions.onOpenFull() }.padding(.horizontal, 12)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        if let today = model.today, today.total > 0 {
                            if let current = today.current {
                                sidebarEventRow(current, isNow: true)
                            }
                            ForEach(today.upcoming.prefix(3)) { event in
                                sidebarEventRow(event, isNow: false)
                            }
                            if today.upcoming.count > 3 {
                                Text(L("bar.more", today.upcoming.count - 3))
                                    .font(.caption2).foregroundStyle(Theme.textDim)
                                    .padding(.horizontal, 20)
                            }
                        } else if model.today == nil {
                            Text(L("bar.loading"))
                                .font(.caption).foregroundStyle(Theme.textDim)
                                .padding(.horizontal, 20)
                        }
                    }
                    UpcomingSection(actions: actions).padding(.horizontal, 12)
                }
                .padding(.bottom, 8)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

            ColumnHeader(title: L("prefs.section.account")).padding(.horizontal, 20).padding(.bottom, 6)
            if model.phase == .signedIn {
                if let version = model.updateAvailable {
                    UpdateRow(version: version)
                }
                sidebarAction(L("prefs.account.signOut"), dim: true) { actions.onSignOut() }
                sidebarAction(L("account.add"), dim: true) { Task { await model.addAccount() } }
                if let error = model.linkAccountError {
                    Text(error).font(.caption2).foregroundStyle(Theme.textDim)
                        .padding(.horizontal, 20)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                sidebarAction(L("auth.signInGoogle")) { actions.onSignIn() }
            }
            sidebarAction(L("guide.reopen"), dim: true) { model.showTierGuide = true }
            sidebarAction(L("prefs.title"), dim: true) { model.showPreferences = true }
        }
        .padding(.horizontal, 8).padding(.vertical, 18)
    }

    private func sidebarAction(_ title: String, dim: Bool = false, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(title).font(.body).foregroundStyle(dim ? Theme.textDim : Theme.text)
                .padding(.horizontal, 12).padding(.vertical, 5)
                .frame(maxWidth: .infinity, alignment: .leading)
        }.buttonStyle(.plain)
    }
}

private struct FullList: View {
    @Environment(AppModel.self) private var model
    let mode: ListMode
    let actions: TopBarActions
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    private var tier: Tier {
        if case .tier(let t) = mode { return t }
        return .push
    }
    private var items: [FirewallItem] { model.queue?.items(for: tier) ?? [] }
    private var searching: Bool { isSearchActive(query) }

    var body: some View {
        switch mode {
        case .commitments: CommitmentsList()
        case .assistant: AssistantColumn()
        case .proposals: ProposalsList()
        case .tier: tierList
        }
    }

    private var tierList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if searching {
                    Image(systemName: "magnifyingglass").font(.body).foregroundStyle(Theme.accent)
                        .accessibilityHidden(true)
                    Text(L("section.search")).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                    Text("\(model.searchTotal)")
                        .font(.title3.monospacedDigit()).foregroundStyle(Theme.textDim)
                } else {
                    Circle().fill(Theme.tint(tier)).frame(width: 9, height: 9)
                    Text(tier.label).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                    Text("\(items.count)").font(.title3.monospacedDigit()).foregroundStyle(Theme.textDim)
                }
            }
            .padding(.horizontal, 24).padding(.vertical, 18)

            // Whole-mailbox search (same endpoint as the web inbox). Debounced;
            // clearing the field returns to the tier list instantly.
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.caption).foregroundStyle(Theme.textDim)
                    .accessibilityHidden(true)
                if Theme.isRenderingOffscreen {
                    Text(L("mail.searchPlaceholder"))
                        .font(.callout).foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                TextField(L("mail.searchPlaceholder"), text: $query)
                    .opacity(Theme.isRenderingOffscreen ? 0 : 1)
                    .textFieldStyle(.plain).font(.callout).foregroundStyle(Theme.text)
                    .focused($searchFocused)
                    .accessibilityLabel(L("mail.search.a11y"))
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: { Image(systemName: "xmark.circle.fill").font(.caption) }
                        .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                        .accessibilityLabel(L("mail.clearSearch.a11y"))
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8)
                .strokeBorder(searchFocused ? Theme.accent.opacity(0.5) : .clear))
            .padding(.horizontal, 24).padding(.bottom, 12)
            .task(id: "\(model.selectedInbox)|\(query)") {
                // Keyed on scope + query: an inbox switch re-fetches an active
                // search with the new scope, same debounce path.
                // 300ms debounce: only the last keystroke's task survives.
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                await model.search(query)
            }

            Divider().overlay(Theme.line)

            if searching {
                searchResultsList
            } else if items.isEmpty {
                Spacer()
                EmptyState(icon: tier.emptyIcon, title: tier.emptyTitle, hint: tier.blurb)
                Spacer()
            } else if Theme.isRenderingOffscreen {
                // ImageRenderer draws nothing inside a ScrollView, so the full
                // view rendered its mail column empty — a screenshot of the app
                // looking broken, which is what shipped to the landing page.
                // Same workaround already used for the rows and preferences
                // shots: lay the rows out directly when rendering offscreen.
                VStack(spacing: 0) {
                    ForEach(items) { item in
                        FullRow(item: item, actions: actions)
                        Divider().overlay(Theme.line).padding(.leading, 24)
                    }
                    Spacer(minLength: 0)
                }
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(items) { item in
                            FullRow(item: item, actions: actions)
                            Divider().overlay(Theme.line).padding(.leading, 24)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var searchResultsList: some View {
        if model.isSearching && model.searchResults == nil {
            Spacer()
            ProgressView().controlSize(.small).frame(maxWidth: .infinity)
            Spacer()
        } else if let results = model.searchResults, !results.isEmpty {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(results) { hit in
                        SearchHitRow(hit: hit)
                        Divider().overlay(Theme.line).padding(.leading, 24)
                    }
                }
            }
        } else {
            Spacer()
            EmptyState(
                icon: "magnifyingglass",
                title: {
                    let q = query.trimmingCharacters(in: .whitespaces)
                    return L("mail.noMatches", q, L10n.josaWaIfKorean(after: q))
                }())
            Spacer()
        }
    }
}

/// The assistant column: an in-session thread with the mail/calendar agent.
/// Synchronous turns (the API returns the full reply); the composer disables
/// while a turn is in flight. Never steals focus — lives in the key-able full
/// view like the reply composer.
private struct AssistantColumn: View {
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles").font(.body).foregroundStyle(Theme.accent)
                    .accessibilityHidden(true)
                Text(L("section.assistant")).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
            }
            .padding(.horizontal, 24).padding(.vertical, 18)
            Divider().overlay(Theme.line)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if model.chatMessages.isEmpty {
                            VStack(spacing: Theme.s4) {
                                EmptyState(
                                    icon: "sparkles",
                                    title: L("assistant.empty"))
                                // One-click starters: discoverability beats a
                                // blank prompt. Each sends immediately.
                                VStack(spacing: Theme.s2) {
                                    ForEach([
                                        "오늘 제일 중요한 메일 뭐야?",
                                        "답장 안 한 것 중 급한 것만 알려줘",
                                        "이번 주 미팅 준비할 것 정리해줘",
                                    ], id: \.self) { suggestion in
                                        Button {
                                            Task { await model.sendChat(suggestion) }
                                        } label: {
                                            Text(suggestion)
                                                .font(.caption).foregroundStyle(Theme.text)
                                                .padding(.horizontal, Theme.s3)
                                                .padding(.vertical, Theme.s2)
                                                .background(Theme.surfaceRaised, in: Capsule())
                                                .overlay(Capsule().strokeBorder(Theme.line))
                                        }
                                        .buttonStyle(.plain)
                                        .disabled(model.isChatting)
                                    }
                                }
                            }
                            .padding(.top, Theme.s6)
                        }
                        ForEach(model.chatMessages) { message in
                            ChatBubble(message: message)
                        }
                        if model.isChatting {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text(L("assistant.thinking")).font(.caption).foregroundStyle(Theme.textDim)
                            }
                            .padding(.horizontal, 16)
                        }
                        Color.clear.frame(height: 1).id("chat-bottom")
                    }
                    .padding(.vertical, 12)
                }
                .onChange(of: model.chatMessages) { _, _ in
                    withAnimation { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                }
            }

            HStack(spacing: Theme.s2) {
                TextField(L("assistant.placeholder"), text: $draft, axis: .vertical)
                    .textFieldStyle(.plain).font(.callout).foregroundStyle(Theme.text)
                    .lineLimit(1...4)
                    .focused($composerFocused)
                    .onSubmit { send() }
                    .accessibilityLabel(L("assistant.placeholder.a11y"))
                Button { send() } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .buttonStyle(.plain)
                .foregroundStyle(canSendChat(draft, busy: model.isChatting) ? Theme.accent : Theme.textDim)
                .disabled(!canSendChat(draft, busy: model.isChatting))
                .accessibilityLabel(L("assistant.send.a11y"))
            }
            .padding(.horizontal, Theme.s3).padding(.vertical, 10)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12)
                .strokeBorder(composerFocused ? Theme.accent.opacity(0.5) : Theme.field))
            .padding(.horizontal, Theme.s4).padding(.vertical, Theme.s3)
        }
        .onAppear { composerFocused = true }
    }

    private func send() {
        let text = draft
        guard canSendChat(text, busy: model.isChatting) else { return }
        draft = ""
        Task { await model.sendChat(text) }
    }
}

private struct ChatBubble: View {
    @Environment(AppModel.self) private var model
    let message: ChatMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                if message.role == .user { Spacer(minLength: 40) }
                // Assistant replies carry markdown (**bold** rendered literally
                // on screen, design audit 2026-07-20); user/failure text stays raw.
                (message.role == .assistant
                    ? Text(chatMarkdown(message.text)) : Text(message.text))
                    .font(.callout)
                    .foregroundStyle(message.role == .failure ? Theme.accent : Theme.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(
                        message.role == .user ? Theme.surfaceSelected : Theme.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: 10))
                if message.role != .user { Spacer(minLength: 40) }
            }
            .accessibilityLabel(
                message.role == .user ? "You said: \(message.text)"
                    : message.role == .failure ? "Error: \(message.text)"
                    : "Klorn replied: \(message.text)")

            // Agent-drafted event: nothing is written until the user clicks.
            if let draft = message.eventDraft {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: "calendar.badge.plus").font(.caption)
                            .foregroundStyle(Theme.accent).accessibilityHidden(true)
                        Text(eventDraftLabel(draft))
                            .font(.caption).foregroundStyle(Theme.text).lineLimit(2)
                    }
                    HStack(spacing: 8) {
                        Button(L("calendar.addToCalendar")) {
                            Task { await model.createEvent(from: draft, messageId: message.id) }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        Button(L("calendar.ignore")) { model.clearEventDraft(message.id) }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                }
                .padding(10)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line))
                .accessibilityElement(children: .contain)
                .accessibilityLabel(L("calendar.proposed.a11y", eventDraftLabel(draft)))
            }
        }
        .padding(.horizontal, 16)
    }
}

/// The commitments column: WAITING ON (their promises to you) above I OWE
/// (your promises to them). ✓ marks done, ✕ dismisses — both optimistic.
private struct CommitmentsList: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let groups = commitmentGroups(model.commitments ?? [])
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "checklist").font(.body).foregroundStyle(Theme.accent)
                    .accessibilityHidden(true)
                Text(L("section.commitments")).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                Text("\(model.commitments?.count ?? 0)")
                    .font(.title3.monospacedDigit()).foregroundStyle(Theme.textDim)
            }
            .padding(.horizontal, 24).padding(.vertical, 18)
            Divider().overlay(Theme.line)

            if model.commitments == nil {
                Spacer()
                if model.commitmentsFailed {
                    Text(L("commitments.loadFailed"))
                        .font(.callout).foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity).multilineTextAlignment(.center)
                } else {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                }
                Spacer()
            } else if groups.waitingOn.isEmpty && groups.iOwe.isEmpty {
                Spacer()
                Text(L("commitments.empty")).font(.title3).foregroundStyle(Theme.textDim)
                    .frame(maxWidth: .infinity)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if !groups.waitingOn.isEmpty {
                            ColumnHeader(title: L("section.waitingOn"))
                                .padding(.horizontal, 24).padding(.top, 14).padding(.bottom, 4)
                            ForEach(groups.waitingOn) { CommitmentRow(item: $0) }
                        }
                        if !groups.iOwe.isEmpty {
                            ColumnHeader(title: L("section.iOwe"))
                                .padding(.horizontal, 24).padding(.top, 14).padding(.bottom, 4)
                            ForEach(groups.iOwe) { CommitmentRow(item: $0) }
                        }
                    }
                    .padding(.bottom, 14)
                }
            }
        }
    }
}

private struct CommitmentRow: View {
    @Environment(AppModel.self) private var model
    let item: CommitmentItem
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(decodeHTMLEntities(item.title))
                    .font(.callout).foregroundStyle(Theme.text).lineLimit(2)
                HStack(spacing: 6) {
                    if let who = item.counterpartyLabel {
                        Text(who).font(.caption).foregroundStyle(Theme.textDim).lineLimit(1)
                    }
                    if let due = item.dueText, !due.isEmpty {
                        Text(due).font(.caption).foregroundStyle(Theme.accent)
                    }
                }
            }
            Spacer(minLength: 0)
            // Same hover-reveal language as the mail rows: quiet at rest.
            Button {
                Task { await model.resolveCommitment(item, as: "DONE") }
            } label: { Image(systemName: "checkmark").iconTarget() }
                .buttonStyle(.plain).foregroundStyle(Theme.textDim).help(L("commitments.markDone"))
                .accessibilityLabel(L("commitments.markDone.a11y", item.title))
                .opacity(hovering ? 1 : 0)
            Button {
                Task { await model.resolveCommitment(item, as: "DISMISSED") }
            } label: { Image(systemName: "xmark").iconTarget() }
                .buttonStyle(.plain).foregroundStyle(Theme.textDim).help(L("mail.dismiss"))
                .accessibilityLabel(L("commitments.dismiss.a11y", item.title))
                .opacity(hovering ? 1 : 0)
        }
        .padding(.horizontal, 24).padding(.vertical, 8)
        .background(hovering ? Theme.surfaceHover : .clear)
        .onHover { hovering = $0 }
    }
}

/// One whole-mailbox search hit: sender, subject, snippet. Click loads the
/// reading pane (read-only surface — firewall actions live on tier rows).
private struct SearchHitRow: View {
    @Environment(AppModel.self) private var model
    let hit: EmailSearchItem

    private var selected: Bool { model.selectedItemId == hit.id }
    private var sender: String {
        let name = senderDisplayName(hit.from.map(decodeHTMLEntities))
        return name.isEmpty ? L("mail.unknownSender") : name
    }
    @State private var hovering = false

    var body: some View {
        Button {
            Task { await model.selectSearchResult(hit) }
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(sender).font(.callout.weight(hit.isRead == false ? .semibold : .regular))
                        .foregroundStyle(Theme.text).lineLimit(1)
                    // Which mailbox this message lives on — only when the
                    // account actually has several (single-inbox stays quiet).
                    if let badge = inboxRowBadge(
                        linkedId: hit.linkedInboxAccountId, inboxes: model.inboxes)
                    {
                        Text(badge).font(.caption2).foregroundStyle(Theme.textDim)
                            .lineLimit(1)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Theme.surfaceRaised, in: Capsule())
                            .accessibilityLabel(L("mail.inbox.a11y", badge))
                    }
                    Spacer(minLength: 0)
                    if let date = hit.date {
                        Text(String(date.prefix(10)))
                            .font(.caption2.monospacedDigit()).foregroundStyle(Theme.textDim)
                    }
                }
                Text(hit.subject ?? L("mail.noSubjectParen"))
                    .font(.callout).foregroundStyle(Theme.text.opacity(0.9)).lineLimit(1)
                if let snippet = hit.snippet, !snippet.isEmpty {
                    Text(snippet).font(.caption).foregroundStyle(Theme.textDim).lineLimit(1)
                }
            }
            .padding(.horizontal, 24).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .background(alignment: .leading) {
            if selected { Rectangle().fill(Theme.accent).frame(width: 3) }
        }
        .background(selected ? Theme.surfaceSelected : hovering ? Theme.surfaceHover : .clear)
        .onHover { hovering = $0 }
        .accessibilityLabel(L("mail.searchResult.a11y", sender, hit.subject ?? L("mail.noSubject")))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Stand-in for a `Menu` while the offscreen renderer runs. Menus are
/// AppKit-backed and ImageRenderer paints them as a "restricted" placeholder
/// glyph, which would otherwise end up in the screenshots the landing page
/// ships. Same size and chrome, no AppKit.
private struct OffscreenMenuLabel: View {
    let title: String
    var body: some View {
        (Text(title) + Text(Image(systemName: "chevron.down")))
            .font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.line))
    }
}

struct FullRow: View {
    @Environment(AppModel.self) private var model
    let item: FirewallItem
    let actions: TopBarActions
    @FocusState private var focused: Bool

    private var selected: Bool { model.selectedItemId == item.id }
    private var sender: String { senderDisplayName(item.email?.from.map(decodeHTMLEntities)) }
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 12) {
            // The select action is a real Button (role + keyboard + focus), not an
            // onTapGesture, so VoiceOver / Full-Keyboard-Access can open the message.
            Button { actions.onSelect(item) } label: {
                HStack(spacing: 12) {
                    // Hierarchy by size contrast, not by three near-equal lines:
                    // the sender is a small label and the subject is the
                    // statement, because the subject is what you actually scan
                    // a list for. The old row set them one point apart, which
                    // reads as one grey block at arm's length.
                    VStack(alignment: .leading, spacing: 2) {
                        Text(sender).font(.caption.weight(.semibold))
                            .foregroundStyle(Theme.textDim).lineLimit(1)
                        Text(decodeHTMLEntities(item.email?.subject ?? item.title))
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Theme.text).lineLimit(1)
                        if let reason = rowTierReason(item.tierReason) {
                            Text(reason).font(.caption2).foregroundStyle(Theme.textDim).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 8)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focused($focused)
            .accessibilityAddTraits(selected ? .isSelected : [])

            // Row actions surface on hover/selection/focus — at rest the list
            // stays quiet (the tier dot alone carries state). Opacity keeps
            // them clickable-by-position and fully present to VoiceOver.
            HStack(spacing: 12) {
                // The tier dot lives OUTSIDE the menu label: the AppKit
                // borderless menu renders SF Symbols as colorless templates
                // (white dot, v0.4.4) and drops SwiftUI Shapes entirely (no
                // dot, v0.4.5). A sibling Circle under a transparent menu hit
                // area is the only variant that keeps the tint AND the menu.
                ZStack {
                    Circle().fill(Theme.tint(item.tier)).frame(width: 8, height: 8)
                    if !Theme.isRenderingOffscreen {
                        TierMenu(item: item, onSetTier: actions.onSetTier) {
                            Color.clear.iconTarget()
                        }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    }
                }
                .help(L("mail.changeTier"))
                .accessibilityLabel(L("mail.changeTier.a11y", sender, item.tier.label))
                Group {
                    if Theme.isRenderingOffscreen {
                        Image(systemName: "moon.zzz").iconTarget()
                    } else {
                        SnoozeMenu(item: item, onSnooze: actions.onSnooze) {
                            Image(systemName: "moon.zzz").iconTarget()
                        }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    }
                }
                .foregroundStyle(Theme.textDim).help(L("mail.snooze"))
                .accessibilityLabel(L("mail.snooze.a11y", sender))
                .opacity(hovering || selected || focused ? 1 : 0)
                Button { actions.onDismiss(item) } label: { Image(systemName: "xmark").iconTarget() }
                    .buttonStyle(.plain).foregroundStyle(Theme.textDim).help(L("mail.dismiss"))
                    .accessibilityLabel(L("mail.dismiss.a11y", sender))
                    .opacity(hovering || selected || focused ? 1 : 0)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 11)
        // Selection is not color-only: an accent leading bar + a stronger fill (both
        // perceivable), plus the .isSelected trait above.
        .background(alignment: .leading) {
            if selected { Rectangle().fill(Theme.accent).frame(width: 3) }
        }
        .background(selected ? Theme.surfaceSelected : hovering ? Theme.surfaceHover : .clear)
        .onHover { hovering = $0 }
        // Visible keyboard-focus indicator (2.4.7 / 2.4.13): .plain suppresses the
        // system ring, so draw our own — accent on the dark panel is ≈9.5:1 (≥3:1).
        .overlay {
            if focused {
                RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.accent, lineWidth: 2)
            }
        }
    }
}

/// The reading pane: the selected email's content, loaded from GET /api/email/:id.
/// Clicking a row (a plain mouse click, delivered even to the non-focus-stealing
/// panel) loads it here — no need to leave the app for the browser.
/// Internal rather than private so --render-previews can shoot it on its own.
/// The full window is 1400pt wide; on the landing page's 1180px container that
/// scales the app's 13pt body text down to under 7px, which is unreadable. The
/// reading pane alone fits at over 100%.
struct ReadingPane: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions
    @State private var replying = false
    @State private var replyText = ""
    @State private var sending = false
    @State private var quickReplies: AppModel.ReplyOptionsFetch?
    @State private var loadingQuickReplies = false

    private var item: FirewallItem? {
        guard let id = model.selectedItemId else { return nil }
        return model.queue?.item(id: id)
    }

    var body: some View {
        Group {
            if model.isLoadingEmail {
                centered { ProgressView().controlSize(.small) }
            } else if let err = model.emailError {
                centered { Text(err).font(.callout).foregroundStyle(Theme.textDim) }
            } else if let email = model.openedEmail {
                content(email)
            } else if model.selectedItemId != nil {
                centered {
                    EmptyState(icon: "doc.text", title: L("reading.noPreview"))
                }
            } else {
                centered {
                    VStack(spacing: Theme.s4) {
                        // The K mark, quiet — the ring identity is retired
                        // (K monogram everywhere since 0.4.80005).
                        LogoRing(size: 44).opacity(0.45)
                        Text(L("reading.empty.title")).font(.title3).foregroundStyle(Theme.textDim)
                        Text(L("reading.empty.detail"))
                            .font(.caption).foregroundStyle(Theme.textDim)
                            .multilineTextAlignment(.center)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onChange(of: model.selectedItemId) { _, _ in
            replying = false
            replyText = ""
            quickReplies = nil
            loadingQuickReplies = false
        }
    }

    private func content(_ email: EmailDetail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Theme.s2) {
                Text(decodeHTMLEntities(email.subject ?? L("mail.noSubjectParen")))
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Theme.text).lineLimit(2)
                HStack {
                    Text(senderDisplayName(email.from.map(decodeHTMLEntities)))
                        .font(.callout).foregroundStyle(Theme.textDim).lineLimit(1)
                    Spacer()
                    Text(Self.formatDate(email.date)).font(.caption).foregroundStyle(Theme.textDim)
                }
                if let item {
                    HStack(spacing: 10) {
                        Button(L("reading.replyWithAI")) { startReply(item) }
                            .buttonStyle(PrimaryButtonStyle())
                        // menuIndicator(.hidden) kills the system-blue pull-down
                        // segment (the one off-palette element on this row —
                        // design audit 2026-07-20); a dim chevron in the label
                        // keeps the "this opens a menu" affordance.
                        // Chevron lives INSIDE one Text (concatenation) — a
                        // separate Image in the label gets reordered to the
                        // leading edge by the menu button's label styling
                        // (screen-verified 0.4.80007: "∨ Snooze").
                        if Theme.isRenderingOffscreen {
                            OffscreenMenuLabel(title: L("mail.snoozePrefix"))
                            OffscreenMenuLabel(
                                    title: L("mail.moveTo", item.tier.label,
                                             L10n.josaRoIfKorean(after: item.tier.label)))
                        } else {
                            SnoozeMenu(item: item, onSnooze: actions.onSnooze) {
                                Text(L("mail.snoozePrefix"))
                                    + Text(Image(systemName: "chevron.down"))
                                    .font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
                            }
                            .menuStyle(.button).buttonStyle(.bordered).controlSize(.small)
                            .menuIndicator(.hidden).fixedSize()
                            TierMenu(item: item, onSetTier: actions.onSetTier) {
                                Text(L("mail.moveTo", item.tier.label,
                                       L10n.josaRoIfKorean(after: item.tier.label)))
                                    + Text(Image(systemName: "chevron.down"))
                                    .font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
                            }
                            .menuStyle(.button).buttonStyle(.bordered).controlSize(.small)
                            .menuIndicator(.hidden).fixedSize()
                        }
                        Button(L("mail.dismiss")) { actions.onDismiss(item) }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                    .padding(.top, 2)
                }
            }
            .padding(24)
            Divider().overlay(Theme.line)
            klornBand(email)
            if let item, !replying {
                quickReplyStrip(item)
            }
            ScrollView {
                // Reading typography: measured line length (~640pt) and open
                // line spacing — a mail body should read like a document, not
                // a log dump stretched across the pane.
                Text(email.text.isEmpty ? L("reading.noContent") : email.text)
                    .font(.callout)
                    .lineSpacing(4)
                    .foregroundStyle(Theme.text.opacity(0.92))
                    .textSelection(.enabled)
                    .frame(maxWidth: 640, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Theme.s6)
            }
            if replying, let item {
                Divider().overlay(Theme.line)
                replyComposer(item)
            }
        }
    }

    private func replyComposer(_ item: FirewallItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(L("reading.replyTo", senderDisplayName(item.email?.from.map(decodeHTMLEntities))))
                    .font(.caption).foregroundStyle(Theme.textDim).lineLimit(1)
                Spacer()
                if model.isDrafting {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini)
                        Text(L("reading.drafting")).font(.caption).foregroundStyle(Theme.textDim)
                    }
                } else {
                    Button { Task { if let d = await model.draftReply(item) { replyText = d } } } label: {
                        Label(L("reading.regenerate"), systemImage: "sparkles").font(.caption)
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.accent)
                    .help(L("reading.regenerate.help"))
                }
            }
            TextEditor(text: $replyText)
                .font(.callout).foregroundStyle(Theme.text)
                .scrollContentBackground(.hidden)
                .frame(height: 110)
                .padding(Theme.s2)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.field))
            if let err = model.replyError {
                Text(err).font(.caption).foregroundStyle(.orange)
            }
            HStack {
                Spacer()
                Button(L("reading.cancel")) { replying = false; replyText = "" }
                    .buttonStyle(.bordered).controlSize(.small)
                Button(sending ? L("reading.sending") : L("reading.send")) { send(item) }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(sending || model.isDrafting || replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(16)
    }

    /// Klorn's per-email intelligence: why it landed in this tier, the AI summary,
    /// and whether it needs a reply. Hidden when there's nothing to show.
    @ViewBuilder
    private func klornBand(_ email: EmailDetail) -> some View {
        let reason = item?.tierReason
        let hasEngagement = (email.engagement?.outboundCount ?? 0) > 0
        let show = (reason?.isEmpty == false) || (email.summary?.isEmpty == false) || (email.needsReply == true) || hasEngagement
        if show {
            VStack(alignment: .leading, spacing: 6) {
                if let item, let reason, !reason.isEmpty {
                    HStack(spacing: 6) {
                        Circle().fill(Theme.tint(item.tier)).frame(width: 7, height: 7)
                        Text(L("mail.whyTier", item.tier.label, reason))
                            .font(.caption).foregroundStyle(Theme.textDim).lineLimit(2)
                    }
                }
                if let summary = email.summary, !summary.isEmpty {
                    Text(summary).font(.callout).foregroundStyle(Theme.text.opacity(0.9))
                }
                // Signal lines carry their hue on the ICON (and meter) only; the
                // text itself stays dim. Stacked colored text lines (accent blue +
                // engage pink under a red tier dot) made this one band the loudest
                // surface in the app — the hue is the signal, the sentence is not.
                if email.needsReply == true {
                    HStack(spacing: 5) {
                        Image(systemName: "arrowshape.turn.up.left").font(.caption2)
                            .foregroundStyle(Theme.accent).accessibilityHidden(true)
                        Text((email.needsReplyReason?.isEmpty == false) ? email.needsReplyReason! : L("reading.needsReply"))
                            .font(.caption).foregroundStyle(Theme.textDim)
                    }
                }
                if let engagement = email.engagement, engagement.outboundCount > 0 {
                    // Warm tint mirrors the web graph's "you engage" pink — the
                    // signal Klorn learned from the user's own replies. Pink lives
                    // on the icon and the meter; see the signal-line rule above.
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 5) {
                            Image(systemName: "arrow.turn.up.left").font(.caption2)
                                .foregroundStyle(Theme.engage)
                            Text(engagement.replyCountLabel).font(.caption)
                                .foregroundStyle(Theme.textDim)
                        }
                        if engagement.showsImportance {
                            importanceRow(engagement)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(engagement.accessibilityLabel)
                }
            }
            // Same measure as the mail body below: intelligence about a document
            // should not run wider than the document itself.
            .frame(maxWidth: 640, alignment: .leading)
            .padding(.horizontal, 24).padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surfaceRaised)
            Divider().overlay(Theme.line)
        }
    }

    /// Slim strength meter for the 0…1 learned importance, with its qualitative
    /// label. Fixed-width capsule (no GeometryReader); a11y is handled by the
    /// parent's combined label so this stays a decorative child.
    @ViewBuilder
    private func importanceRow(_ engagement: EmailDetail.Engagement) -> some View {
        let trackWidth: CGFloat = 64
        HStack(spacing: 7) {
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.engage.opacity(0.22)).frame(width: trackWidth, height: 5)
                Capsule().fill(Theme.engage)
                    .frame(width: max(4, trackWidth * engagement.importanceFill), height: 5)
            }
            Text(engagement.importanceLabel).font(.caption2).foregroundStyle(Theme.textDim)
        }
        .accessibilityHidden(true)
    }

    /// The three tone-differentiated drafts (accept / decline / info), the same
    /// set the urgent-mail card offers — the reading pane is where mail is
    /// actually read, so it is where answering should be one click, not a
    /// button that starts a wait for a blank composer.
    ///
    /// Choosing one loads it into the composer rather than sending it. On the
    /// card a keystroke sends because the user is triaging one message they are
    /// staring at; here they are reading, and a click that silently sent mail
    /// would be a trapdoor. Approval before action, same as everywhere else.
    @ViewBuilder
    private func quickReplyStrip(_ item: FirewallItem) -> some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            switch quickReplies {
            case .ready(let options) where !options.options.isEmpty:
                HStack(spacing: Theme.s2) {
                    ForEach(Array(options.options.enumerated()), id: \.offset) { index, option in
                        Button {
                            replying = true
                            replyText = option.body
                        } label: {
                            Text(option.toneLabel).frame(minHeight: 24)
                        }
                        .buttonStyle(.bordered).controlSize(.regular)
                        // The card binds 1/2/3 positionally; mirroring that here
                        // keeps one muscle memory across both surfaces.
                        .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: [])
                        .help(option.body)
                        .accessibilityLabel(L("reading.quickReply.a11y", option.toneLabel, option.body))
                    }
                    Spacer()
                }
            case .ready:
                EmptyView()
            case .needsPro:
                Text(L("push.proRequired")).font(.caption).foregroundStyle(Theme.textDim)
            case .failed(let message):
                HStack(spacing: Theme.s2) {
                    Text(message).font(.caption).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(L("push.tryAgain")) { loadQuickReplies(item) }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            case nil:
                if loadingQuickReplies {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini)
                        Text(L("push.draftingReplies")).font(.caption).foregroundStyle(Theme.textDim)
                    }
                } else {
                    // Not fetched on selection: every load is three LLM
                    // completions, and most mail is read without being answered.
                    Button(L("reading.suggestReplies")) { loadQuickReplies(item) }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            }
        }
        .padding(.horizontal, 24).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        Divider().overlay(Theme.line)
    }

    private func loadQuickReplies(_ item: FirewallItem) {
        guard !loadingQuickReplies else { return }
        loadingQuickReplies = true
        quickReplies = nil
        Task {
            let result = await model.fetchReplyOptions(item)
            // The user may have moved on while three completions ran; a late
            // result must not paint another email's drafts.
            guard model.selectedItemId == item.id else { return }
            quickReplies = result
            loadingQuickReplies = false
        }
    }

    /// Open the composer and let Klorn's AI draft the reply into it. The user
    /// reviews/edits before Send (approval before action).
    private func startReply(_ item: FirewallItem) {
        replying = true
        replyText = ""
        Task {
            if let draft = await model.draftReply(item) { replyText = draft }
        }
    }

    private func send(_ item: FirewallItem) {
        sending = true
        Task {
            let ok = await model.reply(item, body: replyText)
            sending = false
            if ok { replying = false; replyText = "" }
        }
    }

    private func centered<Content: View>(@ViewBuilder _ c: () -> Content) -> some View {
        VStack { Spacer(); c(); Spacer() }.frame(maxWidth: .infinity)
    }

    private static func formatDate(_ iso: String?) -> String {
        guard let iso else { return "" }
        let iso1 = ISO8601DateFormatter(); iso1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let iso2 = ISO8601DateFormatter(); iso2.formatOptions = [.withInternetDateTime]
        guard let date = iso1.date(from: iso) ?? iso2.date(from: iso) else { return "" }
        let out = DateFormatter()
        // Without this the formatter follows the SYSTEM locale, so a user who set
        // the app to English on a Korean Mac still read "7월 29 · 5:12 오후".
        // Follow the app's own resolved language instead.
        out.locale = Locale(identifier: L10n.resolvedCode(override: L10n.override))
        out.dateFormat = "MMM d · h:mm a"
        return out.string(from: date)
    }
}


/// The update affordance, shared by the panel's ACCOUNT column and the
/// full-window sidebar. Never a popup (never-steal-focus) — but no longer
/// invisible either: a tinted capsule with a pulsing dot and a gentle
/// appear transition says "one click waiting" the moment the row exists.
/// Pulse respects Reduce Motion.
private struct UpdateRow: View {
    let version: String
    @State private var updating = false
    @State private var pulsing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            guard !updating else { return }
            updating = true
            Task {
                _ = await SelfUpdate.run(version: version)
                updating = false  // reached only on fallback
            }
        } label: {
            HStack(spacing: 8) {
                ZStack {
                    if !reduceMotion {
                        Circle()
                            .fill(Theme.accent.opacity(0.35))
                            .frame(width: 7, height: 7)
                            .scaleEffect(pulsing ? 2.1 : 1.0)
                            .opacity(pulsing ? 0.0 : 0.7)
                    }
                    Circle().fill(Theme.accent).frame(width: 7, height: 7)
                }
                Text(updating ? "Updating…" : "Update to v\(version)")
                    .font(.body.weight(.medium))
                    .foregroundStyle(Theme.accent)
                Spacer(minLength: 0)
                Image(systemName: updating ? "arrow.triangle.2.circlepath" : "arrow.down.circle.fill")
                    .foregroundStyle(Theme.accent)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Theme.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
            .overlay(
                RoundedRectangle(cornerRadius: 9)
                    .strokeBorder(Theme.accent.opacity(0.25), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(updating)
        .accessibilityLabel(updating
            ? "Updating to version \(version)"
            : "Update available: version \(version). Installs and relaunches.")
        .transition(.opacity.combined(with: .move(edge: .top)))
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) {
                pulsing = true
            }
        }
    }
}
