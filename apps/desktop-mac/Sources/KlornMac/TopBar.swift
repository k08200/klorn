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
    /// Sender pin — "this sender is ALWAYS this lane" (a rule the judge obeys
    /// before any prediction, unlike corrections which only train a prior).
    let onPinSender: (FirewallItem, Tier) -> Void
    /// Remove the sender's pin; triage goes back to learned/predicted tiers.
    let onUnpinSender: (FirewallItem) -> Void
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
    /// Smallest expanded panel a drag-resize may reach. 720 keeps the tier
    /// columns readable; anything narrower belongs to the pill.
    static let expandedMin = NSSize(width: 720, height: 300)
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
        // Root safety net: NSHostingView centers a root whose minimum exceeds
        // the window, which clips the app's own header row first. Pin to the
        // top so any overflow is always cut at the bottom instead.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
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

/// Sidebar feature-row icon: a tinted rounded container in the System
/// Settings idiom. Two rules against the generic-AI look (founder
/// 2026-08-21, second pass): the GLYPH must carry product meaning — never
/// the first-search default (sparkles is banned; the assistant is a
/// conversation, a promise is a seal, a proposal awaits a signature) —
/// and the TINT comes from the palette's existing SEMANTIC tokens (engage =
/// relationships, accent = Klorn asking to act, meeting green = schedule),
/// so variety reads as meaning, not as a template rainbow.
/// Sidebar glyph container. Monochrome by default (pass 2026-08-25): nav
/// icons don't decorate. The exception is a glyph whose color IS data — the
/// 카테고리 rows pass their label tint (2026-08-27), matching the chip the
/// same label wears on every row. Decorative tints stay banned.
struct FeatureIcon: View {
    let systemName: String
    var tint: Color? = nil
    var body: some View {
        RoundedRectangle(cornerRadius: 5, style: .continuous)
            .fill(tint.map { AnyShapeStyle($0.opacity(0.13)) }
                ?? AnyShapeStyle(Theme.surfaceRaised))
            .frame(width: 20, height: 20)
            .overlay(
                Image(systemName: systemName)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(tint ?? Theme.textDim))
            .accessibilityHidden(true)
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
        Text(title).font(Theme.Typo.micro)
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
    let onPinSender: (FirewallItem, Tier) -> Void
    let onUnpinSender: (FirewallItem) -> Void
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
            // Pins only make sense for mail (the judge keys them by sender).
            if item.email != nil {
                Divider()
                Menu(L("pin.always")) {
                    ForEach(Tier.displayOrder) { tier in
                        Button(tier.label) { onPinSender(item, tier) }
                    }
                }
                Button(L("pin.remove")) { onUnpinSender(item) }
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
                }
                // NOT an else-branch: a frozen board WITH push items used to
                // show no error at all, forever — staleness matters MORE when
                // the user believes urgent items are live (2026-08-10, the
                // 403-freeze hole).
                if model.loadError != nil {
                    HStack(spacing: 5) {
                        Circle().fill(Theme.tint(.push).opacity(0.7)).frame(width: 6, height: 6)
                        Text(L("bar.offline")).font(.caption)
                    }
                    .foregroundStyle(Theme.textDim)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Theme.surfaceRaised, in: Capsule())
                } else if pushCount == 0 {
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
                ForEach(model.loginProviders.filter { $0 != "google" }, id: \.self) { provider in
                    Button(loginProviderLabel(provider)) {
                        Task { await model.signIn(provider: provider) }
                    }
                    .buttonStyle(.bordered)
                }
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
    let briefing: String?
    let structure: BriefingStructure?
    let onOpen: () -> Void

    var body: some View {
        Button { onOpen() } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 5) {
                    Image(systemName: "sun.max").font(.caption2).foregroundStyle(Theme.accent)
                        .accessibilityHidden(true)
                    Text(L("section.briefing")).font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
                    Spacer(minLength: 4)
                    if let date = structure?.dateLabel {
                        Text(date).font(Theme.Typo.micro).foregroundStyle(Theme.textDim)
                            .lineLimit(1)
                    }
                }
                if let structure {
                    // The day verdict — the one sentence worth reading first.
                    Text(structure.headline)
                        .font(Theme.Typo.head).foregroundStyle(Theme.text)
                        .lineLimit(2).multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if structure.curve.contains(where: { $0 > 0 }) {
                        BriefingSparkline(curve: structure.curve)
                            .frame(height: 22)
                            .accessibilityHidden(true)
                    }
                    BriefingSegmentsRow(segments: structure.segments)
                    if let top = structure.attention.first {
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Text("\(top.rank)").font(Theme.Typo.micro)
                                .foregroundStyle(Theme.textDim)
                            Text(top.action).font(.caption).foregroundStyle(Theme.text)
                                .lineLimit(1)
                        }
                    }
                } else if let briefing {
                    Text(briefing).font(.caption).foregroundStyle(Theme.text)
                        .lineLimit(3).multilineTextAlignment(.leading)
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
        .accessibilityLabel(L("briefing.a11y", structure?.headline ?? briefing ?? ""))
    }
}

/// Offscreen render harness: ImageRenderer draws ScrollView content as empty,
/// so `--render-previews` shoots the briefing card directly through this
/// internal wrapper instead of through TodayColumn.
struct BriefingCardRenderProbe: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        BriefingCard(briefing: model.briefing, structure: model.briefingStructure, onOpen: {})
            .padding(12)
    }
}

/// The day's intensity curve — a quiet line that rises where meetings stack.
/// Pure geometry from the server's hourly counts; no animation (it's a fact,
/// not a decoration), so Reduce Motion needs no branch.
private struct BriefingSparkline: View {
    let curve: [Int]

    var body: some View {
        GeometryReader { geo in
            let maxCount = max(curve.max() ?? 1, 1)
            let stepX = geo.size.width / CGFloat(max(curve.count - 1, 1))
            let points = curve.enumerated().map { i, c in
                CGPoint(
                    x: CGFloat(i) * stepX,
                    y: geo.size.height - (CGFloat(c) / CGFloat(maxCount)) * (geo.size.height - 3) - 1.5)
            }
            ZStack {
                Path { path in
                    guard let firstPoint = points.first else { return }
                    path.move(to: firstPoint)
                    for point in points.dropFirst() { path.addLine(to: point) }
                }
                .stroke(Theme.line, lineWidth: 1.5)
                ForEach(Array(points.enumerated()), id: \.offset) { i, point in
                    if curve[i] > 0 {
                        Circle().fill(Theme.accent).frame(width: 3.5, height: 3.5)
                            .position(point)
                    }
                }
            }
        }
    }
}

/// The 2-3 time-segment columns under the sparkline: label + measured summary,
/// hairline-divided. Server-localized text; busy segments carry the accent.
private struct BriefingSegmentsRow: View {
    let segments: [BriefingStructure.Segment]

    var body: some View {
        // Columns where they fit (expanded panel); the 220pt full-mode
        // sidebar can't hold three columns, so it stacks instead.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 0) {
                ForEach(Array(segments.enumerated()), id: \.offset) { i, seg in
                    if i > 0 {
                        Rectangle().fill(Theme.line)
                            .frame(width: 1).padding(.vertical, 1)
                            .padding(.horizontal, 7)
                    }
                    cell(seg).frame(minWidth: 76, maxWidth: .infinity, alignment: .leading)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                    cell(seg)
                }
            }
        }
        // Hug content height — otherwise the hairline dividers stretch the
        // row to fill whatever the parent proposes.
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func cell(_ seg: BriefingStructure.Segment) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(seg.label)
                .font(Theme.Typo.micro)
                .foregroundStyle(seg.kind == "busy" ? Theme.accent : Theme.textDim)
            Text(seg.summary)
                .font(.caption2).foregroundStyle(Theme.text)
                .lineLimit(2).multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
        }
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
        case day, month, year
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

    init(actions: TopBarActions, initialScope: Scope = .month, initialAnchor: Date = Date()) {
        self.actions = actions
        self.initialScope = initialScope
        self.initialAnchor = initialAnchor
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
        case .month, .day:
            let comps = c.dateComponents([.year, .month], from: anchor)
            let days = monthGridDays(year: comps.year ?? 2026, month: comps.month ?? 1, calendar: c)
            guard let first = days.first, let last = days.last else { return (anchor, anchor) }
            return (first, c.date(byAdding: .day, value: 1, to: last) ?? last)
        }
    }

    private var rangeTitle: String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = L10n.activeLocale
        switch scope {
        case .day: formatter.setLocalizedDateFormatFromTemplate("yMMMMdEEE")
        case .month: formatter.setLocalizedDateFormatFromTemplate("yMMMM")
        case .year: formatter.setLocalizedDateFormatFromTemplate("y")
        }
        return formatter.string(from: anchor)
    }

    private func step(_ direction: Int) {
        let component: Calendar.Component =
            switch scope {
            case .day: .day
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
            Text(rangeTitle).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                .contentTransition(.numericText())
            if model.calendarRangeLoading && !Theme.isRenderingOffscreen {
                ProgressView().controlSize(.mini)
            }
            Spacer()
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
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
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
        .padding(.horizontal, 24).padding(.vertical, 14)
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

    // MARK: 월 — the grid. Whole weeks, out-of-month days dim, today ringed.

    private var monthView: some View {
        let comps = calendar.dateComponents([.year, .month], from: anchor)
        let days = monthGridDays(year: comps.year ?? 2026, month: comps.month ?? 1,
                                 calendar: calendar)
        let todayKey = localDayKey(Date(), calendar: calendar)
        let symbols = orderedWeekdaySymbols
        let columns = Array(repeating: GridItem(.flexible(), spacing: 1), count: 7)
        return VStack(spacing: 0) {
            HStack(spacing: 1) {
                ForEach(symbols, id: \.self) { day in
                    Text(day).font(Theme.Typo.micro).foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.vertical, 6)
            Divider().overlay(Theme.line)
            LazyVGrid(columns: columns, spacing: 1) {
                ForEach(days, id: \.self) { day in
                    monthCell(day, inMonth: calendar.component(.month, from: day) == comps.month,
                              todayKey: todayKey)
                }
            }
            .background(Theme.line)
            Spacer(minLength: 0)
        }
    }

    private func monthCell(_ day: Date, inMonth: Bool, todayKey: String) -> some View {
        let key = localDayKey(day, calendar: calendar)
        let events = buckets[key] ?? []
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
                    Text(event.title)
                        .font(Theme.Typo.micro)
                        .foregroundStyle(inMonth ? Theme.text : Theme.textDim)
                        .lineLimit(1)
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.accent.opacity(inMonth ? 0.16 : 0.08),
                                    in: RoundedRectangle(cornerRadius: 3))
                }
                if events.count > 2 {
                    Text(L("cal.more", events.count - 2))
                        .font(Theme.Typo.micro).foregroundStyle(Theme.textDim)
                        .padding(.horizontal, 4)
                }
                Spacer(minLength: 0)
            }
            .padding(5)
            .frame(maxWidth: .infinity, minHeight: 84, alignment: .topLeading)
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
        if model.inboxes.count < 2,
           model.inboxes.contains(where: { $0.kind == "primary" && $0.needsReconnect }) {
            // Solo-account case: no selector renders, but a dead PRIMARY
            // token still needs a way back — this is the most common trigger
            // (2026-08-10 review). Same flow as the menu's primary button.
            Button(L("account.reconnectPrimary")) { Task { await model.reconnectPrimary() } }
                .buttonStyle(.plain)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.accentDeep)
                .help(L("account.reconnectPrimary"))
        }
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
                    // The PRIMARY account reconnects through the full-scope
                    // /google/start consent — the link-inbox flow would add a
                    // Pro-gated SECOND account instead of fixing the first
                    // (2026-08-10 diagnosis). Linked rows keep link-inbox.
                    if model.inboxes.contains(where: { $0.needsReconnect && $0.kind == "primary" }) {
                        Button(L("account.reconnectPrimary")) {
                            Task { await model.reconnectPrimary() }
                        }
                    }
                    if model.inboxes.contains(where: { $0.needsReconnect && $0.kind != "primary" }) {
                        Button(L("account.reconnect")) { Task { await model.addAccount() } }
                    }
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

