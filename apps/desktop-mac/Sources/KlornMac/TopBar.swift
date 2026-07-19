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
    let onSignIn: () -> Void
    let onSignOut: () -> Void
    /// Open an item on the web inbox; nil opens the inbox root.
    let onOpenWeb: (FirewallItem?) -> Void
    /// Open an item IN-APP: jump to the full view and show it in the reading pane.
    let onOpenInApp: (FirewallItem) -> Void
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
    static let corner: CGFloat = 16

    static func size(for state: BarState) -> NSSize {
        switch state {
        case .collapsed: collapsed
        case .expanded: expanded
        case .full: full
        }
    }
}

/// Root that switches between the three states. The controller animates the
/// window frame; this just renders the right content.
struct TopBarRoot: View {
    let state: BarState
    let actions: TopBarActions
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        Group {
            switch state {
            case .collapsed: CollapsedBar(actions: actions)
            case .expanded: ExpandedPanel(actions: actions)
            case .full: FullView(actions: actions)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: TopBarMetrics.corner)
                .fill(Color.black.opacity(Theme.panelOpacity(reduceTransparency: reduceTransparency)))
                .overlay(RoundedRectangle(cornerRadius: TopBarMetrics.corner).strokeBorder(Theme.line))
        )
        .clipShape(RoundedRectangle(cornerRadius: TopBarMetrics.corner))
    }
}

/// Klorn wordmark ring — the small circular logo from the reference bar.
private struct LogoRing: View {
    var size: CGFloat = 16
    var body: some View {
        Circle().strokeBorder(Theme.accent, lineWidth: 2).frame(width: size, height: size)
            .accessibilityHidden(true)  // decorative wordmark ring
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
    var body: some View {
        Text(title).font(.caption2.weight(.semibold))
            .foregroundStyle(Theme.textDim).tracking(0.6)
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
                Image(systemName: "line.3.horizontal").font(.body.weight(.medium)).iconTarget(32)
            }
            .buttonStyle(.plain).foregroundStyle(Theme.text)
            .help("Expand")
            .accessibilityLabel("Expand Klorn")

            LogoRing()
            Text("Klorn").font(.callout.weight(.semibold)).foregroundStyle(Theme.text)

            Spacer()

            switch model.phase {
            case .signedIn:
                if pushCount > 0 {
                    HStack(spacing: 5) {
                        Circle().fill(Theme.tint(.push)).frame(width: 7, height: 7)
                        Text("\(pushCount) PUSH")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(Theme.text)
                    }
                } else if model.loadError != nil {
                    Text("offline").font(.caption).foregroundStyle(Theme.textDim)
                } else {
                    Text("All clear").font(.caption).foregroundStyle(Theme.textDim)
                }
            case .signingIn:
                Text("Signing in…").font(.caption).foregroundStyle(Theme.textDim)
            case .signedOut:
                Button("Log In", action: actions.onSignIn)
                    .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
            }

            Button(action: actions.onHideBar) {
                Image(systemName: "xmark").font(.caption.weight(.semibold)).iconTarget(28)
            }
            .buttonStyle(.plain).foregroundStyle(Theme.textDim)
            .help("Hide the bar (it keeps running in the menu bar)")
            .accessibilityLabel("Hide top bar")
        }
        .padding(.horizontal, 16)
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
            Divider().overlay(Theme.line)
            HStack(alignment: .top, spacing: 0) {
                InboxColumn(actions: actions)
                columnDivider
                RecentPushColumn(actions: actions)
                columnDivider
                TodayColumn()
                columnDivider
                AccountColumn(actions: actions)
            }
        }
        .frame(width: TopBarMetrics.expanded.width, height: TopBarMetrics.expanded.height)
    }

    private var header: some View {
        HStack {
            Button(action: actions.onCollapse) {
                HStack(spacing: 6) {
                    Image(systemName: "minus").font(.caption.weight(.bold)).accessibilityHidden(true)
                    Text("Close").font(.callout)
                }
            }
            .buttonStyle(.plain).foregroundStyle(Theme.textDim)

            Spacer()
            HStack(spacing: 8) { LogoRing(); Text("Klorn").font(.callout.weight(.semibold)).foregroundStyle(Theme.text) }
            Spacer()

            HStack(spacing: 14) {
                Button(action: actions.onExpandFull) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right").font(.callout).iconTarget()
                }
                .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                .help("Full view")
                .accessibilityLabel("Open full view")

                if model.phase == .signedIn {
                    Button("Sign Out", action: actions.onSignOut)
                        .buttonStyle(.bordered).controlSize(.small)
                } else if model.phase == .signedOut {
                    Button("Log In", action: actions.onSignIn)
                        .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
                }
            }
        }
        .padding(.horizontal, 18).frame(height: 56)
    }

    private var columnDivider: some View {
        Rectangle().fill(Theme.line).frame(width: 1).padding(.vertical, 14)
    }
}

