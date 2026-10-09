import SwiftUI

/// What a mail surface can be (productization plan, macOS M6). The loading
/// skeleton is for loading only; signed out, signing in, offline and failed
/// are their own states with a title, one line and one action.
enum SurfaceState: Equatable, Sendable {
    case signedOut
    case signingIn
    case loading
    /// The server could not be reached and there is nothing to show.
    case offline
    /// The server answered with an error and there is nothing to show.
    case failed(String)
    case ready
}

/// A notice over content that is on screen but no longer fresh.
enum ConnectionNotice: Equatable, Sendable {
    case offline
    case stale
}

/// Pure state → view rules, pinned by the self-check.
enum SurfaceStateRules {
    static func state(
        phase: AppModel.Phase, hasQueue: Bool, loadError: String?, offline: Bool
    ) -> SurfaceState {
        switch phase {
        case .signedOut: return .signedOut
        case .signingIn: return .signingIn
        case .signedIn:
            if hasQueue { return .ready }
            guard let loadError else { return .loading }
            return offline ? .offline : .failed(loadError)
        }
    }

    /// The "sorting every message into its lane" skeleton: loading, only.
    static func showsSkeleton(_ state: SurfaceState) -> Bool {
        state == .loading
    }

    /// States that replace the content with a message and an action.
    static func isBlocking(_ state: SurfaceState) -> Bool {
        state != .loading && state != .ready
    }

    /// The banner over loaded content whose refresh is failing. Never over a
    /// blocking state, which already says what is wrong.
    static func notice(
        phase: AppModel.Phase, hasQueue: Bool, loadError: String?, offline: Bool
    ) -> ConnectionNotice? {
        guard phase == .signedIn, hasQueue, loadError != nil else { return nil }
        return offline ? .offline : .stale
    }

    /// The pill's status chip. The pill has no room for a state view, so any
    /// failed load shows there, with or without a queue behind it.
    static func pillNotice(
        phase: AppModel.Phase, loadError: String?, offline: Bool
    ) -> ConnectionNotice? {
        guard phase == .signedIn, loadError != nil else { return nil }
        return offline ? .offline : .stale
    }

    /// Offline means the request never reached a server.
    static func isOffline(_ error: Error) -> Bool {
        if case APIError.transport = error { return true }
        return false
    }
}

extension AppModel {
    var surfaceState: SurfaceState {
        SurfaceStateRules.state(
            phase: phase, hasQueue: queue != nil, loadError: loadError, offline: loadOffline)
    }

    var connectionNotice: ConnectionNotice? {
        SurfaceStateRules.notice(
            phase: phase, hasQueue: queue != nil, loadError: loadError, offline: loadOffline)
    }

    var pillNotice: ConnectionNotice? {
        SurfaceStateRules.pillNotice(phase: phase, loadError: loadError, offline: loadOffline)
    }
}

extension ConnectionNotice {
    var icon: String {
        switch self {
        case .offline: "wifi.slash"
        case .stale: "exclamationmark.arrow.triangle.2.circlepath"
        }
    }

    var message: String {
        switch self {
        case .offline: L("banner.offline")
        case .stale: L("banner.stale")
        }
    }

    /// The pill's two-word version.
    var shortLabel: String {
        switch self {
        case .offline: L("bar.offline")
        case .stale: L("bar.notUpdating")
        }
    }
}

/// The one button look of the state and onboarding views: a flat fill on
/// the control radius. `prominent` is the single primary action.
struct SolidButtonStyle: ButtonStyle {
    var prominent = true
    var fullWidth = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Typo.body.weight(.semibold))
            .foregroundStyle(prominent ? Theme.onAccentSolid : Theme.text)
            .padding(.horizontal, Theme.s4)
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: 32)
            .background(
                prominent ? Theme.accentSolid : Theme.surfaceRaised,
                in: RoundedRectangle(cornerRadius: Theme.Radius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(prominent ? Color.clear : Theme.line))
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.5)
    }
}

/// The sign-in choices: Google always, then whatever else the server
/// offers. Every button is an existing entry point (`AppModel.signIn`).
struct SignInButtons: View {
    @Environment(AppModel.self) private var model
    var fullWidth = false