/// Login button label per advertised provider id. Data-driven from
/// GET /api/auth/providers, so a provider the founder flips on later (naver)
/// appears WITHOUT an app update; an id the app has no string for degrades
/// to the capitalized id rather than hiding the button.
func loginProviderLabel(_ id: String) -> String {
    switch id {
    case "apple": L("auth.signInApple")
    case "naver": L("auth.signInNaver")
    default: id.capitalized
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
            if model.queue == nil {
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

/// Column 3 — account + resources.
private struct AccountColumn: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions
    @State private var updating = false
    /// Same stowing as the full sidebar: maintenance is occasional, the
    /// 380pt panel column doubly so.
    @State private var showMaintenance = false

    var body: some View {
        // The panel is a fixed 1140x380; this column grew past it when the
        // update/restart/diagnostics actions landed and the TOP silently
        // clipped (founder, 2026-08-10). Scroll instead of clip — never let
        // an added action push the header off-screen again.
        ScrollView(.vertical, showsIndicators: true) {
        VStack(alignment: .leading, spacing: 14) {
            ColumnHeader(title: L("prefs.section.account"))
            if model.phase == .signedIn {
                if let version = model.updateAvailable {
                    UpdateRow(version: version)
                }
                SubtleTextButton(title: L("prefs.account.signOut")) { actions.onSignOut() }
                // Always offered, not only when needsReconnect is already
                // true: a dead primary token is exactly the state where the
                // app cannot be trusted to know it is dead, and sending the
                // user to the web app to fix it is the bug we are closing.
                SubtleTextButton(title: L("account.reconnectPrimary")) {
                    Task { await model.reconnectPrimary() }
                }
                SubtleTextButton(title: L("account.add")) { Task { await model.addAccount() } }
                Divider()
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { showMaintenance.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Text(L("account.maintenance")).font(.callout).foregroundStyle(Theme.textDim)
                        Image(systemName: "chevron.right").font(.caption2)
                            .foregroundStyle(Theme.textDim)
                            .rotationEffect(showMaintenance ? .degrees(90) : .zero)
                            .accessibilityHidden(true)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("account.maintenance"))
                .accessibilityValue(showMaintenance ? L("a11y.expanded") : L("a11y.collapsed"))
                if showMaintenance {
                    SubtleTextButton(title: L("menu.checkUpdates")) {
                        Task { await model.checkForUpdateNow() }
                    }
                    if let result = model.updateCheckResult {
                        Text(result).font(.caption2).foregroundStyle(Theme.textDim)
                    }
                    SubtleTextButton(title: L("menu.restart")) { AppRestart.relaunch() }
                    SubtleTextButton(title: L("menu.diagnostics")) {
                        Task { await model.runDiagnostics() }
                    }
                    // Sits with diagnostics on purpose: someone who just ran a
                    // diagnostic and is still stuck needs the next step in the
                    // same place, not on a legal page they have no reason to open.
                    SubtleTextButton(title: L("menu.contactSupport")) { openSupportMail() }
                    DiagnosticsBlock()
                }
                if let error = model.linkAccountError {
                    Text(error).font(.caption2).foregroundStyle(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                // Same pre-OAuth purpose pick as the full sidebar — the
                // expanded panel is the other place a sign-in starts.
                PurposePickRow(horizontalPadding: 0)
                SubtleTextButton(title: L("auth.signInGoogle"), dim: false) { actions.onSignIn() }
                ForEach(model.loginProviders.filter { $0 != "google" }, id: \.self) { provider in
                    SubtleTextButton(title: loginProviderLabel(provider), dim: false) {
                        Task { await model.signIn(provider: provider) }
                    }
                }
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
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// "Tue, Aug 25 · 15:00–16:00" — shared by the team screen (ReadingPane has
/// a private twin; unify if a third caller appears).
private func slotRangeLabel(_ startIso: String, _ endIso: String) -> String {
    let iso = ISO8601DateFormatter()
    guard let start = iso.date(from: startIso), let end = iso.date(from: endIso) else {
        return startIso
    }
    let day = DateFormatter()
    day.setLocalizedDateFormatFromTemplate("EdMMM")
    let time = DateFormatter()
    time.setLocalizedDateFormatFromTemplate("HHmm")
    return "\(day.string(from: start)) · \(time.string(from: start))–\(time.string(from: end))"
}

/// Team mode's dedicated screen: manage teams, see when the WHOLE team is
/// free, and book the meeting from a slot. Booking is the approval — the
/// button names every invitee, and the POST goes to the human-approval
/// endpoint that actually sends invitations.
private struct TeamsColumn: View {
    @Environment(AppModel.self) private var model
    @State private var selectedTeamId: String?
    @State private var duration = 60
    @State private var meetingTitle = ""
    @State private var name = ""
    @State private var membersText = ""
    @State private var saving = false

    private var selectedTeam: TeamWire? { model.teams.first { $0.id == selectedTeamId } }

    var body: some View {
        OffscreenFriendlyScroll {
            VStack(alignment: .leading, spacing: 14) {
                Text(L("teams.title")).font(Theme.Typo.display).foregroundStyle(Theme.text)
                Text(L("teams.subtitle")).font(.caption).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)

                ForEach(model.teams) { team in
                    teamRow(team)
                }
                if model.teams.isEmpty {
                    Text(L("teams.empty")).font(.caption).foregroundStyle(Theme.textDim)
                }

                Divider().overlay(Theme.line)
                Text(L("teams.addHeader")).font(.caption.weight(.semibold)).foregroundStyle(Theme.textDim)
                TextField(L("teams.namePlaceholder"), text: $name)
                    .textFieldStyle(.roundedBorder).font(.callout)
                TextField(L("teams.membersPlaceholder"), text: $membersText)
                    .textFieldStyle(.roundedBorder).font(.callout)
                HStack(spacing: 8) {
                    Button(saving ? L("teams.saving") : L("teams.add")) {
                        saving = true
                        Task {
                            await model.createTeam(name: name, membersText: membersText)
                            if model.teamError == nil { name = ""; membersText = "" }
                            saving = false
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty
                              || membersText.trimmingCharacters(in: .whitespaces).isEmpty)
                    if let error = model.teamError {
                        Text(error).font(.caption2).foregroundStyle(Theme.textDim)
                    }
                }
                Text(L("teams.visibilityNote")).font(.caption2).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task { await model.refreshTeams() }
    }

    @ViewBuilder
    private func teamRow(_ team: TeamWire) -> some View {
        let isSelected = selectedTeamId == team.id
        VStack(alignment: .leading, spacing: 8) {
            Button {
                selectedTeamId = isSelected ? nil : team.id
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: isSelected ? "chevron.down" : "chevron.right")
                        .font(.caption2).foregroundStyle(Theme.textDim).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(team.name).font(.callout.weight(.medium)).foregroundStyle(Theme.text)
                        Text(team.members.joined(separator: ", "))
                            .font(.caption2).foregroundStyle(Theme.textDim).lineLimit(2)
                    }
                    Spacer()
                    Button(L("teams.remove")) { Task { await model.deleteTeam(id: team.id) } }
                        .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.textDim)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isSelected {
                HStack(spacing: 8) {
                    Picker("", selection: $duration) {
                        Text(L("teams.min30")).tag(30)
                        Text(L("teams.min60")).tag(60)
                    }
                    .pickerStyle(.segmented).labelsHidden().frame(width: 120)
                    Button(model.checkingTeamId == team.id ? L("teams.checking") : L("teams.findSlots")) {
                        Task { await model.checkTeamAvailability(teamId: team.id, durationMinutes: duration) }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(model.checkingTeamId != nil)
                }
                if let result = model.teamBookingResult {
                    Text(result).font(.caption).foregroundStyle(Theme.textDim)
                }
                if let availability = model.teamAvailability {
                    if !availability.unknownMembers.isEmpty {
                        Text(L("teams.unknown", availability.unknownMembers.joined(separator: ", ")))
                            .font(.caption2).foregroundStyle(Theme.textDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if availability.slots.isEmpty {
                        Text(L("teams.noSlots")).font(.caption).foregroundStyle(Theme.textDim)
                    } else {
                        TextField(L("teams.meetingTitlePlaceholder"), text: $meetingTitle)
                            .textFieldStyle(.roundedBorder).font(.callout)
                        ForEach(availability.slots) { slot in
                            HStack(spacing: 8) {
                                Text(slotRangeLabel(slot.startTime, slot.endTime))
                                    .font(.caption.monospacedDigit()).foregroundStyle(Theme.text)
                                Spacer()
                                // The button IS the approval: it names what it sends.
                                Button(L("teams.book", "\(team.members.count)")) {
                                    Task {
                                        _ = await model.bookTeamMeeting(
                                            title: meetingTitle.isEmpty ? team.name : meetingTitle,
                                            slot: slot, members: team.members)
                                    }
                                }
                                .buttonStyle(.bordered).controlSize(.small)
                            }
                        }
                        Text(L("teams.bookNote")).font(.caption2).foregroundStyle(Theme.textDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(10)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line))
    }
}

// MARK: - Full ("real app" window)

/// The largest state: a tier sidebar + a big scrollable list of the selected
/// tier — a real desktop-app view of the whole firewall.
/// What the full view's list column shows: a firewall tier, commitments, or
/// the assistant chat.
/// The full view's sidebar is one of two levels (mail-first shell
/// 2026-08-26): the root feature nav, or the mail client's own sidebar.
enum SidebarLevel: Equatable { case root, mail }

enum ListMode: Equatable, Hashable {
    /// The whole inbox as one chronological list — the default view. Lanes
    /// ride on the rows as chips and remain reachable behind the 레인 group.
    case inbox
    /// The inbox narrowed to one label category (what the mail IS — the
    /// sidebar's 카테고리 since 2026-08-27).
    case label(LabelFilter)
    case tier(Tier)
    /// A standard mail folder — Sent / Drafts / Archived (shell restructure
    /// 2026-08-26: every client in the reference set has these; a triage app
    /// without them doesn't read as "my mail, organized").
    case mailbox(MailboxKind)
    case commitments
    /// Actions Klorn wants approved. Approving these used to require the web
    /// app, which is what kept the agent receipt linking out of Klorn.
    case proposals
    /// The week as a first-class screen. The sidebar's TODAY/UPCOMING crumbs
    /// stay, but "what does my week look like" deserves the list column
    /// (founder, 2026-08-13: the calendar existed, it just wasn't visible).
    case calendar
    /// Team mode's dedicated screen (founder 2026-08-20: a paid mode must
    /// not live in a settings corner) — teams, whole-team availability, and
    /// booking. Rendered only while the server grants team mode.
    case teams
}

struct FullView: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    var body: some View {
        // The list mode lives on the model, not in @State: opening the full
        // view from somewhere else — a tier count in the compact panel, an
        // urgent-mail card — has to be able to say which tier to land on.
        @Bindable var model = model

        // .top: if the content's minimum ever exceeds the window again, the
        // overflow must clip at the BOTTOM — a centered ZStack ate the header
        // first (clipping screenshots, 2026-08-20).
        ZStack(alignment: .top) {
            // Sky stays BEHIND the surface only as depth for the 10%
            // translucency — it must never show as a margin. The old "card
            // lifted off the sky" inset read as a thick bright frame around
            // the dark panel (founder, 2026-08-22: "테두리 그대로 있는데?")
            // — content now runs edge-to-edge like every serious mail client.
            AmbientBackdrop()
            VStack(spacing: 0) {
                header
                Rectangle().fill(Theme.line).frame(height: 1)
                HStack(spacing: 0) {
                    FullSidebar(selected: $model.listMode, actions: actions).frame(width: 220)
                    Rectangle().fill(Theme.line).frame(width: 1)
                    FullList(mode: model.listMode, actions: actions).frame(width: 420)
                    Rectangle().fill(Theme.line).frame(width: 1)
                    ReadingPane(actions: actions).frame(maxWidth: .infinity)
                }
            }
            // ONE surface, header included — any band around the header reads
            // as chrome-on-chrome.
            .background(Theme.panelGradient(opacity: 0.90))
            // Modal overlays block POINTER input with the scrim, but Tab/
            // VoiceOver traversal follows the view tree — disable the
            // background so keyboard focus can't wander behind the modal.
            .disabled(model.showCompose || model.showPreferences || model.showTierGuide)
            .onAppear {
                model.presentTierGuideIfFirstRun()
                model.presentPurposePromptIfNeeded()
            }
            // The dock rides above the columns but BELOW the modal overlays:
            // a modal is something the user just asked for.
            if model.phase == .signedIn
                && !model.showCompose && !model.showPreferences && !model.showTierGuide
            {
                AssistantDock()
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            }
            if model.showCompose && !model.showPreferences {
                Theme.text.opacity(0.45)
                    .onTapGesture { if !model.composeSending { model.showCompose = false } }
                    .accessibilityHidden(true)
                ComposePanel()
            }
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
            // The connect-time purpose question — below the guide and
            // Preferences in priority (both are things the user asked for or
            // must read first).
            if model.showPurposePrompt && !model.showPreferences && !model.showTierGuide
                && !model.showCompose
            {
                Theme.text.opacity(0.45)
                    .onTapGesture { model.dismissPurposePrompt() }
                    .accessibilityHidden(true)
                PurposePrompt()
            }
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

            AppearanceToggle()

            // One click OUT from anywhere (dogfood 2026-07-20).
            Button(action: actions.onClose) {
                Image(systemName: "xmark").font(.callout.weight(.semibold)).iconTarget()
            }
            .buttonStyle(.plain).hoverDim()
            .padding(.leading, 6)
            .help(L("bar.close"))
            .accessibilityLabel(L("bar.close.a11y"))
        }
        // A plain row of the ONE window surface — no capsule, no stroke, no
        // shadow. The old floating-pill header was chrome-on-chrome once the
        // content went edge-to-edge (its ground is now the same panelGradient,
        // so the slate-500 contrast argument holds unchanged).
        .padding(.horizontal, 18)
        .frame(height: 48)
    }
}

/// Draggable boundary above the ACCOUNT section: dragging up grows the
/// account area, the TODAY/UPCOMING scroll region flexes to absorb it.
/// Height persists via AppSettings. VoiceOver adjusts in 20pt steps.
/// ScrollView at runtime; a plain container under the offscreen design
/// renderer, which cannot draw ScrollView content (PreviewRender note).
private struct OffscreenFriendlyScroll<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        if Theme.isRenderingOffscreen {
            content()
        } else {
            ScrollView(showsIndicators: true) { content() }
        }
    }
}

/// Reports a view's laid-out height so a capped section's drag can clamp to
/// real content (a cap beyond content is a dead zone the cursor rubber-bands
/// through).
private struct SectionHeightKey: PreferenceKey {
    nonisolated(unsafe) static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private extension View {
    func measureSectionHeight(_ into: @escaping (CGFloat) -> Void) -> some View {
        background(
            GeometryReader { geo in
                Color.clear.preference(key: SectionHeightKey.self, value: geo.size.height)
            }
        )
        .onPreferenceChange(SectionHeightKey.self) { into($0) }
    }
}

private struct SectionResizeHandle: View {
    @Binding var height: Double
    /// True when the resizable section sits ABOVE this handle (dragging the
    /// boundary DOWN should grow it). False = section below (account), where
    /// dragging UP grows. The account handle shipped first and set the
    /// up=grow default; the today handle reused it unflipped, which is why
    /// it felt dead in the wrong direction (dogfood 2026-08-19).
    var growsDown = false

    @State private var hovering = false

    var body: some View {
        ZStack {
            // AppKit-level drag surface: the panel is movable-by-background,
            // and AppKit claims a drag on any non-refusing view as a WINDOW
            // MOVE before SwiftUI's DragGesture ever fires (v0.4.80040 bug —
            // the handle "did nothing"). An NSView that answers
            // mouseDownCanMoveWindow=false is the only reliable refusal.
            ResizeDragSurface(
                startHeight: { height }, apply: { height = $0 }, growsDown: growsDown)
            // macOS-divider look: a hairline across the column with a centred
            // grabber that answers hover — visibly a control, not lint.
            // Quiet at rest (founder 2026-08-21: four identical grabbers
            // stacked read as clutter): the boundary is just a hairline until
            // hovered — then the hairline yields to the accent grabber. One
            // boundary, one line, and the affordance appears where the
            // pointer already is.
            VStack(spacing: 0) {
                Rectangle().fill(Theme.line.opacity(hovering ? 0 : 1))
                    .frame(height: 1)
            }
            .allowsHitTesting(false)
            Capsule()
                .fill(Theme.accent.opacity(0.85))
                .frame(width: 44, height: 5)
                .opacity(hovering ? 1 : 0)
                .animation(.easeOut(duration: 0.12), value: hovering)
                .allowsHitTesting(false)
        }
        .frame(height: 14)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .accessibilityElement()
        .accessibilityLabel(L("sidebar.resize.a11y"))
        .accessibilityValue(Text("\(Int(height))"))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: height += 20
            case .decrement: height -= 20
            @unknown default: break
            }
        }
    }
}

private struct ResizeDragSurface: NSViewRepresentable {
    let startHeight: () -> Double
    let apply: (Double) -> Void
    var growsDown = false

    func makeNSView(context _: Context) -> ResizeDragNSView {
        let view = ResizeDragNSView()
        view.startHeight = startHeight
        view.apply = apply
        view.growsDown = growsDown
        return view
    }

    func updateNSView(_ view: ResizeDragNSView, context _: Context) {
        view.startHeight = startHeight
        view.apply = apply
        view.growsDown = growsDown
    }
}

final class ResizeDragNSView: NSView {
    var startHeight: () -> Double = { 0 }
    var apply: (Double) -> Void = { _ in }
    var growsDown = false
    private var dragStartHeight: Double = 0
    private var dragStartScreenY: CGFloat = 0

    // The whole point: refuse the window-move claim so the drag is OURS.
    override var mouseDownCanMoveWindow: Bool { false }

    override func mouseDown(with _: NSEvent) {
        dragStartHeight = startHeight()
        dragStartScreenY = NSEvent.mouseLocation.y
    }

    override func mouseDragged(with _: NSEvent) {
        // Screen Y grows upward on macOS. For a section BELOW the handle
        // (account), dragging up (positive dy) grows it; for a section ABOVE
        // (수신함/오늘/예정), dragging down grows it — hence the sign flip.
        let dy = NSEvent.mouseLocation.y - dragStartScreenY
        apply(dragStartHeight + (growsDown ? -Double(dy) : Double(dy)))
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .resizeUpDown)
    }
}

private struct FullSidebar: View {
    @Environment(AppModel.self) private var model
    @Binding var selected: ListMode
    let actions: TopBarActions
    /// Maintenance actions + diagnostics live behind a disclosure — the
    /// account section is daily-use identity actions; update/restart/health
    /// are occasional and were crowding the sidebar (founder, 2026-08-14).
    @State private var showMaintenance = false
    /// Filed-lanes disclosure (INFO/SILENT/legacy AUTO). Session-scoped; a
    /// selection inside the group keeps it open regardless.
    @State private var filedExpanded = false
    /// 레인 disclosure (mail level). Session-scoped; a lane selection keeps
    /// the group open regardless.
    @State private var lanesExpanded = false
    /// Real laid-out content heights — caps clamp to these so a drag never
    /// wanders into a dead zone past the content (dogfood 2026-08-19).
    @State private var navContentHeight: CGFloat = 0
    @State private var todayContentHeight: CGFloat = 0
    @State private var upcomingContentHeight: CGFloat = 0
    @State private var accountContentHeight: CGFloat = 0

    private func tierCount(_ tier: Tier) -> Int { model.queue?.summary.count(for: tier) ?? 0 }

    private func purposeLabel(_ purpose: String?) -> String {
        switch purpose {
        case "work": L("purpose.work")
        case "personal": L("purpose.personal")
        case "mixed": L("purpose.mixed")
        default: L("purpose.unset")
        }
    }

    private func setPurpose(_ inbox: InboxOption, _ purpose: String) {
        Task { await model.setInboxPurpose(inboxId: inbox.id, purpose: purpose) }
    }

    /// One tier row — shared by the primary lanes and the filed group
    /// (indented so the hierarchy reads at a glance).
    private func tierRow(_ tier: Tier, indented: Bool = false) -> some View {
        Button { selected = .tier(tier) } label: {
            HStack(spacing: 10) {
                // 20pt slot so tier dots and FeatureIcon containers share one
                // text column — mixed leading widths read as misalignment.
                Circle().fill(Theme.tint(tier)).frame(width: 8, height: 8)
                    .frame(width: 20)
                Text(tier.label)
                    .font(.body.weight(selected == .tier(tier) ? .semibold : .regular))
                    .foregroundStyle(Theme.text)
                Spacer()
                Text("\(tierCount(tier))")
                    .font(Theme.Typo.numeric).foregroundStyle(Theme.textDim)
                    .contentTransition(.numericText())
                    .animation(.default, value: tierCount(tier))
            }
            .padding(.leading, indented ? 14 : 0)
            .modifier(SidebarRowChrome(selected: selected == .tier(tier)))
        }
        .buttonStyle(.plain)
        .help(tier.blurb)
        .accessibilityLabel(L("tier.row.a11y", tier.label, tierCount(tier), tier.blurb))
    }

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
        // The whole column scrolls when the window is shorter than the
        // sections' minimum (user-grown caps + fixed clusters). Without this
        // the overflow was clipped — top-first, eating the inbox header
        // (clipping screenshots, 2026-08-20). minHeight: available keeps the
        // Spacer pinning the bottom cluster whenever there IS room.
        GeometryReader { geo in
            OffscreenFriendlyScroll {
                sidebarColumn
                    .frame(minHeight: geo.size.height, alignment: .top)
            }
        }
    }

    private var sidebarColumn: some View {
        VStack(alignment: .leading, spacing: 4) {
            // ONE sidebar, two levels (mail-first shell 2026-08-26). The root
            // level is the feature nav; entering 메일 swaps the whole column
            // for the mail client's own sidebar with a Back row — the
            // reference clients' pattern, and the fix for the founder's
            // complaint that two stacked nav groups read as two sidebars.
            if model.sidebarLevel == .mail {
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { model.sidebarLevel = .root }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "chevron.left").font(.caption.weight(.semibold))
                        Text(L("nav.back")).font(.body)
                        Spacer()
                    }
                    .modifier(SidebarRowChrome(selected: false))
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 8)
                .accessibilityLabel(L("nav.back"))

                // Compose leads the mail sidebar — every client in the
                // reference set puts a full-width compose control above the
                // folder list. ⌘N already existed; now it has a face.
                Button {
                    model.showCompose = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: 12, weight: .semibold))
                        Text(L("compose.new")).font(.system(size: 12, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .padding(.horizontal, 20).padding(.top, 2).padding(.bottom, 10)
                .accessibilityLabel(L("compose.new"))

            } else {
                ColumnHeader(title: L("nav.workspace"))
                    .padding(.horizontal, 20).padding(.top, 6).padding(.bottom, 6)
            }
            // 수신함 nav block: capped + scrollable so its boundary is
            // draggable like every other section (founder 2026-08-19). The
            // cap is a MAX — short content keeps its natural height.
            // (ImageRenderer draws nothing inside a ScrollView — the design
            // renderer gets the plain stack, same rows.)
            OffscreenFriendlyScroll {
                VStack(alignment: .leading, spacing: 4) {
                if model.sidebarLevel == .mail {
                // The inbox itself — one chronological list; the default.
                Button {
                    selected = .inbox
                } label: {
                    HStack(spacing: 10) {
                        FeatureIcon(systemName: "tray")
                        Text(L("section.inbox"))
                            .font(.body.weight(selected == .inbox ? .semibold : .regular))
                            .foregroundStyle(Theme.text)
                        Spacer()
                        Text("\(model.queue?.summary.total ?? 0)")
                            .font(Theme.Typo.numeric).foregroundStyle(Theme.textDim)
                    }
                    .modifier(SidebarRowChrome(selected: selected == .inbox))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("section.inbox"))

                // The standard folders every mail client has. Live Gmail
                // views — not part of the queue poll.
                ForEach(MailboxKind.allCases) { box in
                    Button { selected = .mailbox(box) } label: {
                        HStack(spacing: 10) {
                            FeatureIcon(systemName: box.icon)
                            Text(box.label)
                                .font(.body.weight(selected == .mailbox(box) ? .semibold : .regular))
                                .foregroundStyle(Theme.text)
                            Spacer()
                            if let count = model.mailboxItems[box]?.count {
                                Text("\(count)")
                                    .font(Theme.Typo.numeric).foregroundStyle(Theme.textDim)
                            }
                        }
                        .modifier(SidebarRowChrome(selected: selected == .mailbox(box)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(box.label)
                }

                // 카테고리, by what a mail IS (founder 2026-08-27: follow
                // the labeling) — the same vocabulary as the row chips and
                // Gmail's own tabs. Counts run over the fetched window, the
                // same set a click shows, so the number and the list can
                // never disagree.
                ColumnHeader(title: L("section.categories"))
                    .padding(.horizontal, 12).padding(.top, 14).padding(.bottom, 2)
                ForEach(LabelFilter.allCases) { filter in
                    let count = model.queue?.items(matching: filter).count ?? 0
                    if count > 0 || selected == .label(filter) {
                    Button { selected = .label(filter) } label: {
                        HStack(spacing: 10) {
                            FeatureIcon(systemName: filter.icon, tint: Theme.labelTint(filter))
                            Text(filter.label)
                                .font(.body.weight(selected == .label(filter) ? .semibold : .regular))
                                .foregroundStyle(Theme.text)
                            Spacer()
                            Text("\(count)")
                                .font(Theme.Typo.numeric).foregroundStyle(Theme.textDim)
                                .contentTransition(.numericText())
                                .animation(.default, value: count)
                        }
                        .modifier(SidebarRowChrome(selected: selected == .label(filter)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(filter.label). \(count)")
                    }
                }

                // The attention axis — the lanes — one click behind a
                // disclosure. Not gone: every row still wears its lane chip,
                // and a lane deep-link (a push card, a tier count) lands here
                // with the group held open. The guide ⓘ rides this header —
                // it explains exactly these rows.
                let laneHoldsSelection: Bool = {
                    if case .tier = selected { return true }
                    return false
                }()
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { lanesExpanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        ColumnHeader(title: L("section.lanes"))
                        Image(systemName: "chevron.right").font(.caption2)
                            .foregroundStyle(Theme.textDim)
                            .rotationEffect((lanesExpanded || laneHoldsSelection) ? .degrees(90) : .zero)
                            .accessibilityHidden(true)
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
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12).padding(.top, 14).padding(.bottom, 2)
                .accessibilityLabel(L("section.lanes"))
                .accessibilityValue((lanesExpanded || laneHoldsSelection) ? L("a11y.expanded") : L("a11y.collapsed"))
                if lanesExpanded || laneHoldsSelection {
                    ForEach(Tier.visibleOrder(counts: tierCount)) { tier in
                        tierRow(tier)
                    }
                }
                } else {
                // Root feature nav. 메일 enters the mail level; a mail-family
                // selection keeps this row lit so location stays visible.
                let inMail: Bool = {
                    switch selected {
                    case .inbox, .tier, .mailbox: true
                    default: false
                    }
                }()
                Button {
                    if !inMail { selected = .inbox }
                    withAnimation(.easeOut(duration: 0.15)) { model.sidebarLevel = .mail }
                } label: {
                    HStack(spacing: 10) {
                        FeatureIcon(systemName: "envelope")
                        Text(L("nav.mail"))
                            .font(.body.weight(inMail ? .semibold : .regular))
                            .foregroundStyle(Theme.text)
                        Spacer()
                        Text("\(model.queue?.summary.total ?? 0)")
                            .font(Theme.Typo.numeric).foregroundStyle(Theme.textDim)
                        Image(systemName: "chevron.right").font(.caption2)
                            .foregroundStyle(Theme.textDim)
                            .accessibilityHidden(true)
                    }
                    .modifier(SidebarRowChrome(selected: inMail))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("nav.mail"))

                // Commitments: promises made / replies awaited — the follow-through
                // half of the firewall (what mail asked of you, and of them).
                Button { selected = .commitments } label: {
                    HStack(spacing: 10) {
                        FeatureIcon(systemName: "checkmark.seal")
                        Text(L("section.commitments"))
                            .font(.body.weight(selected == .commitments ? .semibold : .regular))
                            .foregroundStyle(Theme.text)
                        Spacer()
                        Text("\(model.commitments?.count ?? 0)")
                            .font(Theme.Typo.numeric).foregroundStyle(Theme.textDim)
                    }
                    .modifier(SidebarRowChrome(selected: selected == .commitments))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("commitments.a11y", model.commitments?.count ?? 0))

                // Proposals: what Klorn wants to do and hasn't done yet.
                // Zero-hide (founder 2026-08-20: rows must earn their place);
                // a live selection keeps the row while the last item clears.
                if model.pendingActions.count > 0 || selected == .proposals {
                Button { selected = .proposals } label: {
                    HStack(spacing: 10) {
                        FeatureIcon(systemName: "signature")
                        Text(L("proposals.title"))
                            .font(.body.weight(selected == .proposals ? .semibold : .regular))
                            .foregroundStyle(Theme.text)
                        Spacer()
                        Text("\(model.pendingActions.count)")
                            .font(Theme.Typo.numeric).foregroundStyle(Theme.textDim)
                    }
                    .modifier(SidebarRowChrome(selected: selected == .proposals))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("proposals.a11y", model.pendingActions.count))
                }

                // Team mode: paid capability — the row exists only while the
                // server grants it (teamModeAvailable via /api/teams probe).
                if model.teamModeAvailable {
                    Button { selected = .teams } label: {
                        HStack(spacing: 10) {
                            FeatureIcon(systemName: "person.2")
                            Text(L("teams.title"))
                                .font(.body.weight(selected == .teams ? .semibold : .regular))
                                .foregroundStyle(Theme.text)
                            Spacer()
                            Text("\(model.teams.count)")
                                .font(Theme.Typo.numeric).foregroundStyle(Theme.textDim)
                        }
                        .modifier(SidebarRowChrome(selected: selected == .teams))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("teams.title"))
                }

                // Calendar: the week as a full list-column screen, not just the
                // TODAY/UPCOMING crumbs below.
                Button { selected = .calendar } label: {
                    HStack(spacing: 10) {
                        FeatureIcon(systemName: "calendar")
                        Text(L("section.calendar"))
                            .font(.body.weight(selected == .calendar ? .semibold : .regular))
                            .foregroundStyle(Theme.text)
                        Spacer()
                    }
                    .modifier(SidebarRowChrome(selected: selected == .calendar))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("section.calendar"))
                }
                }
            }
            .frame(maxHeight: model.sidebarLevel == .mail
                ? .infinity : model.settings.inboxSectionHeight)
            .fixedSize(horizontal: false, vertical: true)
            .measureSectionHeight { navContentHeight = $0 }
            if model.sidebarLevel == .root {
                SectionResizeHandle(
                    height: Binding(
                        get: { min(model.settings.inboxSectionHeight, max(Double(navContentHeight), 180)) },
                        set: { model.settings.inboxSectionHeight = AppSettings.resolveInboxSectionHeight($0) }
                    ),
                    growsDown: true)
            }

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
                    .padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 6)
            }
            // Every section boundary is user-draggable (founder 2026-08-18:
            // "섹션마다 크기 조절"): TODAY has its own persisted height, the
            // handle below it trades space with UPCOMING, and the account
            // handle at the bottom trades with everything above.
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 8) {
                    if model.briefing != nil || model.briefingStructure != nil {
                        BriefingCard(briefing: model.briefing, structure: model.briefingStructure) {
                            actions.onOpenFull()
                        }
                        .padding(.horizontal, 12)
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
                    .padding(.bottom, 8)
                }
            }
            // A CAP, not a fixed height: short content collapses to its own
            // size (no dead gap — dogfood 2026-08-18); the handle sets how
            // much TODAY may take before UPCOMING starts.
            .frame(maxHeight: hasToday ? model.settings.todaySectionHeight : 0)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .measureSectionHeight { todayContentHeight = $0 }
            if hasToday {
                SectionResizeHandle(
                    height: Binding(
                        get: { min(model.settings.todaySectionHeight, max(Double(todayContentHeight), 120)) },
                        set: { model.settings.todaySectionHeight = AppSettings.resolveTodaySectionHeight($0) }
                    ),
                    growsDown: true)
            }
            ScrollView(showsIndicators: false) {
                UpcomingSection(actions: actions).padding(.horizontal, 12).padding(.bottom, 8)
            }
            .frame(maxHeight: model.settings.upcomingSectionHeight)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .measureSectionHeight { upcomingContentHeight = $0 }
            SectionResizeHandle(
                height: Binding(
                    get: { min(model.settings.upcomingSectionHeight, max(Double(upcomingContentHeight), 100)) },
                    set: { model.settings.upcomingSectionHeight = AppSettings.resolveUpcomingSectionHeight($0) }
                ),
                growsDown: true)
            Spacer(minLength: 0)

            SectionResizeHandle(
                height: Binding(
                    // Clamp to real content so a drag can't wander into a dead
                    // zone past what the section can actually show.
                    get: {
                        min(
                            model.settings.accountSectionHeight,
                            max(Double(accountContentHeight), 120))
                    },
                    set: { model.settings.accountSectionHeight = AppSettings.resolveAccountSectionHeight($0) }
                ))
            // One-click 기본/Auto switch, right in the sidebar (founder
            // 2026-08-18: the mode must not hide inside Preferences).
            if model.phase == .signedIn {
                HStack(spacing: 8) {
                    Text(L("mode.section")).font(.caption).foregroundStyle(Theme.textDim)
                    Picker(L("mode.sidebar.a11y"), selection: Binding(
                        get: { model.automation.attentionMode },
                        set: { mode in model.updateAutomation { $0.attentionMode = mode } }
                    )) {
                        ForEach(AttentionMode.allCases, id: \.self) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .disabled(model.automationSaving)
                    .accessibilityLabel(L("mode.sidebar.a11y"))
                }
                .padding(.horizontal, 20).padding(.vertical, 6)
            }
            ColumnHeader(title: L("prefs.section.account")).padding(.horizontal, 20).padding(.bottom, 6)
            // Own scroll area with a hard ceiling: the list above stays the
            // star, and the account actions can grow without running off the
            // bottom edge (founder, 2026-08-10).
            ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 0) {
            if model.phase == .signedIn {
                if let version = model.updateAvailable {
                    UpdateRow(version: version)
                }
                // Grouped: account identity / app lifecycle / diagnostics.
                // A flat 6-row list read as one undifferentiated pile
                // (founder, 2026-08-13).
                sidebarAction(L("prefs.account.signOut"), dim: true) { actions.onSignOut() }
                // Same reasoning as the expanded panel: reconnecting the
                // PRIMARY Google account is a first-class in-app action.
                sidebarAction(L("account.reconnectPrimary"), dim: true) {
                    Task { await model.reconnectPrimary() }
                }
                sidebarAction(L("account.add"), dim: true) { Task { await model.addAccount() } }
                // What each mailbox is FOR — feeds the analysis prompts. One
                // row per connected inbox; the menu writes immediately.
                ForEach(model.inboxes) { inbox in
                    HStack(spacing: 6) {
                        Text(inbox.email ?? L("purpose.primaryFallback"))
                            .font(.caption).foregroundStyle(Theme.textDim)
                            .lineLimit(1).truncationMode(.middle)
                        Spacer()
                        if Theme.isRenderingOffscreen {
                            Text(purposeLabel(inbox.purpose))
                                .font(Theme.Typo.label).foregroundStyle(Theme.text)
                        } else {
                            Menu {
                                Button(L("purpose.work")) { setPurpose(inbox, "work") }
                                Button(L("purpose.personal")) { setPurpose(inbox, "personal") }
                                Button(L("purpose.mixed")) { setPurpose(inbox, "mixed") }
                            } label: {
                                Text(purposeLabel(inbox.purpose))
                                    + Text(Image(systemName: "chevron.down"))
                                    .font(.caption2.weight(.semibold))
                            }
                            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                            .font(Theme.Typo.label).foregroundStyle(Theme.text)
                        }
                    }
                    .padding(.horizontal, 20).padding(.vertical, 3)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(
                        "\(inbox.email ?? ""). \(purposeLabel(inbox.purpose))")
                }
                Divider().padding(.horizontal, 16).padding(.vertical, 4)
                maintenanceDisclosureRow
                if showMaintenance {
                    // The full window had no way to ASK for an update — the
                    // row only appeared if a check had already found one.
                    sidebarAction(L("menu.checkUpdates"), dim: true) {
                        Task { await model.checkForUpdateNow() }
                    }
                    // Feedback sits NEXT TO its trigger, not below the
                    // diagnostics dump (founder, 2026-08-15).
                    if let result = model.updateCheckResult {
                        Text(result).font(.caption2).foregroundStyle(Theme.textDim)
                            .padding(.horizontal, 20)
                    }
                    sidebarAction(L("menu.restart"), dim: true) { AppRestart.relaunch() }
                    // The app must be able to answer "why is mail stuck" itself.
                    sidebarAction(L("menu.diagnostics"), dim: true) {
                        Task { await model.runDiagnostics() }
                    }
                    sidebarAction(L("menu.contactSupport"), dim: true) { openSupportMail() }
                    DiagnosticsBlock().padding(.horizontal, 20)
                }
                if let error = model.linkAccountError {
                    Text(error).font(.caption2).foregroundStyle(Theme.textDim)
                        .padding(.horizontal, 20)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                // Pick the mailbox's purpose BEFORE OAuth (founder: "로그인
                // 하면서 고르게") — the answer is applied the moment sign-in
                // lands. Optional: skipping it falls back to the one-question
                // card after login.
                PurposePickRow(horizontalPadding: 20)
                sidebarAction(L("auth.signInGoogle")) { actions.onSignIn() }
                ForEach(model.loginProviders.filter { $0 != "google" }, id: \.self) { provider in
                    sidebarAction(loginProviderLabel(provider)) {
                        Task { await model.signIn(provider: provider) }
                    }
                }
            }
            sidebarAction(L("guide.reopen"), dim: true) { model.showTierGuide = true }
            sidebarAction(L("prefs.title"), dim: true) { model.showPreferences = true }
            }
            }
            // A CAP, not a fixed height (same rule as TODAY/UPCOMING): short
            // content collapses to its own size instead of holding a dead gap
            // below 환경설정 (founder, 2026-08-22).
            .frame(maxHeight: CGFloat(model.settings.accountSectionHeight))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .measureSectionHeight { accountContentHeight = $0 }
        }
        .padding(.horizontal, 8).padding(.vertical, 18)
    }

    /// Disclosure row for the maintenance group — same chrome as the action
    /// rows, plus a rotating chevron so the collapsed state is discoverable.
    private var maintenanceDisclosureRow: some View {
        Button {
            withAnimation(.easeOut(duration: 0.15)) { showMaintenance.toggle() }
        } label: {
            HStack(spacing: 6) {
                Text(L("account.maintenance")).font(.body).foregroundStyle(Theme.textDim)
                Image(systemName: "chevron.right").font(.caption2)
                    .foregroundStyle(Theme.textDim)
                    .rotationEffect(showMaintenance ? .degrees(90) : .zero)
                    .accessibilityHidden(true)
                Spacer()
            }
            .padding(.horizontal, 12).padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L("account.maintenance"))
        .accessibilityValue(showMaintenance ? L("a11y.expanded") : L("a11y.collapsed"))
    }

    private func sidebarAction(_ title: String, dim: Bool = false, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(title).font(.body).foregroundStyle(dim ? Theme.textDim : Theme.text)
                .padding(.horizontal, 12).padding(.vertical, 5)
                .frame(maxWidth: .infinity, alignment: .leading)
        }.buttonStyle(.plain)
    }
}

/// Open the user's mail client on the pinned support address.
///
/// k0820086@gmail.com, not anything @klorn.ai: the domain has no MX record, so
/// a klorn.ai address would bounce silently. The subject carries the app
/// version so a report arrives with the one fact every triage starts from.
@MainActor
func openSupportMail() {
    let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
    var components = URLComponents()
    components.scheme = "mailto"
    components.path = "k0820086@gmail.com"
    components.queryItems = [URLQueryItem(name: "subject", value: "Klorn for Mac \(version)")]
    guard let url = components.url else { return }
    NSWorkspace.shared.open(url)
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
    private var inboxMode: Bool { mode == .inbox }
    private var labelFilter: LabelFilter? {
        if case .label(let f) = mode { return f }
        return nil
    }
    /// Mixed-lane surfaces (the chronological inbox and every label filter)
    /// carry the lane on each row.
    private var mixedLanes: Bool { inboxMode || labelFilter != nil }
    private var items: [FirewallItem] {
        if let filter = labelFilter { return model.queue?.items(matching: filter) ?? [] }
        return inboxMode ? (model.queue?.itemsByTime ?? []) : (model.queue?.items(for: tier) ?? [])
    }
    private var searching: Bool { isSearchActive(query) }

    @Environment(\.accessibilityReduceMotion) private var reduceMotionSwitch

    var body: some View {
        // P3: lane/screen switches crossfade instead of hard-cutting — the
        // last silent state change in the main window.
        Group {
            switch mode {
            case .commitments: CommitmentsList()
            case .proposals: ProposalsList()
            case .calendar: CalendarScreen(actions: actions)
            case .teams: TeamsColumn()
            case .inbox, .tier, .label: tierList
            case .mailbox(let box): MailboxList(box: box)
            }
        }
        .id(mode)
        .transition(.opacity)
        .animation(reduceMotionSwitch ? nil : .easeOut(duration: 0.15), value: mode)
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
                } else if let filter = labelFilter {
                    Image(systemName: filter.icon).font(.body).foregroundStyle(Theme.textDim)
                        .accessibilityHidden(true)
                    Text(filter.label).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                    Text("\(items.count)").font(.title3.monospacedDigit()).foregroundStyle(Theme.textDim)
                        .contentTransition(.numericText())
                        .animation(.default, value: items.count)
                } else if inboxMode {
                    Image(systemName: "tray").font(.body).foregroundStyle(Theme.textDim)
                        .accessibilityHidden(true)
                    Text(L("section.inbox")).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                    Text("\(items.count)").font(.title3.monospacedDigit()).foregroundStyle(Theme.textDim)
                        .contentTransition(.numericText())
                        .animation(.default, value: items.count)
                } else {
                    Circle().fill(Theme.tint(tier)).frame(width: 9, height: 9)
                    Text(tier.label).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                    Text("\(items.count)").font(.title3.monospacedDigit()).foregroundStyle(Theme.textDim)
                        .contentTransition(.numericText())
                        .animation(.default, value: items.count)
                }
                Spacer()
                InboxSelectorMenu()
                Button {
                    model.showCompose = true
                } label: {
                    Image(systemName: "square.and.pencil").font(.callout.weight(.medium))
                        .iconTarget(30)
                }
                .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                .keyboardShortcut("n", modifiers: .command)
                .help(L("compose.new"))
                .accessibilityLabel(L("compose.new"))
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
            } else if model.queue == nil {
                // Never claim "empty" before the first load (P1): the queue
                // hasn't arrived yet — say so, with placeholder rows.
                FirstSyncState()
                Spacer()
            } else if items.isEmpty {
                Spacer()
                if let filter = labelFilter {
                    EmptyState(icon: filter.icon, title: L("label.empty", filter.label))
                } else if inboxMode {
                    EmptyState(icon: "tray", title: L("inbox.empty"))
                } else {
                    EmptyState(icon: tier.emptyIcon, title: tier.emptyTitle, hint: tier.blurb)
                }
                Spacer()
            } else if Theme.isRenderingOffscreen {
                // ImageRenderer draws nothing inside a ScrollView, so the full
                // view rendered its mail column empty — a screenshot of the app
                // looking broken, which is what shipped to the landing page.
                // Same workaround already used for the rows and preferences
                // shots: lay the rows out directly when rendering offscreen.
                VStack(spacing: 0) {
                    ForEach(items) { item in
                        FullRow(item: item, actions: actions, showLaneChip: mixedLanes)
                        Divider().overlay(Theme.line).padding(.leading, 24)
                    }
                    Spacer(minLength: 0)
                }
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(items) { item in
                            FullRow(item: item, actions: actions, showLaneChip: mixedLanes)
                                .transition(rowTransition)
                            Divider().overlay(Theme.line).padding(.leading, 24)
                        }
                    }
                    // The one motion that carries product truth (P1): a new
                    // classification ARRIVES and a corrected row LEAVES for
                    // its new lane — state changes are never silent.
                    .animation(
                        reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.85),
                        value: items.map(\.id))
                }
            }
        }
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var rowTransition: AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .move(edge: .top).combined(with: .opacity),
                removal: .opacity)
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
/// The assistant column (sidebar tab): section header + the shared thread.
/// Thread + composer — the assistant itself, with no chrome of its own. Shared
/// by the sidebar tab and the floating dock so both stay one conversation
/// (the model owns the messages), and a fix lands in both at once.
private struct AssistantThread: View {
    var showsStarters = true
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if model.chatMessages.isEmpty {
                            VStack(spacing: Theme.s4) {
                                EmptyState(
                                    icon: "sparkles",
                                    title: L("assistant.empty"))
                                // One-click starters: discoverability beats a
                                // blank prompt. Each sends immediately. The
                                // dock is too narrow for them — it opens with
                                // the mail already in context instead.
                                if showsStarters {
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
                    // Invitees must be visible BEFORE approval — approving is
                    // what sends the invitations (team mode P2).
                    if let attendees = draft.attendees, !attendees.isEmpty {
                        Text(L("calendar.invitees", attendees.joined(separator: ", ")))
                            .font(.caption2).foregroundStyle(Theme.textDim).lineLimit(2)
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
/// One standard folder — Sent / Drafts / Archived. Live Gmail listing,
/// fetched on entry; rows share the mail list's grammar (sender label /
/// subject statement / snippet, time on the right) so the folders read as
/// the same product, not a bolted-on debug view.
struct MailboxList: View {
    @Environment(AppModel.self) private var model
    let box: MailboxKind

    private var items: [MailboxItem] { model.mailboxItems[box] ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: box.icon).font(.body).foregroundStyle(Theme.textDim)
                    .accessibilityHidden(true)
                Text(box.label).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                Text("\(items.count)").font(.title3.monospacedDigit()).foregroundStyle(Theme.textDim)
                Spacer()
                Button {
                    model.openMailbox(box)
                } label: {
                    Image(systemName: "arrow.clockwise").font(.callout.weight(.medium))
                        .iconTarget(30)
                }
                .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                .help(L("mailbox.refresh"))
                .accessibilityLabel(L("mailbox.refresh"))
            }
            .padding(.horizontal, 24).padding(.vertical, 18)

            Divider().overlay(Theme.line)

            if model.mailboxLoading == box && items.isEmpty {
                FirstSyncState()
                Spacer()
            } else if let error = model.mailboxError, items.isEmpty {
                Spacer()
                EmptyState(icon: "wifi.exclamationmark", title: error)
                Spacer()
            } else if items.isEmpty {
                Spacer()
                EmptyState(icon: box.icon, title: L("mailbox.empty.\(box.rawValue)"))
                Spacer()
            } else if Theme.isRenderingOffscreen {
                VStack(spacing: 0) {
                    ForEach(items.prefix(8)) { item in
                        MailboxRow(box: box, item: item)
                        Divider().overlay(Theme.line).padding(.leading, 20)
                    }
                }
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(items) { item in
                            MailboxRow(box: box, item: item)
                            Divider().overlay(Theme.line).padding(.leading, 20)
                        }
                        if model.mailboxNextToken[box] != nil {
                            Button {
                                Task { await model.loadMoreMailbox(box) }
                            } label: {
                                HStack(spacing: 6) {
                                    if model.mailboxLoading == box {
                                        ProgressView().controlSize(.small)
                                    }
                                    Text(L("mailbox.loadMore"))
                                        .font(Theme.Typo.label)
                                        .foregroundStyle(Theme.textDim)
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(model.mailboxLoading == box)
                            .accessibilityLabel(L("mailbox.loadMore"))
                        }
                    }
                }
            }
        }
        .task(id: box) {
            // Fetch on entry, and refresh a stale listing on re-entry. The
            // cached rows stay on screen while the refresh runs.
            await model.loadMailbox(box)
        }
    }
}

struct MailboxRow: View {
    @Environment(AppModel.self) private var model
    let box: MailboxKind
    let item: MailboxItem
    @State private var hovering = false
    @FocusState private var focused: Bool

    private var selected: Bool { model.selectedMailboxItem?.gmailId == item.gmailId }
    /// Sent/Drafts rows identify by who they're TO — "me, me, me" in the
    /// sender column is what every client avoids for these two folders.
    private var counterparty: String {
        let raw = box == .archived ? item.from : item.to
        let name = senderDisplayName(decodeHTMLEntities(raw))
        return name.isEmpty ? raw : name
    }

    var body: some View {
        Button {
            // A draft opens into the EDITOR, like every mail client; the
            // other folders open into the reading pane.
            if box == .drafts {
                model.openDraftForEditing(item)
            } else {
                model.selectMailboxItem(item)
            }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(counterparty).font(Theme.Typo.label)
                            .foregroundStyle(Theme.textDim).lineLimit(1)
                        // Which account the row came from — only meaningful
                        // with 2+ inboxes (inboxRowBadge stays quiet otherwise).
                        if let badge = inboxRowBadge(
                            linkedId: item.inbox == "primary" ? nil : item.inbox,
                            inboxes: model.inboxes)
                        {
                            Text(badge).font(.caption2).foregroundStyle(Theme.textDim)
                                .lineLimit(1)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Theme.surfaceRaised, in: Capsule())
                                .accessibilityLabel(L("mail.inbox.a11y", badge))
                        }
                    }
                    Text(decodeHTMLEntities(item.subject.isEmpty
                        ? L("mailbox.noSubject") : item.subject))
                        .font(Theme.Typo.head)
                        .foregroundStyle(Theme.text).lineLimit(1)
                    if !item.snippet.isEmpty {
                        Text(decodeHTMLEntities(item.snippet)).font(Theme.Typo.caption)
                            .foregroundStyle(Theme.textDim).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                let time = mailTimeLabel(iso: item.receivedAt, now: Date())
                if !time.isEmpty {
                    Text(time)
                        .font(Theme.Typo.caption.monospacedDigit())
                        .foregroundStyle(Theme.textDim)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focused($focused)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityLabel("\(counterparty). \(item.subject)")
        .padding(.horizontal, 20).padding(.vertical, 11)
        .background(alignment: .leading) {
            if selected { Rectangle().fill(Theme.accent).frame(width: 3) }
        }
        .background(selected ? Theme.surfaceSelected : hovering ? Theme.surfaceHover : .clear)
        .onHover { hovering = $0 }
        .overlay {
            if focused {
                RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.accent, lineWidth: 2)
            }
        }
    }
}

private struct CommitmentsList: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let groups = commitmentGroups(model.commitments ?? [])
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "checklist").font(.body).foregroundStyle(Theme.accent)
                    .accessibilityHidden(true)
                Text(L("section.commitments")).font(Theme.Typo.display).foregroundStyle(Theme.text)
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

/// Sun/moon appearance toggle (founder 2026-08-27: switchable from the top
/// right). Shows the mode a CLICK gives you — the universal toggle idiom —
/// and writes an explicit choice over "system" (the Preferences picker still
/// offers system-follow for those who want it back).
struct AppearanceToggle: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme

    private var isDark: Bool {
        switch model.settings.appearance {
        case .dark: true
        case .light: false
        case .system: colorScheme == .dark
        }
    }

    var body: some View {
        Button {
            model.settings.appearance = isDark ? .light : .dark
        } label: {
            Image(systemName: isDark ? "sun.max" : "moon")
                .font(.callout).iconTarget()
        }
        .buttonStyle(.plain).hoverDim()
        .help(isDark ? L("appearance.toLight") : L("appearance.toDark"))
        .accessibilityLabel(isDark ? L("appearance.toLight") : L("appearance.toDark"))
    }
}

/// The lane as a label (mail-first shell): tinted micro-pill. This is where
/// the classification now lives on the default view — on the row, not in the
/// navigation.
struct LaneChip: View {
    let tier: Tier
    var body: some View {
        Text(tier.label)
            .font(Theme.Typo.micro)
            .foregroundStyle(Theme.tint(tier))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Theme.tint(tier).opacity(0.13), in: Capsule())
            .accessibilityLabel(tier.label)
    }
}

/// The row's one relationship/category chip. Renders nothing for nil —
/// a missing fact must never become a label.
struct SignalChip: View {
    let signal: RowSignal?

    private var text: String? {
        switch signal {
        case .category(let c): L("chip.\(c)")
        case .replied(let n): L("chip.replied", n)
        case .first: L("chip.first")
        case nil: nil
        }
    }

    var body: some View {
        if let text, let signal {
            let tint = Theme.signalTint(signal)
            Text(text)
                .font(Theme.Typo.micro)
                .foregroundStyle(tint)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(tint.opacity(0.13), in: Capsule())
                .accessibilityLabel(text)
        }
    }
}

struct FullRow: View {
    @Environment(AppModel.self) private var model
    let item: FirewallItem
    let actions: TopBarActions
    /// True on mixed-lane surfaces (the chronological inbox, search) where
    /// the row must carry its own lane; lane views leave it off — the lane
    /// is the screen title there.
    var showLaneChip = false
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
                        // Non-EMAIL items (GitHub notifications) have no
                        // sender — a blank caption line here made them read as
                        // mail that "doesn't exist in Gmail" (2026-08-10).
                        // Web parity: firewall-board's SourceBadge.
                        if !sender.isEmpty {
                            Text(sender).font(Theme.Typo.label)
                                .foregroundStyle(Theme.textDim).lineLimit(1)
                        } else if let badge = sourceBadgeLabel(item.source) {
                            Text(badge).font(Theme.Typo.label)
                                .foregroundStyle(Theme.textDim).lineLimit(1)
                        }
                        Text(decodeHTMLEntities(item.email?.subject ?? item.title))
                            .font(Theme.Typo.head)
                            .foregroundStyle(Theme.text).lineLimit(1)
                        HStack(spacing: 6) {
                            if showLaneChip {
                                LaneChip(tier: item.tier)
                            }
                            SignalChip(signal: item.email?.signal)
                            if let reason = rowTierReason(item.tierReason) {
                                Text(reason).font(Theme.Typo.caption)
                                    .foregroundStyle(Theme.textDim).lineLimit(1)
                            }
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
                // Received time, always visible (design pass 2026-08-25): the
                // reference triage clients right-align a time on every row,
                // and a mail list with no time was an information gap. Falls
                // back to when Klorn surfaced the item for non-mail rows.
                let time = mailTimeLabel(
                    iso: item.email?.receivedAt ?? item.surfacedAt, now: Date())
                if !time.isEmpty {
                    Text(time)
                        .font(Theme.Typo.caption.monospacedDigit())
                        .foregroundStyle(Theme.textDim)
                }
                // The tier dot lives OUTSIDE the menu label: the AppKit
                // borderless menu renders SF Symbols as colorless templates
                // (white dot, v0.4.4) and drops SwiftUI Shapes entirely (no
                // dot, v0.4.5). A sibling Circle under a transparent menu hit
                // area is the only variant that keeps the tint AND the menu.
                ZStack {
                    Circle().fill(Theme.tint(item.tier)).frame(width: 8, height: 8)
                    if !Theme.isRenderingOffscreen {
                        TierMenu(
                            item: item, onSetTier: actions.onSetTier,
                            onPinSender: actions.onPinSender, onUnpinSender: actions.onUnpinSender
                        ) {
                            Color.clear.iconTarget()
                        }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    }
                }
                .help(L("mail.changeTier"))
                .accessibilityLabel(L("mail.changeTier.a11y", a11ySenderLabel(item), item.tier.label))
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
                .accessibilityLabel(L("mail.snooze.a11y", a11ySenderLabel(item)))
                .opacity(hovering || selected || focused ? 1 : 0)
                Button { actions.onDismiss(item) } label: { Image(systemName: "xmark").iconTarget() }
                    .buttonStyle(.plain).foregroundStyle(Theme.textDim).help(L("mail.dismiss"))
                    .accessibilityLabel(L("mail.dismiss.a11y", a11ySenderLabel(item)))
                    .opacity(hovering || selected || focused ? 1 : 0)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 11)
        // Selection is not color-only: an accent leading bar + a stronger fill (both
        // perceivable), plus the .isSelected trait above. At REST the bar
        // carries the row's TIER instead (design renewal P2): in mixed-lane
        // surfaces (전체 수신함, search) the lane identity used to live in one
        // 8px dot at the far right — now every row wears its lane on the
        // scan edge. Muted so the list stays quiet; selection still wins.
        .background(alignment: .leading) {
            if selected {
                Rectangle().fill(Theme.accent).frame(width: 3)
            } else {
                Rectangle().fill(Theme.tint(item.tier).opacity(0.45)).frame(width: 3)
            }
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
            // Folder rows (Sent/Drafts/Archived) read through the live path —
            // they are not in the local mirror, so the firewall branches below
            // can never serve them. Checked first: selecting a folder row is
            // the more recent intent when both selections exist.
            if case .mailbox = model.listMode, let picked = model.selectedMailboxItem {
                if model.mailboxDetailLoading {
                    centered { ProgressView().controlSize(.small) }
                } else if let detail = model.mailboxDetail {
                    mailboxContent(picked, detail)
                } else {
                    centered { EmptyState(icon: "doc.text", title: L("reading.noPreview")) }
                }
            } else if model.isLoadingEmail {
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

    /// A folder message: subject / counterparty / time, then the body as the
    /// sender designed it. No firewall band — these rows were never
    /// classified, and painting tier chrome on them would claim they were.
    private func mailboxContent(_ item: MailboxItem, _ detail: LiveEmailDetail.Payload)
        -> some View
    {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Theme.s2) {
                Text(decodeHTMLEntities(detail.subject.isEmpty
                    ? L("mailbox.noSubject") : detail.subject))
                    .font(Theme.Typo.display)
                    .foregroundStyle(Theme.text).lineLimit(2)
                HStack {
                    let from = senderDisplayName(decodeHTMLEntities(detail.from))
                    let to = senderDisplayName(decodeHTMLEntities(detail.to))
                    Text(L("mailbox.fromTo", from.isEmpty ? detail.from : from,
                           to.isEmpty ? detail.to : to))
                        .font(.callout).foregroundStyle(Theme.textDim).lineLimit(1)
                    Spacer()
                    Text(Self.formatDate(detail.receivedAt))
                        .font(.caption).foregroundStyle(Theme.textDim)
                }
            }
            .padding(24)
            Divider().overlay(Theme.line)
            if let renderHtml = detail.renderHtml, !renderHtml.isEmpty {
                EmailHtmlView(
                    html: renderHtml,
                    // Live folder messages resolve cid: images through the
                    // live route, on the account the row came from.
                    inlineImage: { [gmailId = detail.gmailId, inbox = model.selectedMailboxItem?.inbox] cid in
                        await model.liveInlineImage(gmailId: gmailId, inbox: inbox, cid: cid)
                    },
                    blockRemote: !model.settings.loadRemoteImages)
                    .id(detail.gmailId)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    Text(detail.body.isEmpty ? L("reading.noContent") : detail.body)
                        .font(.callout)
                        .foregroundStyle(Theme.text)
                        .lineSpacing(4)
                        .textSelection(.enabled)
                        .frame(maxWidth: 640, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(24)
                }
            }
        }
    }

    private func content(_ email: EmailDetail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Theme.s2) {
                Text(decodeHTMLEntities(email.subject ?? L("mail.noSubjectParen")))
                    .font(Theme.Typo.display)
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
                            TierMenu(
                            item: item, onSetTier: actions.onSetTier,
                            onPinSender: actions.onPinSender, onUnpinSender: actions.onUnpinSender
                        ) {
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
            if let renderHtml = email.renderHtml, !renderHtml.isEmpty {
                // Designed (HTML) mail renders as the sender built it — the
                // webview scrolls itself. Plain mail keeps the text path below.
                // .id ties the webview's lifetime to ONE message: a fresh
                // ephemeral cookie store per email, so tracker cookies set by
                // sender A's pixel never ride along to sender B's mail.
                EmailHtmlView(
                    html: renderHtml,
                    inlineImage: { [emailId = email.id] cid in
                        await model.inlineImage(emailId: emailId, cid: cid)
                    },
                    blockRemote: !model.settings.loadRemoteImages)
                    .id(email.id)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
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

    /// Klorn's per-email intelligence: why it landed in this tier, the AI summary
    /// with its key points and action items, and whether it needs a reply.
    /// Always rendered for an opened email — the "AI 정리" button must stay
    /// reachable even before any summary exists (founder, 2026-08-20).
    @ViewBuilder
    private func klornBand(_ email: EmailDetail) -> some View {
        let reason = item?.tierReason
        // COLLAPSED by default (founder 2026-09-01): the analysis was eating
        // the pane and the mail itself was barely visible. The one-line WHY
        // stays always; everything deeper sits behind the chevron, and the
        // choice persists (a reader who wants the full analysis keeps it).
        let expanded = model.settings.readingBandExpanded
        VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Button {
                        withAnimation(.easeOut(duration: 0.15)) {
                            model.settings.readingBandExpanded.toggle()
                        }
                    } label: {
                        HStack(spacing: 6) {
                            if let item, let reason, !reason.isEmpty {
                                Circle().fill(Theme.tint(item.tier)).frame(width: 7, height: 7)
                                Text(L("mail.whyTier", item.tier.label, reason))
                                    .font(.caption).foregroundStyle(Theme.textDim)
                                    .lineLimit(expanded ? 2 : 1)
                            } else {
                                Text(L("reading.analysis"))
                                    .font(.caption).foregroundStyle(Theme.textDim)
                            }
                            Image(systemName: "chevron.down").font(.caption2)
                                .foregroundStyle(Theme.textDim)
                                .rotationEffect(expanded ? .zero : .degrees(-90))
                                .accessibilityHidden(true)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(expanded ? L("reading.analysis.collapse") : L("reading.analysis.expand"))
                    .accessibilityLabel(L("reading.analysis"))
                    .accessibilityValue(expanded ? L("a11y.expanded") : L("a11y.collapsed"))
                    Spacer(minLength: 12)
                    // Deep re-read of THIS mail: longer summary, up to 6 key
                    // points, deadlines kept — in the UI language.
                    Button(model.isSummarizing ? L("mail.summarizing") : L("mail.summarize")) {
                        Task { await model.summarizeOpenedEmail() }
                    }
                    .buttonStyle(.plain)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(model.isSummarizing ? Theme.textDim : Theme.accent)
                    .disabled(model.isSummarizing)
                }
                if expanded {
                if model.summarizeFailed {
                    Text(L("mail.summarizeFailed"))
                        .font(.caption).foregroundStyle(Theme.textDim)
                }
                if let summary = email.summary, !summary.isEmpty {
                    Text(summary).font(.callout).foregroundStyle(Theme.text.opacity(0.9))
                }
                if let points = email.keyPoints, !points.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        // Position keys: LLM bullets can repeat verbatim, and
                        // duplicate \.self identities break SwiftUI diffing.
                        ForEach(Array(points.enumerated()), id: \.offset) { _, point in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text("•").font(.caption).foregroundStyle(Theme.textDim)
                                    .accessibilityHidden(true)
                                Text(point).font(.caption).foregroundStyle(Theme.text.opacity(0.85))
                            }
                        }
                    }
                }
                if let actions = email.actionItems, !actions.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
                            HStack(alignment: .firstTextBaseline, spacing: 5) {
                                Image(systemName: "checkmark.circle").font(.caption2)
                                    .foregroundStyle(Theme.accent).accessibilityHidden(true)
                                Text(action).font(.caption).foregroundStyle(Theme.text.opacity(0.85))
                            }
                        }
                    }
                    .accessibilityLabel(L("mail.actionItems"))
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
                // Why this arrived NOW — read from the whole thread, both
                // directions. Sits ABOVE the relationship dossier: the
                // trigger is what the user needs before deciding anything.
                if let brief = model.threadBrief, !brief.whyNow.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Image(systemName: "arrow.triangle.branch").font(.caption2)
                                .foregroundStyle(Theme.accent).accessibilityHidden(true)
                            Text(brief.whyNow).font(.caption).foregroundStyle(Theme.text)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let owe = brief.weOwe, !owe.isEmpty {
                            Text(L("thread.weOwe", owe))
                                .font(.caption2).foregroundStyle(.orange)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        ForEach(brief.asks.prefix(2), id: \.self) { ask in
                            HStack(alignment: .firstTextBaseline, spacing: 5) {
                                Text("·").font(.caption2).foregroundStyle(Theme.textDim)
                                Text(ask).font(.caption2).foregroundStyle(Theme.textDim)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(L("thread.brief.a11y", brief.whyNow))
                }
                if let dossier = model.senderDossier, !dossier.summary.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Image(systemName: "person.crop.circle").font(.caption2)
                                .foregroundStyle(Theme.accent).accessibilityHidden(true)
                            Text(dossier.summary).font(.caption)
                                .foregroundStyle(Theme.textDim).lineLimit(2)
                        }
                        if !dossier.openThreads.isEmpty {
                            Text(L("dossier.inFlight", dossier.openThreads.joined(separator: " · ")))
                                .font(.caption2).foregroundStyle(Theme.textDim)
                                .padding(.leading, 13).lineLimit(2)
                        }
                        if let promise = dossier.lastPromise, !promise.isEmpty {
                            Text(L("dossier.promise", promise))
                                .font(.caption2).foregroundStyle(Theme.textDim)
                                .padding(.leading, 13).lineLimit(2)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(L("dossier.a11y"))
                }
                if let context = model.meetingContext, let proposed = context.proposed {
                    meetingContextRows(context, proposed)
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
            }
        // Same measure as the mail body below: intelligence about a document
        // should not run wider than the document itself.
        .frame(maxWidth: 640, alignment: .leading)
        .padding(.horizontal, 24).padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceRaised)
        Divider().overlay(Theme.line)
    }

    /// The meeting ↔ calendar cross-reference: the slot this email proposes,
    /// whether it clashes with the user's real calendar, and what else sits
    /// near it that day. Hue rides the dot only (signal-line rule above); the
    /// verdict word carries the state so it is never color-alone.
    @ViewBuilder
    private func meetingContextRows(
        _ context: MeetingContextWire, _ proposed: MeetingContextWire.Proposed
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Image(systemName: "calendar.badge.clock").font(.caption2)
                    .foregroundStyle(Theme.accent).accessibilityHidden(true)
                Text(L("meeting.proposedSlot", meetingSlotLabel(proposed.startTime, proposed.endTime)))
                    .font(.caption).foregroundStyle(Theme.textDim)
            }
            HStack(spacing: 6) {
                Circle().fill(meetingVerdictColor(context.conflict))
                    .frame(width: 7, height: 7).accessibilityHidden(true)
                Text(meetingVerdictLabel(context.conflict))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(context.conflict?.hasConflicts == true ? Theme.text : Theme.textDim)
            }
            if let alts = context.alternatives, !alts.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: "calendar.badge.checkmark").font(.caption2)
                        .foregroundStyle(Theme.accent).accessibilityHidden(true)
                    Text(L("meeting.alternatives",
                           alts.prefix(3).map { meetingSlotLabel($0.startTime, $0.endTime) }
                               .joined(separator: " · ")))
                        .font(.caption).foregroundStyle(Theme.textDim)
                }
            }
            ForEach(context.nearby.prefix(3)) { event in
                Text("\(meetingSlotLabel(event.startTime, event.endTime))  \(event.title)")
                    .font(.caption2).foregroundStyle(Theme.textDim)
                    .padding(.leading, 13)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func meetingVerdictLabel(_ conflict: MeetingContextWire.Conflict?) -> String {
        guard let conflict else { return L("meeting.slotUnknown") }
        return conflict.hasConflicts ? L("meeting.slotBusy") : L("meeting.slotFree")
    }

    private func meetingVerdictColor(_ conflict: MeetingContextWire.Conflict?) -> Color {
        guard let conflict else { return Theme.textDim }
        return conflict.hasConflicts ? .red : .green
    }

    /// "Wed Aug 13 · 16:00–17:00" in the user's locale/zone, from the wire's
    /// ISO strings. Malformed input degrades to the raw string, never crashes.
    private func meetingSlotLabel(_ startIso: String, _ endIso: String) -> String {
        let iso = ISO8601DateFormatter()
        guard let start = iso.date(from: startIso), let end = iso.date(from: endIso) else {
            return startIso
        }
        let day = DateFormatter()
        day.setLocalizedDateFormatFromTemplate("EdMMM")
        let time = DateFormatter()
        time.setLocalizedDateFormatFromTemplate("HHmm")
        return "\(day.string(from: start)) · \(time.string(from: start))–\(time.string(from: end))"
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
/// Compact per-account readiness readout: one line per check, colored by
/// status. Renders nothing until the user asks for it.
private struct DiagnosticsBlock: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.diagnosticsInFlight {
                Text(L("diagnostics.checking")).font(.caption2).foregroundStyle(Theme.textDim)
            }
            if let error = model.diagnosticsError {
                Text(error).font(.caption2).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(model.diagnostics) { check in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Circle().fill(statusColor(check.status))
                        .frame(width: 6, height: 6)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        // Status is never color-only: the localized word
                        // carries it alongside the dot.
                        Text("\(localizedLabel(check)) · \(statusWord(check.status))")
                            .font(.caption2.weight(check.status == "ok" ? .regular : .semibold))
                            .foregroundStyle(check.status == "ok" ? Theme.textDim : Theme.text)
                        Text(check.message)
                            .font(.caption2)
                            .foregroundStyle(Theme.textDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    /// The server sends English-only labels; known check keys render through
    /// the catalogue and unknown ones fall back to the server label so a new
    /// server-side check degrades to English instead of an L10n key.
    private func localizedLabel(_ check: ReadinessCheck) -> String {
        let key = "diag.\(check.key)"
        let localized = L(key)
        return localized == key ? check.label : localized
    }

    private func statusWord(_ status: String) -> String {
        switch status {
        case "ok": return L("diag.status.ok")
        case "warning": return L("diag.status.warning")
        default: return L("diag.status.error")
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "ok": return .green
        case "warning": return .orange
        default: return .red
        }
    }
}

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
                Text(updating ? L("update.updating") : L("update.installVersion", version))
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
            ? L("update.a11y.updating", version)
            : L("update.a11y.available", version))
        .transition(.opacity.combined(with: .move(edge: .top)))
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) {
                pulsing = true
            }
        }
    }
}

