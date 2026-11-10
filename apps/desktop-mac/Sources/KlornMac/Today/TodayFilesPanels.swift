import SwiftUI

/// Today — "Recent files" (productization plan §1, P12): the newest few files
/// of every drive source that is on. Mounted only while `ClientFlags.files`
/// is on; with it off nothing is asked for.
struct TodayRecentFilesPanel: View {
    @Environment(AppModel.self) private var model

    private var store: FilesStore { model.files }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            PanelHeader(title: L("today.files.title"), linkTitle: L("today.files.open")) {
                model.navigate(to: .files)
            }
            content
            if let error = store.downloadError {
                FileDownloadErrorLine(kind: error.kind, name: error.name) { store.dismissDownloadError() }
            }
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .todayPanel()
        .task {
            guard !Theme.isRenderingOffscreen, store.recentPhase == .idle else { return }
            await store.refreshRecent()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.recentPhase {
        case .idle, .loading:
            Text(L("files.loading")).font(Theme.Typo.body).foregroundStyle(Theme.textDim)
        case .failed:
            HStack(spacing: Theme.s2) {
                Text(L("files.error")).font(Theme.Typo.body).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: Theme.s1)
                Button(L("today.retry")) { Task { await store.refreshRecent() } }
                    .buttonStyle(SolidButtonStyle(prominent: false, compact: true))
            }
        case .loaded:
            if store.recent.isEmpty {
                Text(L("today.files.none")).font(Theme.Typo.body).foregroundStyle(Theme.textDim)
            } else {
                VStack(spacing: 0) {
                    ForEach(store.recent) { file in
                        FileRowView(
                            file: file, preparing: store.downloadingId == file.id, compact: true
                        ) { open(file) }
                        .padding(.horizontal, -Theme.s3)
                    }
                }
            }
        }
    }

    /// A folder opens Files at it; anything else opens as it does in Files.
    private func open(_ file: DriveFileWire) {
        if FilesRules.openAction(for: file) == .folder {
            store.startAt(folder: file)
            model.navigate(to: .files)
        } else {
            Task { await store.open(file) }
        }
    }
}

/// Today — "When is everyone free?" (§1, P12, team mode). Offered only with
/// the server's team mode on and a saved team. Reads the common free slots
/// for the user and every member whose calendar is visible over the next
/// seven days, in 30-minute slots, in the user's time zone. Members whose
/// calendars cannot be seen are named above the slots, never counted as
/// free. It creates no event.
struct TodayFreeTimePanel: View {
    @Environment(AppModel.self) private var model
    /// Render seam: a fixed clock for the offscreen shots. nil in the app.
    var renderNow: Date? = nil

    private var store: FreeTimeStore { model.freeTime }

    var body: some View {
        let teams = model.teams
        let teamId = store.teamId(in: teams)
        VStack(alignment: .leading, spacing: Theme.s3) {
            Text(L("today.freeTime.title")).font(Theme.Typo.head).foregroundStyle(Theme.text)
                .accessibilityAddTraits(.isHeader)
            if teams.count > 1 { teamPicker(teams, selected: teamId) }
            Button {
                guard let teamId else { return }
                Task { await store.find(teamId: teamId) }
            } label: {
                Text(store.pending ? L("today.freeTime.finding") : L("today.freeTime.find"))
            }
            .buttonStyle(SolidButtonStyle(prominent: false, fullWidth: true))
            .disabled(store.pending || teamId == nil)
            if store.failed(for: teamId) {
                Text(L("today.freeTime.error")).font(Theme.Typo.caption).foregroundStyle(Theme.warningInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let result = store.result(for: teamId) {
                if let renderNow {
                    FreeTimeResultView(result: result, now: renderNow, recheck: recheck(teamId))
                } else {
                    // Re-reads the clock each minute so past slots drop off.
                    TimelineView(.periodic(from: .now, by: FreeTimeRules.clockTick)) { context in
                        FreeTimeResultView(result: result, now: context.date, recheck: recheck(teamId))
                    }
                }
            }
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .todayPanel()
    }

    private func recheck(_ teamId: String?) -> () -> Void {
        { if let teamId { Task { await store.find(teamId: teamId) } } }
    }

    @ViewBuilder
    private func teamPicker(_ teams: [TeamWire], selected: String?) -> some View {
        if Theme.isRenderingOffscreen {
            OffscreenMenuLabel(title: teams.first { $0.id == selected }?.name ?? "")
        } else {
            Picker(L("today.freeTime.team"), selection: Binding(
                get: { selected ?? "" },
                set: { store.select(teamId: $0) }
            )) {
                ForEach(teams) { team in Text(verbatim: team.name).tag(team.id) }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .accessibilityLabel(L("today.freeTime.team"))
        }
    }
}

/// The slots, after the notice about whose calendars were not seen. With no
/// member checked at all the slots are the user's own and say so. A slot
/// that has started is not shown; an old result offers "Check again".
private struct FreeTimeResultView: View {
    @Environment(AppModel.self) private var model
    let result: TeamAvailabilityWire
    let now: Date
    let recheck: () -> Void

    var body: some View {
        let selfOnly = FreeTimeRules.scope(result) == .selfOnly
        let slots = FreeTimeRules.upcoming(result.slots, now: now)
        let stale = FreeTimeRules.stale(fetchedAt: model.freeTime.fetchedAt, slots: result.slots, now: now)
        let zone = FreeTimeRules.timeZone(for: result)
        VStack(alignment: .leading, spacing: Theme.s2) {
            if selfOnly {
                note(L("today.freeTime.selfOnly"))
            } else if let unknown = FreeTimeRules.unknownNotice(result) {
                note(unknown)
            }
            if stale {
                HStack(spacing: Theme.s2) {
                    note(L("today.freeTime.stale"))
                    Spacer(minLength: Theme.s1)
                    Button(model.freeTime.pending ? L("today.freeTime.finding") : L("today.freeTime.recheck"),
                           action: recheck)
                        .buttonStyle(SolidButtonStyle(prominent: false, compact: true))
                        .disabled(model.freeTime.pending)
                }
            }
            // Every slot already past: "Check again" says it better than "none".
            if result.slots.isEmpty {
                note(L("today.freeTime.none", FreeTimeRules.windowDays))
            }
            if !slots.isEmpty {
                VStack(alignment: .leading, spacing: Theme.s1) {
                    ForEach(slots) { slot in
                        Text(FreeTimeRules.label(slot, locale: L10n.activeLocale, timeZone: zone))
                            .font(Theme.Typo.body.monospacedDigit()).foregroundStyle(Theme.text)
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(selfOnly ? L("today.freeTime.selfOnlyList") : L("today.freeTime.teamList"))
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
            .fixedSize(horizontal: false, vertical: true)
    }
}
