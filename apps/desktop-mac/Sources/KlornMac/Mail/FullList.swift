import SwiftUI

struct FullList: View {
    @Environment(AppModel.self) private var model
    let mode: ListMode
    let actions: TopBarActions
    @Binding var keyZone: MailKeyZone
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
                // ⌘N lives in the app menu (File ▸ New Email) — one owner.
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
                // Same ScrollView + LazyVStack as before M3; the reader only
                // adds scroll-into-view for a keyboard-moved selection.
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(items) { item in
                                FullRow(item: item, actions: actions, showLaneChip: mixedLanes)
                                    .id(item.id)
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
        .background(
            MailListKeyCatcher(
                onKey: { handleKey($0) },
                onClickOutsideReader: { keyZone = .list },
                mayReleaseOpeningFocus: {
                    !searchRequested && !model.searchFocusPending && !model.fullViewModalOpen
                }))
        .onDisappear { keyZone = .list }
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