/// New-mail composer (full-view overlay): to / subject / body, manual send
/// through POST /api/email/send. The user writes and sends — no AI in the
/// loop here, so there is nothing to approve. Server enforces the Pro gate.
private struct ComposePanel: View {
    @Environment(AppModel.self) private var model
    @FocusState private var focusTo: Bool

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L(model.editingDraftGmailId == nil ? "compose.title" : "compose.editDraft"))
                    .font(Theme.Typo.head).foregroundStyle(Theme.text)
                Spacer()
                Button {
                    if !model.composeSending { model.showCompose = false }
                } label: { Image(systemName: "xmark").font(.caption.weight(.semibold)).iconTarget(28) }
                    .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                    .disabled(model.composeSending)
                    .accessibilityLabel(L("compose.close.a11y"))
            }

            field(L("compose.to"), text: $model.composeTo)
                .focused($focusTo)
            field(L("compose.subject"), text: $model.composeSubject)

            Group {
                if Theme.isRenderingOffscreen {
                    Text(model.composeBody.isEmpty ? L("compose.bodyPlaceholder") : model.composeBody)
                        .font(.callout).foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity, minHeight: 170, alignment: .topLeading)
                        .padding(8)
                } else {
                    TextEditor(text: $model.composeBody)
                        .font(.callout).foregroundStyle(Theme.text)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 170)
                        .padding(4)
                        .accessibilityLabel(L("compose.bodyPlaceholder"))
                }
            }
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))

            if let error = model.composeError {
                Text(error).font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Spacer()
                Button(L("compose.cancel")) {
                    model.discardComposeDraft()
                    model.showCompose = false
                }
                    .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                    .disabled(model.composeSending)
                    .keyboardShortcut(.cancelAction)
                Button {
                    Task { await model.submitCompose() }
                } label: {
                    Text(model.composeSending ? L("compose.sending") : L("compose.send"))
                        .font(.callout.weight(.semibold))
                        .padding(.horizontal, 14).padding(.vertical, 6)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)
                .background(Theme.accent, in: Capsule())
                .opacity(model.composeSending ? 0.6 : 1)
                .disabled(model.composeSending)
                .keyboardShortcut(.return, modifiers: .command)
                .accessibilityLabel(L("compose.send"))
            }
        }
        .padding(20)
        .frame(width: 540)
        .background(Theme.bg, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.line))
        .shadow(color: Theme.panelShadow, radius: 24, y: 8)
        .onAppear { focusTo = true }
    }

    @ViewBuilder
    private func field(_ label: String, text: Binding<String>) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(Theme.textDim)
                .frame(width: 56, alignment: .leading)
            if Theme.isRenderingOffscreen {
                Text(text.wrappedValue.isEmpty ? "…" : text.wrappedValue)
                    .font(.callout).foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                TextField("", text: text)
                    .textFieldStyle(.plain).font(.callout).foregroundStyle(Theme.text)
                    .accessibilityLabel(label)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
    }
}

