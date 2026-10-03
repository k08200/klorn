import SwiftUI

/// The standard main window's content (productization plan §4, macOS M4b):
/// a sidebar with the navigation items and a content area per section.
///
/// A custom two-column split rather than `NavigationSplitView`: the window
/// is an AppKit `NSWindow` whose frame, minimum size and restoration are
/// owned by `MainWindowController`, the mail list's keys (M3) depend on the
/// window's first responder, and the offscreen renderer cannot draw
/// AppKit-backed containers. A selectable sidebar `List` would take the
/// arrow keys, and the split view would add its own toolbar and column
/// autosave next to ours. The structure is the same, so the swap is local
/// once `BarState.full` is deleted (M8).
///
/// The bar's full view (`FullView`) is untouched and stays what the panel
/// shows while `macMainWindow` is off.
struct MainShell: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions
    /// Render seam: pins Today's date and the calendar's month in the
    /// offscreen shots. nil in the app.
    var renderDate: Date? = nil

    var body: some View {
        // .top: any overflow must be cut at the bottom, never eat the top
        // row (clipping lessons, 2026-08-20).
        ZStack(alignment: .top) {
            Theme.bg
            HStack(spacing: 0) {
                NavSidebar(actions: actions)
                Rectangle().fill(Theme.line).frame(width: 1)
                content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
            // Keyboard focus must not wander behind a modal.
            .disabled(model.fullViewModalOpen)
            .onAppear {
                model.presentTierGuideIfFirstRun()
                model.presentPurposePromptIfNeeded()
            }
            if showsDock {
                AssistantDock()
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            }
            FullViewModals()
        }
        .frame(
            minWidth: MainWindowRules.minSize.width, maxWidth: .infinity,
            minHeight: MainWindowRules.minSize.height, maxHeight: .infinity, alignment: .top)
    }

    /// The dock keeps the assistant one click away with the mail or the day
    /// still on screen. Assistant has the thread itself, so no dock there.
    private var showsDock: Bool {
        model.phase == .signedIn && !model.fullViewModalOpen
            && model.mainNav.section != .assistant
    }

    @ViewBuilder
    private var content: some View {
        if model.phase != .signedIn {
            // Every section needs an account; none shows a skeleton for it.
            VStack(alignment: .leading, spacing: 0) {
                SectionHeader(title: model.mainNav.section.title)
                Rectangle().fill(Theme.line).frame(height: 1)
                SignInMessage(signingIn: model.phase == .signingIn, onSignIn: actions.onSignIn)
            }
        } else {
            switch model.mainNav.section {
            case .today: TodayScreen(actions: actions, now: renderDate ?? Date())
            case .mail: MailSection(actions: actions)
            case .calendar: CalendarSection(actions: actions, initialAnchor: renderDate ?? Date())
            case .assistant: AssistantSection(actions: actions)
            }
        }
    }
}

/// Signed out, or waiting on the browser: a message and the way forward.
struct SignInMessage: View {
    let signingIn: Bool
    let onSignIn: () -> Void

    var body: some View {
        if signingIn {
            StateMessage(
                icon: "safari", title: L("today.signingIn.title"),
                detail: L("today.signingIn.detail"), actionTitle: L("today.signIn.restart"),
                action: onSignIn)
        } else {
            StateMessage(
                icon: "person.crop.circle", title: L("today.signedOut.title"),
                detail: L("today.signedOut.detail"), actionTitle: L("auth.logIn"),
                action: onSignIn)
        }
    }
}

/// A section's title row: the display step, an optional dim detail beside
/// it, and trailing controls. One height for every section so the content
/// below starts on the same line when the section changes.
struct SectionHeader<Trailing: View>: View {
    let title: String
    var detail: String? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.s2) {
            Text(title).font(Theme.Typo.display).foregroundStyle(Theme.text)
                .accessibilityAddTraits(.isHeader)
            if let detail {
                Text(detail).font(Theme.Typo.body).foregroundStyle(Theme.textDim).lineLimit(1)
            }
            Spacer(minLength: Theme.s3)
            trailing()
        }
        .padding(.horizontal, Theme.s6)
        .frame(height: NavRules.topBarHeight)
    }
}

extension SectionHeader where Trailing == EmptyView {
    init(title: String, detail: String? = nil) {
        self.init(title: title, detail: detail) { EmptyView() }
    }
}

/// A message with one action, for the states that are not "loading":
/// signed out, failed. Never the sorting skeleton.
struct StateMessage: View {
    let icon: String
    let title: String
    let detail: String?
    let actionTitle: String?
    let action: () -> Void

    var body: some View {
        VStack(spacing: Theme.s3) {
            Image(systemName: icon)
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(Theme.textDim)
                .accessibilityHidden(true)
            Text(title).font(Theme.Typo.head).foregroundStyle(Theme.text)
                .multilineTextAlignment(.center)
            if let detail {
                Text(detail).font(Theme.Typo.body).foregroundStyle(Theme.textDim)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let actionTitle {
                Button(actionTitle, action: action)
                    .buttonStyle(PrimaryButtonStyle())
                    .padding(.top, Theme.s1)
            }
        }
        .frame(maxWidth: 360)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(Theme.s6)
    }
}
