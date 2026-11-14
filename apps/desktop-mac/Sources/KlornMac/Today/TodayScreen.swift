import SwiftUI

/// Today — the main window's home (productization plan §1, FD-1), in the
/// editorial layout the founder chose on 2026-11-13 (M1 dark / M2 light):
/// one headline that counts what is waiting, the PUSH mail as cards that say
/// why each is urgent, the other lanes as compact sections, and today's
/// schedule in a sticky right column (a strip under the headline when the
/// card is narrow; DMG feedback, 2026-11-13). Composed from what the app
/// already holds; it fetches nothing.
struct TodayScreen: View {
    @Environment(AppModel.self) private var model
    let actions: ShellActions
    /// Injectable so the offscreen renderer shows a fixed date.
    var now = Date()

    private var state: SurfaceState { model.surfaceState }

    /// No date in a preview render (`TodayRules.headerDetail`); the shipping
    /// app always shows today's date.
    private var dateLabel: String? {
        TodayRules.headerDetail(
            now: now, renderingOffscreen: Theme.isRenderingOffscreen, locale: L10n.activeLocale)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TodayTopRow()
            switch state {
            case .signedOut, .signingIn:
                SurfaceStateView(state: state)
            case .offline, .failed:
                // The error replaces the lanes, not the frame: the state
                // anchors where the headline would be.
                page {
                    SurfaceStateView(state: state, anchorInset: TodayLayout.anchorInColumn)
                        .frame(maxWidth: .infinity, alignment: .top)
                }
            case .loading:
                // The skeleton is the loaded Today's shape.
                page { TodaySkeleton() }
            case .ready:
                // The day's placement follows the card's own width (column
                // when wide, strip when narrow or beside the assistant).
                GeometryReader { proxy in
                    ready(placement: TodayLayoutRules.calendarPlacement(contentWidth: proxy.size.width))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private func ready(placement: TodayLayoutRules.CalendarPlacement) -> some View {
        switch placement {
        case .column:
            // The column stays put while the mail scrolls (founder,
            // 2026-11-13: the day without scrolling).
            HStack(alignment: .top, spacing: Theme.s6) {
                scrolling { mainColumn(strip: false).padding(.bottom, Theme.s6) }
                TodayCalendarColumn(now: now)
            }
            .padding(.horizontal, Theme.s8)
            .frame(maxWidth: TodayLayout.maxWidth + TodayLayoutRules.columnWidth + Theme.s6, alignment: .topLeading)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        case .strip:
            scrolling {
                page {
                    VStack(alignment: .leading, spacing: Theme.s6) {
                        mainColumn(strip: true)
                        TodayExtras(now: now)
                    }
                }
            }
        }
    }

    /// The headline, the PUSH cards, then the compact lanes; with `strip`
    /// the day's strip sits under the headline, above the cards.
    private func mainColumn(strip: Bool) -> some View {
        let lanes = model.queue.map(TodayRules.lanes) ?? []
        let push = lanes.first { $0.tier == .push }
        return VStack(alignment: .leading, spacing: Theme.s6) {
            TodayHeadline(dateLabel: dateLabel, pushCount: push?.count ?? 0)
            if strip { TodayCalendarStrip(now: now) }
            if let push {
                TodayPushCards(lane: push, now: now, actions: actions, open: open)
            }
            ForEach(lanes.filter { $0.tier != .push }, id: \.tier) { lane in
                TodayLaneSection(lane: lane, now: now, open: open)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    /// A ScrollView in the app. ImageRenderer draws nothing inside one, so
    /// offscreen the content is laid out at its full height and cut at the
    /// frame instead.
    @ViewBuilder
    private func scrolling(@ViewBuilder _ content: () -> some View) -> some View {
        if Theme.isRenderingOffscreen {
            Color.clear.overlay(alignment: .topLeading) {
                content().fixedSize(horizontal: false, vertical: true)
            }
            .clipped()
        } else {
            ScrollView { content() }
        }
    }

    /// The Today frame every state shares: one column, the card's margins.
    private func page(@ViewBuilder _ main: () -> some View) -> some View {
        main()
            .padding(.horizontal, Theme.s8).padding(.bottom, Theme.s6)
            .frame(maxWidth: TodayLayout.maxWidth, alignment: .topLeading)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// A card or a row opens in Mail: the list on a facet that holds it,
    /// the reader beside it.
    private func open(_ item: FirewallItem) {
        model.revealInMail(item)
        actions.onSelect(item)
    }
}

/// The card's top row: the scope it shows ("All accounts" or one address)
/// and search. The toolbar's Assistant button sits in the title bar above.
private struct TodayTopRow: View {
    @Environment(AppModel.self) private var model

    private var scope: String {
        guard let value = inboxQueryParam(selected: model.selectedInbox),
              let inbox = model.inboxes.first(where: { $0.selectionValue == value })
        else { return L("nav.accounts.all") }
        return inboxDisplayLabel(email: inbox.email, kind: inbox.kind)
    }

    var body: some View {
        HStack(spacing: Theme.s3) {
            Text(scope).font(Theme.Typo.scopeLabel).foregroundStyle(Theme.todayInk3)
                .lineLimit(1).truncationMode(.middle)
            Spacer(minLength: Theme.s3)
            // Search lives in Mail (Find, ⌘F): the same path.
            Button {
                if !model.listMode.hasSearchField { model.go(to: .inbox) }
                model.navigate(to: .mail)
                model.searchFocusPending = true
            } label: {
                Image(systemName: "magnifyingglass").font(Theme.Typo.body)
                    .foregroundStyle(Theme.todayInk2)
                    .frame(width: TodayLayout.topRowHeight, height: TodayLayout.topRowHeight)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(L("today.search"))
            .accessibilityLabel(L("today.search"))
        }
        .padding(.leading, Theme.s6).padding(.trailing, Theme.s3)
        .frame(height: TodayLayout.topRowHeight)
    }
}

/// The caps line (date · meetings · free time) and the headline that counts
/// the PUSH mail waiting.
private struct TodayHeadline: View {
    @Environment(AppModel.self) private var model
    let dateLabel: String?
    let pushCount: Int

    var body: some View {
        let parts = TodayBriefRules.kickerParts(
            date: dateLabel, meetings: TodayBriefRules.meetings(model.today),
            freeHours: TodayBriefRules.freeHours(model.briefingStructure))
        VStack(alignment: .leading, spacing: Theme.s1) {
            if !parts.isEmpty {
                Text(parts.joined(separator: " · "))
                    .font(Theme.Typo.todayCaps).tracking(TodayTracking.caps)
                    .textCase(.uppercase)
                    .foregroundStyle(Theme.todayInk3)
                    .lineLimit(1)
            }
            Text(TodayBriefRules.headline(pushCount: pushCount))
                .font(Theme.Typo.page).foregroundStyle(Theme.todayInk1)
                .lineLimit(2)
                .accessibilityAddTraits(.isHeader)
        }
    }
}

extension View {
    /// A Today block: the raised surface, no hairline, no shadow.
    func todayPanel() -> some View {
        background(Theme.todayRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.briefCard))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.briefCard))
    }
}