/// Offscreen render harness for the composer (same reason as the briefing
/// probe: overlays inside the full view's ZStack are awkward to shoot).
struct ComposePanelRenderProbe: View {
    var body: some View {
        ComposePanel().padding(24)
    }
}

/// Floating assistant dock — bottom-right of the full view, the way the web
/// app docks it. The point is CONTEXT: the sidebar tab makes you leave the
/// mail you are reading to ask about it (founder, 2026-08-22: "탭을 옮겨가면서
/// 해야해서 불편함"), while the dock keeps the mail on screen and the model is
/// told which mail that is. Same conversation as the tab — one thread, two
/// surfaces.
private struct AssistantDock: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .trailing, spacing: 10) {
            if model.showAssistantDock {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 8) {
                        Image(systemName: "sparkles").font(.caption).foregroundStyle(Theme.accent)
                            .accessibilityHidden(true)
                        Text(L("section.assistant"))
                            .font(.callout.weight(.semibold)).foregroundStyle(Theme.text)
                        Spacer(minLength: 4)
                        Button {
                            model.showAssistantDock = false
                        } label: {
                            Image(systemName: "xmark").font(.caption2.weight(.semibold))
                                .iconTarget(26)
                        }
                        .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                        .accessibilityLabel(L("assistant.dock.close.a11y"))
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    // The anchor line: what the assistant is looking at with
                    // you. Absent when nothing is open — never a fake claim.
                    if let subject = model.openedEmail?.subject, !subject.isEmpty {
                        HStack(spacing: 5) {
                            Image(systemName: "envelope").font(.caption2)
                                .foregroundStyle(Theme.textDim).accessibilityHidden(true)
                            Text(subject).font(.caption2).foregroundStyle(Theme.textDim)
                                .lineLimit(1).truncationMode(.tail)
                        }
                        .padding(.horizontal, 12).padding(.bottom, 8)
                        .accessibilityLabel(L("assistant.dock.context.a11y", subject))
                    }
                    Divider().overlay(Theme.line)
                    AssistantThread(showsStarters: false)
                }
                .frame(width: 380, height: 460)
                .background(Theme.bg, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.line))
                .shadow(color: Theme.panelShadow, radius: 22, y: 8)
                .transition(
                    reduceMotion
                        ? .opacity
                        : .scale(scale: 0.97, anchor: .bottomTrailing).combined(with: .opacity))
            }
            Button {
                // Reduce Motion gets the state change with no animation at
                // all, not a shorter one.
                withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.86)) {
                    model.showAssistantDock.toggle()
                }
            } label: {
                Image(systemName: model.showAssistantDock ? "xmark" : "sparkles")
                    .font(.title3.weight(.medium))
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
                    .background(Theme.accent, in: Circle())
                    .shadow(color: Theme.accent.opacity(0.35), radius: 12, y: 4)
            }
            .buttonStyle(.plain)
            .keyboardShortcut("j", modifiers: .command)
            .help(L("assistant.dock.toggle"))
            .accessibilityLabel(L("assistant.dock.toggle"))
        }
        .padding(.trailing, 20).padding(.bottom, 20)
    }
}

/// Offscreen render harness for the dock (ImageRenderer draws ScrollView
/// content empty, so the dock gets its own shot like the other overlays).
struct AssistantDockRenderProbe: View {
    var body: some View {
        AssistantDock().padding(16)
    }
}
