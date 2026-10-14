import SwiftUI

struct FullSidebar: View {
    @Environment(AppModel.self) private var model
    @Binding var selected: ListMode
    let actions: TopBarActions
    /// Maintenance actions + diagnostics live behind a disclosure — the
    /// account section is daily-use identity actions; update/restart/health
    /// are occasional and were crowding the sidebar (founder, 2026-08-14).
    /// Restart + connection status need an Option-click (MaintenanceDisclosure).
    @State private var maintenance = MaintenanceDisclosure.State(expanded: false, supportTools: false)
    /// Filed-lanes disclosure (INFO/SILENT). Session-scoped; a
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
            if MeetingLink.safeURL(event.meetingLink) != nil {
                Image(systemName: "video").font(.caption2).foregroundStyle(Theme.textDim)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 3)
        if let url = MeetingLink.safeURL(event.meetingLink) {
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

                // Mail I sent that nobody answered — the reply axis's other
                // half (2026-09-18). Sits with the folders: it is a view of
                // Sent, not of the inbox.
                Button { selected = .waitingOn } label: {
                    HStack(spacing: 10) {
                        FeatureIcon(systemName: "clock.arrow.circlepath")
                        Text(L("waiting.title"))
                            .font(.body.weight(selected == .waitingOn ? .semibold : .regular))
                            .foregroundStyle(Theme.text)
                        Spacer()
                        if !model.waitingOn.isEmpty {
                            Text("\(model.waitingOn.count)")
                                .font(Theme.Typo.numeric).foregroundStyle(Theme.textDim)
                        }
                    }
                    .modifier(SidebarRowChrome(selected: selected == .waitingOn))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("waiting.title"))

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
                // The company's email domains — a sender on one is 회사 on
                // the row as a recorded fact, and the analysis reads them as
                // colleagues. Editable here any time; first asked at connect.
                CompanyDomainsRow()
                // What matters to the user, in their words — the lane judge
                // and the analysis read it. Editable any time.
                PrioritiesRow()
                Divider().padding(.horizontal, 16).padding(.vertical, 4)
                maintenanceDisclosureRow
                if maintenance.expanded {
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
                    if maintenance.supportTools {
                        sidebarAction(L("menu.restart"), dim: true) { AppRestart.relaunch() }
                        // The app must be able to answer "why is mail stuck" itself.
                        sidebarAction(L("menu.diagnostics"), dim: true) {
                            Task { await model.runDiagnostics() }
                        }
                    }
                    sidebarAction(L("menu.contactSupport"), dim: true) { openSupportMail() }
                    if maintenance.supportTools { DiagnosticsBlock().padding(.horizontal, 20) }
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
            sidebarAction(L("prefs.title"), dim: true) { actions.onOpenPreferences() }
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
            let next = MaintenanceDisclosure.toggled(
                maintenance, optionHeld: MaintenanceDisclosure.optionHeld)
            withAnimation(.easeOut(duration: 0.15)) { maintenance = next }
        } label: {
            HStack(spacing: 6) {
                Text(L("account.maintenance")).font(.body).foregroundStyle(Theme.textDim)
                Image(systemName: "chevron.right").font(.caption2)
                    .foregroundStyle(Theme.textDim)
                    .rotationEffect(maintenance.expanded ? .degrees(90) : .zero)
                    .accessibilityHidden(true)
                Spacer()
            }
            .padding(.horizontal, 12).padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L("account.maintenance"))
        .accessibilityValue(maintenance.expanded ? L("a11y.expanded") : L("a11y.collapsed"))
        // Assistive-tech path to the Option-click support tools.
        .accessibilityAction(named: L("account.showSupportTools")) {
            maintenance = MaintenanceDisclosure.revealed
        }
    }

    private func sidebarAction(_ title: String, dim: Bool = false, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(title).font(.body).foregroundStyle(dim ? Theme.textDim : Theme.text)
                .padding(.horizontal, 12).padding(.vertical, 5)
                .frame(maxWidth: .infinity, alignment: .leading)
        }.buttonStyle(.plain)
    }
}