/// Column 1 — per-tier open counts; click opens the web inbox.
/// TODAY — the day's calendar at a glance (current meeting + what's next).
/// Rows with a meeting link open it directly; others are display-only.
private struct TodayColumn: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ColumnHeader(title: "TODAY")
            if let briefing = model.briefing {
                Button { if let url = URL(string: Config.webBaseURL) { NSWorkspace.shared.open(url) } } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 5) {
                            Image(systemName: "sun.max").font(.caption2).foregroundStyle(Theme.accent)
                                .accessibilityHidden(true)
                            Text("BRIEFING").font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
                        }
                        Text(briefing).font(.caption).foregroundStyle(Theme.text)
                            .lineLimit(3).multilineTextAlignment(.leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Today's briefing: \(briefing)")
            }
            if let today = model.today, today.total > 0 {
                if let current = today.current {
                    eventRow(current, isNow: true)
                }
                ForEach(today.upcoming.prefix(4)) { event in
                    eventRow(event, isNow: false)
                }
                if today.upcoming.count > 4 {
                    Text("+\(today.upcoming.count - 4) more")
                        .font(.caption2).foregroundStyle(Theme.textDim)
                }
            } else {
                Text(model.today == nil ? "Loading…" : "No events today")
                    .font(.caption).foregroundStyle(Theme.textDim)
            }
            Spacer()
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func eventRow(_ event: CalendarEventWire, isNow: Bool) -> some View {
        let time = eventTimeLabel(
            startISO: event.startTime, endISO: event.endTime, allDay: event.allDay)
        let row = HStack(alignment: .top, spacing: 8) {
            if isNow {
                Text("NOW")
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
                .accessibilityLabel("Join \(event.title)")
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
            ColumnHeader(title: "INBOX")
            ForEach(Tier.displayOrder) { tier in
                Button { actions.onOpenWeb(nil) } label: {
                    HStack(spacing: 8) {
                        Circle().fill(Theme.tint(tier)).frame(width: 7, height: 7)
                        Text(tier.label).font(.body).foregroundStyle(Theme.text)
                        Spacer()
                        Text("\(model.queue?.summary.count(for: tier) ?? 0)")
                            .font(.body.monospacedDigit().weight(.medium))
                            .foregroundStyle(Theme.textDim)
                    }
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Column 2 — the recent PUSH items; click opens that item.
private struct RecentPushColumn: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    private var items: [FirewallItem] { model.queue?.items(for: .push) ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ColumnHeader(title: "RECENT PUSH")
            if items.isEmpty {
                Text("Nothing needs you right now.")
                    .font(.callout).foregroundStyle(Theme.textDim)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(items) { item in
                            let sender = item.email?.from ?? item.title
                            HStack(spacing: 10) {
                                Button { actions.onOpenInApp(item) } label: { pushRow(item) }
                                    .buttonStyle(.plain)
                                SnoozeMenu(item: item, onSnooze: actions.onSnooze) {
                                    Image(systemName: "moon.zzz").font(.caption2).iconTarget()
                                }
                                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                                .foregroundStyle(Theme.textDim)
                                .help("Snooze…")
                                .accessibilityLabel("Snooze message from \(sender)")
                                Button { actions.onDismiss(item) } label: {
                                    Image(systemName: "xmark").font(.caption2).iconTarget()
                                }
                                .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                                .help("Dismiss")
                                .accessibilityLabel("Dismiss message from \(sender)")
                            }
                        }
                    }
                }
            }
            Spacer()
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func pushRow(_ item: FirewallItem) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.email?.from ?? item.title).font(.callout.weight(.semibold))
                .foregroundStyle(Theme.text).lineLimit(1)
            Text(item.email?.subject ?? item.title).font(.caption)
                .foregroundStyle(Theme.textDim).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Column 3 — account + resources.
private struct AccountColumn: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ColumnHeader(title: "ACCOUNT")
            if model.phase == .signedIn {
                Button { actions.onOpenWeb(nil) } label: {
                    Text("Open web inbox").font(.body).foregroundStyle(Theme.text)
                }.buttonStyle(.plain)
                Button(action: actions.onSignOut) {
                    Text("Sign out").font(.body).foregroundStyle(Theme.text)
                }.buttonStyle(.plain)
            } else {
                Button(action: actions.onSignIn) {
                    Text("Sign in with Google").font(.body).foregroundStyle(Theme.text)
                }.buttonStyle(.plain)
            }
            if model.phase == .signedIn, let usage = model.usage {
                VStack(alignment: .leading, spacing: 5) {
                    Text("AI TODAY").font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.white.opacity(0.08))
                            Capsule().fill(Theme.accent)
                                .frame(width: geo.size.width
                                       * usageFillFraction(used: usage.dailyUsed, cap: usage.dailyCap))
                        }
                    }
                    .frame(height: 5)
                    Text(usageLabel(used: usage.dailyUsed, cap: usage.dailyCap))
                        .font(.caption2.monospacedDigit()).foregroundStyle(Theme.textDim)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("AI usage today: \(usage.dailyUsed) of \(usage.dailyCap)")
                .padding(.top, 4)
            }

            Button(action: actions.onOpenPreferences) {
                Text("Preferences").font(.body).foregroundStyle(Theme.textDim)
            }.buttonStyle(.plain)
            Button(action: actions.onQuit) {
                Text("Quit Klorn").font(.body).foregroundStyle(Theme.textDim)
            }.buttonStyle(.plain)
            Spacer()
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Full ("real app" window)

/// The largest state: a tier sidebar + a big scrollable list of the selected
/// tier — a real desktop-app view of the whole firewall.
struct FullView: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions
    @State private var tier: Tier = .push

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                header
                Divider().overlay(Theme.line)
                HStack(spacing: 0) {
                    FullSidebar(selected: $tier, actions: actions).frame(width: 220)
                    Rectangle().fill(Theme.line).frame(width: 1)
                    FullList(tier: tier, actions: actions).frame(width: 420)
                    Rectangle().fill(Theme.line).frame(width: 1)
                    ReadingPane(actions: actions).frame(maxWidth: .infinity)
                }
            }
            if model.showPreferences {
                // Scrim: click-off dismiss (a11y users use the Done button instead).
                Color.black.opacity(0.55)
                    .onTapGesture { model.showPreferences = false }
                    .accessibilityHidden(true)
                PreferencesView(actions: actions)
            }
        }
        .frame(width: TopBarMetrics.full.width, height: TopBarMetrics.full.height)
    }

    private var header: some View {
        HStack(spacing: 14) {
            Button(action: actions.onRestore) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.down.right.and.arrow.up.left").font(.callout).accessibilityHidden(true)
                    Text("Smaller").font(.callout)
                }
            }
            .buttonStyle(.plain).foregroundStyle(Theme.textDim)
            .help("Back to the compact panel")

            Button(action: actions.onCollapse) {
                Image(systemName: "minus").font(.callout.weight(.bold)).iconTarget()
            }
            .buttonStyle(.plain).foregroundStyle(Theme.textDim)
            .help("Collapse to the pill")
            .accessibilityLabel("Collapse to pill")

            Spacer()
            HStack(spacing: 8) {
                LogoRing(size: 20)
                Text("Klorn").font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
            }
            Spacer()

            if model.phase == .signedIn {
                Button("Sign Out", action: actions.onSignOut).buttonStyle(.bordered).controlSize(.small)
            } else if model.phase == .signedOut {
                Button("Log In", action: actions.onSignIn)
                    .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
            }
        }
        .padding(.horizontal, 22).frame(height: 64)
    }
}

