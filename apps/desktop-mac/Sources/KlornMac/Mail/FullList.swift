import SwiftUI

struct FullList: View {
    @Environment(AppModel.self) private var model
    let mode: ListMode
    let actions: TopBarActions
    @Binding var keyZone: MailKeyZone
    /// The offscreen renderer paints the key catcher (an AppKit view) as a
    /// placeholder over the whole list. The main window's shots leave it
    /// out; the bar's shots are unchanged from main, placeholder included.
    var keyCatcherInRender = true
    /// The main window's lane tab already names the lane and carries its
    /// count, so the list drops its own title row there; the inbox scope
    /// and compose move beside the search field. Search results keep theirs.
    var hidesLaneTitle = false
    /// `.window` in the main window: the one-badge rows and the token
    /// metrics. The default is the bar's list, unchanged.
    var rowStyle: MailRowStyle = .legacy
    /// The user asked for the search field (⌘F, `/`): its focus is theirs,
    /// not the window's opening default.
    @State private var searchRequested = false
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
    private var titleHidden: Bool { hidesLaneTitle && !searching }

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
            case .waitingOn: WaitingOnList()
            }
        }
        .id(mode)
        .transition(.opacity)
        .animation(reduceMotionSwitch ? nil : .easeOut(duration: 0.15), value: mode)
    }


    private var tierList: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !titleHidden {
            HStack(spacing: 8) {
                if searching {
                    Image(systemName: "magnifyingglass").font(metrics.titleIcon).foregroundStyle(Theme.accent)
                        .accessibilityHidden(true)
                    Text(L("section.search")).font(metrics.title).foregroundStyle(Theme.text)
                    Text("\(model.searchTotal)")
                        .font(metrics.titleCount).foregroundStyle(Theme.textDim)
                } else if let filter = labelFilter {
                    Image(systemName: filter.icon).font(metrics.titleIcon).foregroundStyle(Theme.textDim)
                        .accessibilityHidden(true)
                    Text(filter.label).font(metrics.title).foregroundStyle(Theme.text)
                    Text("\(items.count)").font(metrics.titleCount).foregroundStyle(Theme.textDim)
                        .contentTransition(.numericText())
                        .animation(.default, value: items.count)
                } else if inboxMode {
                    Image(systemName: "tray").font(metrics.titleIcon).foregroundStyle(Theme.textDim)
                        .accessibilityHidden(true)
                    Text(L("section.inbox")).font(metrics.title).foregroundStyle(Theme.text)
                    Text("\(items.count)").font(metrics.titleCount).foregroundStyle(Theme.textDim)
                        .contentTransition(.numericText())
                        .animation(.default, value: items.count)
                } else {
                    Circle().fill(Theme.tint(tier)).frame(width: 9, height: 9)
                    Text(tier.label).font(metrics.title).foregroundStyle(Theme.text)
                    Text("\(items.count)").font(metrics.titleCount).foregroundStyle(Theme.textDim)
                        .contentTransition(.numericText())
                        .animation(.default, value: items.count)
                }
                Spacer()
                InboxSelectorMenu()
                composeButton
            }
            .padding(.horizontal, metrics.inset).padding(.vertical, metrics.titleVertical)
            }

            // Whole-mailbox search (same endpoint as the web inbox). Debounced;
            // clearing the field returns to the tier list instantly.
            HStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(metrics.fieldIcon).foregroundStyle(Theme.textDim)
                    .accessibilityHidden(true)
                if Theme.isRenderingOffscreen {
                    Text(L("mail.searchPlaceholder"))
                        .font(metrics.field).foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                TextField(L("mail.searchPlaceholder"), text: $query)
                    .opacity(Theme.isRenderingOffscreen ? 0 : 1)
                    .textFieldStyle(.plain).font(metrics.field).foregroundStyle(Theme.text)
                    .focused($searchFocused)
                    // Esc hands the keyboard back to the list.
                    .onKeyPress(.escape) {
                        searchFocused = false
                        return .handled
                    }
                    .accessibilityLabel(L("mail.search.a11y"))
                    // Edit ▸ Search Mail (⌘F). `initial`: Find may have just
                    // switched the list mode, mounting this field fresh.
                    .onChange(of: model.searchFocusPending, initial: true) { _, pending in
                        guard pending else { return }
                        searchRequested = true
                        model.searchFocusPending = false
                        // Next runloop: focus set during mount is dropped.
                        DispatchQueue.main.async { searchFocused = true }
                    }
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: { Image(systemName: "xmark.circle.fill").font(metrics.fieldIcon) }
                        .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                        .accessibilityLabel(L("mail.clearSearch.a11y"))
                }
            }
            .padding(.horizontal, metrics.fieldInset).padding(.vertical, metrics.fieldVertical)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: metrics.fieldRadius))
            .overlay(RoundedRectangle(cornerRadius: metrics.fieldRadius)
                .strokeBorder(searchFocused ? Theme.accent.opacity(0.5) : .clear))
            if titleHidden {
                InboxSelectorMenu()
                composeButton
            }
            }
            .padding(.horizontal, metrics.inset).padding(.top, titleHidden ? metrics.fieldGap : 0).padding(.bottom, metrics.fieldGap)
            .task(id: "\(model.selectedInbox)|\(query)") {
                // Keyed on scope + query: an inbox switch re-fetches an active
                // search with the new scope, same debounce path.
                // 300ms debounce: only the last keystroke's task survives.
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                await model.search(query)
            }

            if rowStyle == .window {
                // The rows carry their own inset hairlines; a full-width rule
                // here would box the search field in.
                Color.clear.frame(height: 0)
            } else {
                Divider().overlay(Theme.line)
            }

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
                    EmptyState(icon: filter.icon, title: L("label.empty", filter.label), style: rowStyle.shell)
                } else if inboxMode {
                    EmptyState(icon: "tray", title: L("inbox.empty"), style: rowStyle.shell)
                } else {
                    EmptyState(icon: tier.emptyIcon, title: tier.emptyTitle, hint: tier.blurb, style: rowStyle.shell)
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
                        FullRow(item: item, actions: actions, showLaneChip: mixedLanes, style: rowStyle)
                        rowDivider
                    }
                    Spacer(minLength: 0)
                }
            } else {
                // Same ScrollView + LazyVStack as before M3; the reader only
                // adds scroll-into-view for a keyboard-moved selection.
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(items) { item in
                                FullRow(item: item, actions: actions, showLaneChip: mixedLanes, style: rowStyle)
                                    .id(item.id)
                                    .transition(rowTransition)
                                rowDivider
                            }
                        }
                        // The one motion that carries product truth (P1): a new
                        // classification ARRIVES and a corrected row LEAVES for
                        // its new lane — state changes are never silent.
                        .animation(
                            reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.85),
                            value: items.map(\.id))
                    }
                    // No anchor: the minimal scroll that shows the row, so a
                    // click on a visible row never moves the list.
                    .onChange(of: model.selectedItemId) { _, id in
                        if let id { proxy.scrollTo(id) }
                    }
                }
            }
        }
        // List keys (M3). Mounted with the mail list only, so other list
        // modes never see them.
        .background {
            if keyCatcherInRender || !Theme.isRenderingOffscreen {
                MailListKeyCatcher(
                    onKey: { handleKey($0) },
                    onClickOutsideReader: { keyZone = .list },
                    mayReleaseOpeningFocus: {
                        !searchRequested && !model.searchFocusPending && !model.fullViewModalOpen
                    })
            }
        }
        .onDisappear { keyZone = .list }
    }

    /// The hairline under a row: the bar's, or the main window's inset one.
    @ViewBuilder
    private var rowDivider: some View {
        if rowStyle == .window {
            Rectangle().fill(Theme.line).frame(height: Theme.hairline)
                .padding(.horizontal, Theme.s4 + Theme.s1)
        } else {
            Divider().overlay(Theme.line).padding(.leading, 24)
        }
    }

    private var metrics: MailListMetrics { rowStyle == .window ? .window : .bar }

    private var composeButton: some View {
        Button {
            model.showCompose = true
        } label: {
            Image(systemName: "square.and.pencil").font(metrics.compose)
                .iconTarget(30)
        }
        .buttonStyle(.plain).foregroundStyle(Theme.textDim)
        // ⌘N lives in the app menu (File ▸ New Email) — one owner.
        .help(L("compose.new"))
        .accessibilityLabel(L("compose.new"))
    }

    /// One key press from the catcher: decide with the pure rules, then run
    /// the same paths a click or a menu command runs.
    private func handleKey(_ press: ListKeyPress) -> Bool {
        let rows = items
        var menu = MenuState(model: model)
        menu.modalOpen = menu.modalOpen || press.window.attachedSheet != nil
        let state = ListKeyState(
            menu: menu, responder: press.responder, composingText: press.composingText,
            zone: keyZone, showsRows: !searching && model.queue != nil, itemCount: rows.count)
        guard let action = ListKeyRules.action(for: press.key, isRepeat: press.isRepeat, in: state)
        else { return false }
        let ids = rows.map(\.id)
        func row(_ id: String?) -> FirewallItem? { rows.first { $0.id == id } }
        switch action {
        case .move(let delta):
            let target = ListKeyRules.movedSelection(
                ids: ids, selected: model.selectedItemId, delta: delta)
            if let item = row(target) { actions.onSelect(item) }
        case .openReader:
            keyZone = .reader
            MailReaderFocus.enter(in: press.window)
        case .backToList:
            keyZone = .list
            MailReaderFocus.leave(in: press.window)
        case .dismiss:
            guard let item = model.menuTargetItem else { return true }
            actions.onDismiss(item)
            // Triage keeps moving: the row that takes its place is next.
            // Picked once the dismiss has left the list, from the rows that
            // are still there, so a refresh in between can't select a ghost.
            Task { @MainActor in
                let live = items
                let next = ListKeyRules.selectionAfterRemoval(
                    ids: ids, removed: item.id, present: Set(live.map(\.id)))
                if let target = live.first(where: { $0.id == next }) { actions.onSelect(target) }
            }
        case .reply:
            model.requestReply()
        case .focusSearch:
            model.searchFocusPending = true
        }
        return true
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
                        SearchHitRow(hit: hit, style: rowStyle)
                        rowDivider
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
                }(), style: rowStyle.shell)
            Spacer()
        }
    }
}