    var body: some View {
        VStack(spacing: Theme.s2) {
            Button(L("auth.continueGoogle")) { Task { await model.signIn() } }
                .buttonStyle(SolidButtonStyle(fullWidth: fullWidth))
            ForEach(model.loginProviders.filter { $0 != "google" }, id: \.self) { provider in
                Button(loginProviderLabel(provider)) {
                    Task { await model.signIn(provider: provider) }
                }
                .buttonStyle(SolidButtonStyle(prominent: false, fullWidth: fullWidth))
            }
            if let error = model.signInError {
                Text(error).font(Theme.Typo.caption).foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, Theme.s1)
            }
        }
    }
}

/// A blocking state, drawn: icon, title, one line, one action. Used by the
/// bar's full view, the expanded panel and the main window alike. Draws
/// nothing for `loading` and `ready`, which have their own content.
struct SurfaceStateView: View {
    @Environment(AppModel.self) private var model
    let state: SurfaceState
    /// The expanded panel's column: no icon, tighter, leading.
    var compact = false

    var body: some View {
        switch state {
        case .signedOut:
            message(
                icon: "person.crop.circle", title: L("state.signedOut.title"),
                detail: L("today.signedOut.detail")
            ) { SignInButtons() }
        case .signingIn:
            message(
                icon: "safari", title: L("today.signingIn.title"),
                detail: L("today.signingIn.detail")
            ) {
                Button(L("today.signIn.restart")) { Task { await model.signIn() } }
                    .buttonStyle(SolidButtonStyle(prominent: false))
            }
        case .offline:
            message(
                icon: "wifi.slash", title: L("state.offline.title"),
                detail: L("state.offline.detail")
            ) { retry }
        case .failed(let reason):
            message(
                icon: "exclamationmark.triangle", title: L("today.failed.title"), detail: reason
            ) { retry }
        case .loading, .ready:
            EmptyView()
        }
    }

    private var retry: some View {
        Button(L("today.retry")) { Task { await model.loadQueue() } }
            .buttonStyle(SolidButtonStyle())
            .disabled(model.isLoadingQueue)
    }

    private func message(
        icon: String, title: String, detail: String, @ViewBuilder action: () -> some View
    ) -> some View {
        VStack(alignment: compact ? .leading : .center, spacing: Theme.s3) {
            if !compact {
                Image(systemName: icon)
                    .font(.system(size: 28, weight: .light))
                    .foregroundStyle(Theme.textDim)
                    .accessibilityHidden(true)
            }
            Text(title).font(Theme.Typo.head).foregroundStyle(Theme.text)
                .multilineTextAlignment(compact ? .leading : .center)
                .accessibilityAddTraits(.isHeader)
            Text(detail).font(Theme.Typo.body).foregroundStyle(Theme.textDim)
                .multilineTextAlignment(compact ? .leading : .center)
                .fixedSize(horizontal: false, vertical: true)
            action().padding(.top, Theme.s1)
        }
        .frame(maxWidth: compact ? .infinity : 360, alignment: compact ? .leading : .center)
        .frame(
            maxWidth: .infinity, maxHeight: compact ? nil : .infinity,
            alignment: compact ? .topLeading : .center)
        .padding(compact ? 0 : Theme.s6)
    }
}

/// The banner over loaded content whose refresh is failing: what is wrong,
/// what is on screen, and a way to try again.
struct ConnectionBanner: View {
    @Environment(AppModel.self) private var model
    let notice: ConnectionNotice

    var body: some View {
        HStack(spacing: Theme.s2) {
            Image(systemName: notice.icon).font(Theme.Typo.icon)
                .foregroundStyle(Theme.textDim).accessibilityHidden(true)
            Text(notice.message).font(Theme.Typo.label).foregroundStyle(Theme.text)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: Theme.s3)
            Button(L("today.retry")) { Task { await model.loadQueue() } }
                .buttonStyle(.plain).font(Theme.Typo.label.weight(.semibold))
                .foregroundStyle(Theme.accentSolid)
                .disabled(model.isLoadingQueue)
                .frame(minHeight: 28).contentShape(Rectangle())
        }
        .padding(.horizontal, Theme.s4)
        .frame(minHeight: 36)
        .frame(maxWidth: .infinity)
        .background(Theme.surfaceRaised)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
        .accessibilityElement(children: .contain)
    }
}