private struct FullSidebar: View {
    @Environment(AppModel.self) private var model
    @Binding var selected: Tier
    let actions: TopBarActions

    /// Compact event row for the 220pt sidebar: NOW badge or start time,
    /// title, and a click-through to the meeting link when present.
    @ViewBuilder
    private func sidebarEventRow(_ event: CalendarEventWire, isNow: Bool) -> some View {
        let time = eventTimeLabel(
            startISO: event.startTime, endISO: event.endTime, allDay: event.allDay)
        let row = HStack(alignment: .top, spacing: 8) {
            if isNow {
                Text("NOW").font(.caption2.weight(.bold)).foregroundStyle(Theme.accent)
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
                .accessibilityLabel("Join \(event.title)")
        } else {
            row.accessibilityElement(children: .combine)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ColumnHeader(title: "INBOX").padding(.horizontal, 20).padding(.bottom, 6)
            ForEach(Tier.displayOrder) { tier in
                Button { selected = tier } label: {
                    HStack(spacing: 10) {
                        Circle().fill(Theme.tint(tier)).frame(width: 8, height: 8)
                        Text(tier.label).font(.body.weight(selected == tier ? .semibold : .regular))
                            .foregroundStyle(Theme.text)
                        Spacer()
                        Text("\(model.queue?.summary.count(for: tier) ?? 0)")
                            .font(.body.monospacedDigit()).foregroundStyle(Theme.textDim)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(selected == tier ? Color.white.opacity(0.07) : .clear,
                                in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
            }

            // TODAY lives in the full view too — the biggest surface must not
            // know less about the day than the compact panel (dogfood 2026-07-16).
            ColumnHeader(title: "TODAY").padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 6)
            if let today = model.today, today.total > 0 {
                if let current = today.current {
                    sidebarEventRow(current, isNow: true)
                }
                ForEach(today.upcoming.prefix(3)) { event in
                    sidebarEventRow(event, isNow: false)
                }
                if today.upcoming.count > 3 {
                    Text("+\(today.upcoming.count - 3) more")
                        .font(.caption2).foregroundStyle(Theme.textDim)
                        .padding(.horizontal, 20)
                }
            } else {
                Text(model.today == nil ? "Loading…" : "No events today")
                    .font(.caption).foregroundStyle(Theme.textDim)
                    .padding(.horizontal, 20)
            }

            Spacer()

            ColumnHeader(title: "ACCOUNT").padding(.horizontal, 20).padding(.bottom, 6)
            if model.phase == .signedIn {
                sidebarAction("Open web inbox") { actions.onOpenWeb(nil) }
                sidebarAction("Sign out", dim: true) { actions.onSignOut() }
            } else {
                sidebarAction("Sign in with Google") { actions.onSignIn() }
            }
            sidebarAction("Preferences", dim: true) { model.showPreferences = true }
            sidebarAction("Quit Klorn", dim: true) { actions.onQuit() }
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
    let tier: Tier
    let actions: TopBarActions

    private var items: [FirewallItem] { model.queue?.items(for: tier) ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Circle().fill(Theme.tint(tier)).frame(width: 9, height: 9)
                Text(tier.label).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                Text("\(items.count)").font(.title3.monospacedDigit()).foregroundStyle(Theme.textDim)
            }
            .padding(.horizontal, 24).padding(.vertical, 18)
            Divider().overlay(Theme.line)

            if items.isEmpty {
                Spacer()
                Text("Nothing in \(tier.label).").font(.title3).foregroundStyle(Theme.textDim)
                    .frame(maxWidth: .infinity)
                Spacer()
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
}

private struct FullRow: View {
    @Environment(AppModel.self) private var model
    let item: FirewallItem
    let actions: TopBarActions
    @FocusState private var focused: Bool

    private var selected: Bool { model.selectedItemId == item.id }
    private var sender: String { item.email?.from ?? item.title }

    var body: some View {
        HStack(spacing: 12) {
            // The select action is a real Button (role + keyboard + focus), not an
            // onTapGesture, so VoiceOver / Full-Keyboard-Access can open the message.
            Button { actions.onSelect(item) } label: {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(sender).font(.body.weight(.semibold))
                            .foregroundStyle(Theme.text).lineLimit(1)
                        Text(item.email?.subject ?? item.title).font(.callout)
                            .foregroundStyle(Theme.text.opacity(0.85)).lineLimit(1)
                        if let reason = item.tierReason, !reason.isEmpty {
                            Text(reason).font(.caption).foregroundStyle(Theme.textDim).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 8)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focused($focused)
            .accessibilityAddTraits(selected ? .isSelected : [])

            TierMenu(item: item, onSetTier: actions.onSetTier) {
                Image(systemName: "circle.fill")
                    .font(.system(size: 8))
                    .foregroundStyle(Theme.tint(item.tier))
                    .iconTarget()
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .help("Move to tier… (teaches Klorn)")
            .accessibilityLabel("Change tier for message from \(sender), currently \(item.tier.label)")
            SnoozeMenu(item: item, onSnooze: actions.onSnooze) {
                Image(systemName: "moon.zzz").iconTarget()
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .foregroundStyle(Theme.textDim).help("Snooze…")
            .accessibilityLabel("Snooze message from \(sender)")
            Button { actions.onDismiss(item) } label: { Image(systemName: "xmark").iconTarget() }
                .buttonStyle(.plain).foregroundStyle(Theme.textDim).help("Dismiss")
                .accessibilityLabel("Dismiss message from \(sender)")
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        // Selection is not color-only: an accent leading bar + a stronger fill (both
        // perceivable), plus the .isSelected trait above.
        .background(alignment: .leading) {
            if selected { Rectangle().fill(Theme.accent).frame(width: 3) }
        }
        .background(selected ? Color.white.opacity(0.14) : .clear)
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
private struct ReadingPane: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions
    @State private var replying = false
    @State private var replyText = ""
    @State private var sending = false

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
                centered { Text("No preview for this item.").font(.callout).foregroundStyle(Theme.textDim) }
            } else {
                centered { Text("Select a message to read it here.").font(.title3).foregroundStyle(Theme.textDim) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onChange(of: model.selectedItemId) { _, _ in replying = false; replyText = "" }
    }

    private func content(_ email: EmailDetail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text(email.subject ?? "(no subject)").font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.text).lineLimit(2)
                HStack {
                    Text(email.from ?? "").font(.callout).foregroundStyle(Theme.textDim).lineLimit(1)
                    Spacer()
                    Text(Self.formatDate(email.date)).font(.caption).foregroundStyle(Theme.textDim)
                }
                if let item {
                    HStack(spacing: 10) {
                        Button("Reply with AI") { startReply(item) }
                            .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
                        Button("Open in web") { actions.onOpenWeb(item) }
                            .buttonStyle(.bordered).controlSize(.small)
                        SnoozeMenu(item: item, onSnooze: actions.onSnooze) { Text("Snooze") }
                            .menuStyle(.button).buttonStyle(.bordered).controlSize(.small).fixedSize()
                        TierMenu(item: item, onSetTier: actions.onSetTier) {
                            Text("Move to \(item.tier.label) ▾")
                        }
                        .menuStyle(.button).buttonStyle(.bordered).controlSize(.small).fixedSize()
                        Button("Dismiss") { actions.onDismiss(item) }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                    .padding(.top, 2)
                }
            }
            .padding(24)
            Divider().overlay(Theme.line)
            klornBand(email)
            ScrollView {
                Text(email.text.isEmpty ? "(no content)" : email.text)
                    .font(.callout)
                    .foregroundStyle(Theme.text.opacity(0.92))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(24)
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
                Text("Reply to \(item.email?.from ?? "")")
                    .font(.caption).foregroundStyle(Theme.textDim).lineLimit(1)
                Spacer()
                if model.isDrafting {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini)
                        Text("Klorn is drafting…").font(.caption).foregroundStyle(Theme.textDim)
                    }
                } else {
                    Button { Task { if let d = await model.draftReply(item) { replyText = d } } } label: {
                        Label("Regenerate", systemImage: "sparkles").font(.caption)
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.accent)
                    .help("Ask Klorn to rewrite the draft")
                }
            }
            TextEditor(text: $replyText)
                .font(.callout).foregroundStyle(Theme.text)
                .scrollContentBackground(.hidden)
                .frame(height: 110)
                .padding(8)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.field))
            if let err = model.replyError {
                Text(err).font(.caption).foregroundStyle(.orange)
            }
            HStack {
                Spacer()
                Button("Cancel") { replying = false; replyText = "" }
                    .buttonStyle(.bordered).controlSize(.small)
                Button(sending ? "Sending…" : "Send") { send(item) }
                    .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
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
                        Text("Why \(item.tier.label) · \(reason)")
                            .font(.caption).foregroundStyle(Theme.textDim).lineLimit(2)
                    }
                }
                if let summary = email.summary, !summary.isEmpty {
                    Text(summary).font(.callout).foregroundStyle(Theme.text.opacity(0.9))
                }
                if email.needsReply == true {
                    HStack(spacing: 5) {
                        Image(systemName: "arrowshape.turn.up.left").font(.caption2).accessibilityHidden(true)
                        Text((email.needsReplyReason?.isEmpty == false) ? email.needsReplyReason! : "Needs a reply")
                            .font(.caption)
                    }
                    .foregroundStyle(Theme.accent)
                }
                if let engagement = email.engagement, engagement.outboundCount > 0 {
                    // Warm tint mirrors the web graph's "you engage" pink — the
                    // signal Klorn learned from the user's own replies.
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 5) {
                            Image(systemName: "arrow.turn.up.left").font(.caption2)
                            Text(engagement.replyCountLabel).font(.caption)
                        }
                        if engagement.showsImportance {
                            importanceRow(engagement)
                        }
                    }
                    .foregroundStyle(Theme.engage)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(engagement.accessibilityLabel)
                }
            }
            .padding(.horizontal, 24).padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.white.opacity(0.04))
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
            Text(engagement.importanceLabel).font(.caption2).foregroundStyle(Theme.engage.opacity(0.95))
        }
        .accessibilityHidden(true)
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
        let out = DateFormatter(); out.dateFormat = "MMM d · h:mm a"
        return out.string(from: date)
    }
}
