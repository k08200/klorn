import SwiftUI

/// The sidebar footer's update row (founder, 2026-11-13, LOCKED), above
/// Settings. It drives the existing pipeline only: the release check
/// (`AppModel.checkForUpdateNow`, the `updateCheck` seam) and the in-place
/// install (`SelfUpdate.run`: download the zip → verify → swap → relaunch).
/// Settings ▸ General keeps its own row.
enum SidebarUpdateRules {
    enum State: Equatable {
        case idle
        case checking
        case available(String)
        /// `SelfUpdate.run` reports no progress, so this is indeterminate.
        case installing(String)
        case upToDate
        /// A failed check (retryVersion nil) or an install that fell back to
        /// the release page (retry installs that version again).
        case failed(retryVersion: String?)
    }

    enum Event: Equatable {
        case tapped
        case checkFinished(UpdateCheck.Outcome)
        case installFellBack
        case upToDateExpired
    }

    /// "Up to date" shows this long, then the row is idle again.
    static let upToDateSeconds: Double = 3

    static func initial(available: String?) -> State {
        available.map(State.available) ?? .idle
    }

    static func reduce(_ state: State, _ event: Event) -> State {
        switch (state, event) {
        case (.idle, .tapped), (.upToDate, .tapped), (.failed(nil), .tapped):
            return .checking
        case (.available(let version), .tapped), (.failed(.some(let version)), .tapped):
            return .installing(version)
        case (.checking, .checkFinished(let outcome)):
            switch outcome {
            case .updateAvailable(let version): return .available(version)
            case .upToDate: return .upToDate
            case .unknown: return .failed(retryVersion: nil)
            }
        case (.installing(let version), .installFellBack):
            return .failed(retryVersion: version)
        case (.upToDate, .upToDateExpired):
            return .idle
        default:
            return state
        }
    }

    static func title(_ state: State, text: (String) -> String = { L($0) }) -> String {
        switch state {
        case .idle: text("prefs.updates.check")
        case .checking: text("prefs.updates.checking")
        case .available(let version): String(format: text("update.sidebar.install"), version)
        case .installing: text("update.updating")
        case .upToDate: text("update.sidebar.upToDate")
        case .failed(nil): text("update.sidebar.checkFailed")
        case .failed(.some): text("update.sidebar.installFailed")
        }
    }

    /// The leading symbol; nil while a spinner stands in for it.
    static func symbol(_ state: State) -> String? {
        switch state {
        case .idle: "arrow.down.circle"
        case .checking, .installing: nil
        case .available: "arrow.down.circle.fill"
        case .upToDate: "checkmark.circle"
        case .failed: "arrow.clockwise"
        }
    }

    static func showsSpinner(_ state: State) -> Bool { symbol(state) == nil }

    static func isEmphasized(_ state: State) -> Bool {
        if case .available = state { return true }
        return false
    }

    static func isBusy(_ state: State) -> Bool { showsSpinner(state) }
}

struct SidebarUpdateButton: View {
    @Environment(AppModel.self) private var model
    @State private var state: SidebarUpdateRules.State = .idle
    @State private var started = false

    var body: some View {
        Button(action: tap) {
            HStack(spacing: Theme.s2) {
                Group {
                    if let symbol = SidebarUpdateRules.symbol(state) {
                        Image(systemName: symbol).font(Theme.Typo.body)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                }
                .foregroundStyle(Theme.accent)
                .frame(width: NavFooterLayout.iconWidth)
                .accessibilityHidden(true)
                Text(SidebarUpdateRules.title(state))
                    .font(SidebarUpdateRules.isEmphasized(state) ? Theme.Typo.label : Theme.Typo.body)
                    .foregroundStyle(SidebarUpdateRules.isEmphasized(state) ? Theme.accent : Theme.sidebarInkDim)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .frame(height: NavFooterLayout.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(SidebarUpdateRules.isBusy(state))
        .help(SidebarUpdateRules.title(state))
        .accessibilityLabel(SidebarUpdateRules.title(state))
        .onAppear {
            guard !started else { return }
            started = true
            state = SidebarUpdateRules.initial(available: model.updateAvailable)
        }
        // The timed check found a build while the row sat idle.
        .onChange(of: model.updateAvailable) { _, version in
            if let version, state == .idle { state = .available(version) }
        }
    }

    private func tap() {
        let next = SidebarUpdateRules.reduce(state, .tapped)
        guard next != state else { return }
        state = next
        switch next {
        case .checking: Task { await check() }
        case .installing(let version): Task { await install(version) }
        default: break
        }
    }

    private func check() async {
        let outcome = await model.checkForUpdateNow()
        state = SidebarUpdateRules.reduce(state, .checkFinished(outcome))
        guard state == .upToDate else { return }
        try? await Task.sleep(for: .seconds(SidebarUpdateRules.upToDateSeconds))
        state = SidebarUpdateRules.reduce(state, .upToDateExpired)
    }

    private func install(_ version: String) async {
        // Returns only on fallback (the release page opened); success
        // terminates and relaunches the app.
        _ = await SelfUpdate.run(version: version)
        state = SidebarUpdateRules.reduce(state, .installFellBack)
    }
}

/// The sidebar footer rows' measures (update, Settings).
enum NavFooterLayout {
    static let iconWidth: CGFloat = 20
    static let rowHeight: CGFloat = 28
}
