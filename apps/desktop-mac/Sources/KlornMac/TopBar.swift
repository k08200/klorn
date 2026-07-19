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
        // and Dock all say the same thing: Klorn.
        Text("K")
            .font(.system(size: size * 0.82, weight: .heavy, design: .rounded))
            .foregroundStyle(
                LinearGradient(
                    colors: [Theme.accent, Color(red: 1.0, green: 0.42, blue: 0.29)],
                    startPoint: .top, endPoint: .bottom))
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
    var body: some View {
        // Editorial micro-label: wide tracking + smaller size reads as a
        // deliberate system, not a shrunken heading.
        Text(title).font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Theme.textDim).tracking(1.4)
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
            .help("Expand")
            .accessibilityLabel("Expand Klorn")

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
                        Text("\(pushCount) PUSH")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(Theme.text)
                    }
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Theme.tint(.push).opacity(0.12), in: Capsule())
                } else if model.loadError != nil {
                    HStack(spacing: 5) {
                        Circle().fill(Theme.tint(.push).opacity(0.7)).frame(width: 6, height: 6)
                        Text("offline").font(.caption)
                    }
                    .foregroundStyle(Theme.textDim)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Theme.surfaceRaised, in: Capsule())
                } else {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark").font(.caption2.weight(.semibold))
                            .accessibilityHidden(true)
                        Text("All clear").font(.caption)
                    }
                    .foregroundStyle(Theme.textDim)
                }
            case .signingIn:
                Text("Signing in…").font(.caption).foregroundStyle(Theme.textDim)
            case .signedOut:
                Button("Log In", action: actions.onSignIn)
                    .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
            }

            Button(action: actions.onHideBar) {
                Image(systemName: "xmark").font(.caption.weight(.semibold)).iconTarget(30)
            }
            .buttonStyle(.plain).hoverDim()
            .focusEffectDisabled()
            .help("Hide the bar (it keeps running in the menu bar)")
            .accessibilityLabel("Hide top bar")
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
            .buttonStyle(.plain).hoverDim()

            Spacer()
            HStack(spacing: 8) { LogoRing(); Text("Klorn").font(.system(.callout, design: .rounded).weight(.bold)).foregroundStyle(Theme.text) }
            Spacer()

            HStack(spacing: 14) {
                Button(action: actions.onExpandFull) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right").font(.callout).iconTarget()
                }
                .buttonStyle(.plain).hoverDim()
                .help("Full view")
                .accessibilityLabel("Open full view")

                if model.phase == .signedIn {
                    Button("Sign Out", action: actions.onSignOut)
                        .buttonStyle(.plain).font(.callout).hoverDim()
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
                    .padding(8).padding(.leading, 6)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 1).fill(Theme.accent.opacity(0.7))
                            .frame(width: 2).padding(.vertical, 6)
                    }
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

            // The agent's daily receipt — trust needs visibility. Hidden on
            // no-activity days (an empty receipt is noise). Click → web inbox,
            // where pending proposals are approved/declined.
            if let agent = model.agentToday, let line = agentActivityLine(agent.totals) {
                Button { if let url = URL(string: Config.webBaseURL) { NSWorkspace.shared.open(url) } } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 5) {
                            Image(systemName: "gearshape")
                                .font(.caption2).foregroundStyle(Theme.accent)
                                .accessibilityHidden(true)
                            Text("KLORN TODAY").font(.caption2.weight(.semibold))
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
                .accessibilityLabel("Klorn today: \(line). Opens the web inbox to review.")
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
                InboxTierRow(tier: tier, count: model.queue?.summary.count(for: tier) ?? 0) {
                    actions.onOpenWeb(nil)
                }
            }
            Spacer()
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One glanceable tier count in the expanded panel — hover invites the click
/// through to the web inbox without shouting at rest.
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
            ColumnHeader(title: "RECENT PUSH")
            if items.isEmpty {
                EmptyState(icon: "checkmark.shield", title: "Nothing needs you right now.")
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

    private var sender: String { decodeHTMLEntities(item.email?.from ?? item.title) }

    var body: some View {
        HStack(spacing: Theme.s2) {
            Button { actions.onOpenInApp(item) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(sender).font(.callout.weight(.semibold))
                        .foregroundStyle(Theme.text).lineLimit(1)
                    Text(decodeHTMLEntities(item.email?.subject ?? item.title)).font(.caption)
                        .foregroundStyle(Theme.text.opacity(0.75)).lineLimit(1)
                    if let reason = item.tierReason, !reason.isEmpty {
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
            .help("Snooze…")
            .accessibilityLabel("Snooze message from \(sender)")
            .opacity(hovering ? 1 : 0)
            Button { actions.onDismiss(item) } label: {
                Image(systemName: "xmark").font(.caption2).iconTarget()
            }
            .buttonStyle(.plain).foregroundStyle(Theme.textDim)
            .help("Dismiss")
            .accessibilityLabel("Dismiss message from \(sender)")
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
            ColumnHeader(title: "ACCOUNT")
            if model.phase == .signedIn {
                if let version = model.updateAvailable {
                    // Quiet update signal (auto-checked every 6h) — a normal
                    // row, never a popup. One click downloads the notarized
                    // build, verifies its signature, swaps, and relaunches;
                    // any failure falls back to the release page.
                    Button {
                        guard !updating else { return }
                        updating = true
                        Task {
                            _ = await SelfUpdate.run(version: version)
                            updating = false  // reached only on fallback
                        }
                    } label: {
                        Label(updating ? "Updating…" : "Update to v\(version)",
                              systemImage: updating ? "arrow.triangle.2.circlepath" : "arrow.down.circle")
                            .font(.body).foregroundStyle(Theme.accent)
                    }
                    .buttonStyle(.plain)
                    .disabled(updating)
                    .accessibilityLabel(updating
                        ? "Updating to version \(version)"
                        : "Update available: version \(version). Installs and relaunches.")
                }
                SubtleTextButton(title: "Open web inbox", dim: false) { actions.onOpenWeb(nil) }
                SubtleTextButton(title: "Sign out") { actions.onSignOut() }
            } else {
                SubtleTextButton(title: "Sign in with Google", dim: false) { actions.onSignIn() }
            }
            if model.phase == .signedIn, let usage = model.usage {
                VStack(alignment: .leading, spacing: 5) {
                    Text("AI TODAY").font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.surfaceHover)
                            Capsule()
                                .fill(LinearGradient(
                                    colors: [Theme.accent, Color(red: 1.0, green: 0.42, blue: 0.29)],
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
                .accessibilityLabel("AI usage today: \(usage.dailyUsed) of \(usage.dailyCap)")
                .padding(.top, 4)
            }

            SubtleTextButton(title: "Preferences") { actions.onOpenPreferences() }
            SubtleTextButton(title: "Quit Klorn") { actions.onQuit() }
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
}

struct FullView: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions
    @State private var mode: ListMode = .tier(.push)

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                header
                Divider().overlay(Theme.line).padding(.horizontal, 22)
                HStack(spacing: 0) {
                    FullSidebar(selected: $mode, actions: actions).frame(width: 220)
                    Rectangle().fill(Theme.line).frame(width: 1)
                    FullList(mode: mode, actions: actions).frame(width: 420)
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
            .buttonStyle(.plain).hoverDim()
            .help("Back to the compact panel")

            Button(action: actions.onCollapse) {
                Image(systemName: "minus").font(.callout.weight(.bold)).iconTarget()
            }
            .buttonStyle(.plain).hoverDim()
            .help("Collapse to the pill")
            .accessibilityLabel("Collapse to pill")

            Spacer()
            HStack(spacing: 8) {
                LogoRing(size: 20)
                Text("Klorn").font(.system(.title3, design: .rounded).weight(.bold)).foregroundStyle(Theme.text)
            }
            Spacer()

            if model.phase == .signedIn {
                // Secondary by design: signing out is rare — it must never
                // compete with content. (Log In stays the accent CTA.)
                Button("Sign Out", action: actions.onSignOut)
                    .buttonStyle(.plain).font(.callout).hoverDim()
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
            }

            // Commitments: promises made / replies awaited — the follow-through
            // half of the firewall (what mail asked of you, and of them).
            Button { selected = .commitments } label: {
                HStack(spacing: 10) {
                    Image(systemName: "checklist").font(.caption)
                        .foregroundStyle(Theme.accent).frame(width: 8)
                        .accessibilityHidden(true)
                    Text("Commitments")
                        .font(.body.weight(selected == .commitments ? .semibold : .regular))
                        .foregroundStyle(Theme.text)
                    Spacer()
                    Text("\(model.commitments?.count ?? 0)")
                        .font(.body.monospacedDigit()).foregroundStyle(Theme.textDim)
                }
                .modifier(SidebarRowChrome(selected: selected == .commitments))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Commitments, \(model.commitments?.count ?? 0) open")

            // Assistant: ask/act across mail, calendar, and the briefing.
            Button { selected = .assistant } label: {
                HStack(spacing: 10) {
                    Image(systemName: "sparkles").font(.caption)
                        .foregroundStyle(Theme.accent).frame(width: 8)
                        .accessibilityHidden(true)
                    Text("Assistant")
                        .font(.body.weight(selected == .assistant ? .semibold : .regular))
                        .foregroundStyle(Theme.text)
                    Spacer()
                }
                .modifier(SidebarRowChrome(selected: selected == .assistant))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Assistant")

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
        case .tier: tierList
        }
    }

    private var tierList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if searching {
                    Image(systemName: "magnifyingglass").font(.body).foregroundStyle(Theme.accent)
                        .accessibilityHidden(true)
                    Text("Search").font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
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
                TextField("Search all mail…", text: $query)
                    .textFieldStyle(.plain).font(.callout).foregroundStyle(Theme.text)
                    .focused($searchFocused)
                    .accessibilityLabel("Search all mail")
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: { Image(systemName: "xmark.circle.fill").font(.caption) }
                        .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                        .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8)
                .strokeBorder(searchFocused ? Theme.accent.opacity(0.5) : .clear))
            .padding(.horizontal, 24).padding(.bottom, 12)
            .task(id: query) {
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
                EmptyState(
                    icon: tier == .push ? "checkmark.shield" : "tray",
                    title: "Nothing in \(tier.label).",
                    hint: tier == .push ? "Klorn is holding the line — nothing needs you." : nil)
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
                title: "No mail matches “\(query.trimmingCharacters(in: .whitespaces))”.")
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
                Text("Assistant").font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
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
                                    title: "Ask about your mail, calendar, or day.")
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
                                Text("Thinking…").font(.caption).foregroundStyle(Theme.textDim)
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
                TextField("Message Klorn…", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain).font(.callout).foregroundStyle(Theme.text)
                    .lineLimit(1...4)
                    .focused($composerFocused)
                    .onSubmit { send() }
                    .accessibilityLabel("Message Klorn")
                Button { send() } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .buttonStyle(.plain)
                .foregroundStyle(canSendChat(draft, busy: model.isChatting) ? Theme.accent : Theme.textDim)
                .disabled(!canSendChat(draft, busy: model.isChatting))
                .accessibilityLabel("Send message")
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
                Text(message.text)
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
                        Button("Add to calendar") {
                            Task { await model.createEvent(from: draft, messageId: message.id) }
                        }
                        .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
                        Button("Ignore") { model.clearEventDraft(message.id) }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                }
                .padding(10)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line))
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Proposed event: \(eventDraftLabel(draft))")
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
                Text("Commitments").font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                Text("\(model.commitments?.count ?? 0)")
                    .font(.title3.monospacedDigit()).foregroundStyle(Theme.textDim)
            }
            .padding(.horizontal, 24).padding(.vertical, 18)
            Divider().overlay(Theme.line)

            if model.commitments == nil {
                Spacer()
                if model.commitmentsFailed {
                    Text("Couldn't load commitments — retrying on the next refresh.")
                        .font(.callout).foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity).multilineTextAlignment(.center)
                } else {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                }
                Spacer()
            } else if groups.waitingOn.isEmpty && groups.iOwe.isEmpty {
                Spacer()
                Text("No open commitments.").font(.title3).foregroundStyle(Theme.textDim)
                    .frame(maxWidth: .infinity)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if !groups.waitingOn.isEmpty {
                            ColumnHeader(title: "WAITING ON")
                                .padding(.horizontal, 24).padding(.top, 14).padding(.bottom, 4)
                            ForEach(groups.waitingOn) { CommitmentRow(item: $0) }
                        }
                        if !groups.iOwe.isEmpty {
                            ColumnHeader(title: "I OWE")
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
                .buttonStyle(.plain).foregroundStyle(Theme.textDim).help("Mark done")
                .accessibilityLabel("Mark done: \(item.title)")
                .opacity(hovering ? 1 : 0)
            Button {
                Task { await model.resolveCommitment(item, as: "DISMISSED") }
            } label: { Image(systemName: "xmark").iconTarget() }
                .buttonStyle(.plain).foregroundStyle(Theme.textDim).help("Dismiss")
                .accessibilityLabel("Dismiss: \(item.title)")
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
    private var sender: String { decodeHTMLEntities(hit.from ?? "(unknown sender)") }
    @State private var hovering = false

    var body: some View {
        Button {
            Task { await model.selectSearchResult(hit) }
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(sender).font(.callout.weight(hit.isRead == false ? .semibold : .regular))
                        .foregroundStyle(Theme.text).lineLimit(1)
                    Spacer(minLength: 0)
                    if let date = hit.date {
                        Text(String(date.prefix(10)))
                            .font(.caption2.monospacedDigit()).foregroundStyle(Theme.textDim)
                    }
                }
                Text(hit.subject ?? "(no subject)")
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
        .accessibilityLabel("Search result from \(sender): \(hit.subject ?? "no subject")")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct FullRow: View {
    @Environment(AppModel.self) private var model
    let item: FirewallItem
    let actions: TopBarActions
    @FocusState private var focused: Bool

    private var selected: Bool { model.selectedItemId == item.id }
    private var sender: String { decodeHTMLEntities(item.email?.from ?? item.title) }
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 12) {
            // The select action is a real Button (role + keyboard + focus), not an
            // onTapGesture, so VoiceOver / Full-Keyboard-Access can open the message.
            Button { actions.onSelect(item) } label: {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(sender).font(.body.weight(.semibold))
                            .foregroundStyle(Theme.text).lineLimit(1)
                        Text(decodeHTMLEntities(item.email?.subject ?? item.title)).font(.callout)
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
                    TierMenu(item: item, onSetTier: actions.onSetTier) {
                        Color.clear.iconTarget()
                    }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                }
                .help("Move to tier… (teaches Klorn)")
                .accessibilityLabel("Change tier for message from \(sender), currently \(item.tier.label)")
                SnoozeMenu(item: item, onSnooze: actions.onSnooze) {
                    Image(systemName: "moon.zzz").iconTarget()
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .foregroundStyle(Theme.textDim).help("Snooze…")
                .accessibilityLabel("Snooze message from \(sender)")
                .opacity(hovering || selected || focused ? 1 : 0)
                Button { actions.onDismiss(item) } label: { Image(systemName: "xmark").iconTarget() }
                    .buttonStyle(.plain).foregroundStyle(Theme.textDim).help("Dismiss")
                    .accessibilityLabel("Dismiss message from \(sender)")
                    .opacity(hovering || selected || focused ? 1 : 0)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
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
                centered {
                    EmptyState(icon: "doc.text", title: "No preview for this item.")
                }
            } else {
                centered {
                    VStack(spacing: Theme.s4) {
                        Circle().strokeBorder(Theme.accent.opacity(0.35), lineWidth: 3)
                            .frame(width: 44, height: 44)
                            .accessibilityHidden(true)
                        Text("Nothing open").font(.title3).foregroundStyle(Theme.textDim)
                        Text("Pick a message on the left — read, reply,\nsnooze, and re-tier without leaving Klorn.")
                            .font(.caption).foregroundStyle(Theme.textDim.opacity(0.7))
                            .multilineTextAlignment(.center)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onChange(of: model.selectedItemId) { _, _ in replying = false; replyText = "" }
    }

    private func content(_ email: EmailDetail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Theme.s2) {
                Text(decodeHTMLEntities(email.subject ?? "(no subject)"))
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Theme.text).lineLimit(2)
                HStack {
                    Text(decodeHTMLEntities(email.from ?? ""))
                        .font(.callout).foregroundStyle(Theme.textDim).lineLimit(1)
                    Spacer()
                    Text(Self.formatDate(email.date)).font(.caption).foregroundStyle(Theme.textDim)
                }
                if let item {
                    HStack(spacing: 10) {
                        Button("Reply with AI") { startReply(item) }
                            .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
                        Button("Open in web") { actions.onOpenWeb(item) }
                            .buttonStyle(.bordered).controlSize(.small)
                        // menuIndicator(.hidden) kills the system-blue pull-down
                        // segment (the one off-palette element on this row —
                        // design audit 2026-07-20); a dim chevron in the label
                        // keeps the "this opens a menu" affordance.
                        SnoozeMenu(item: item, onSnooze: actions.onSnooze) {
                            HStack(spacing: 4) {
                                Text("Snooze")
                                Image(systemName: "chevron.down")
                                    .font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
                            }
                        }
                        .menuStyle(.button).buttonStyle(.bordered).controlSize(.small)
                        .menuIndicator(.hidden).fixedSize()
                        TierMenu(item: item, onSetTier: actions.onSetTier) {
                            HStack(spacing: 4) {
                                Text("Move to \(item.tier.label)")
                                Image(systemName: "chevron.down")
                                    .font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
                            }
                        }
                        .menuStyle(.button).buttonStyle(.bordered).controlSize(.small)
                        .menuIndicator(.hidden).fixedSize()
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
                // Reading typography: measured line length (~640pt) and open
                // line spacing — a mail body should read like a document, not
                // a log dump stretched across the pane.
                Text(email.text.isEmpty ? "(no content)" : email.text)
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
                .padding(Theme.s2)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.field))
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
