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
/// autosave next to ours. The structure is the same, so the swap stays
/// local now that the bar's full state is deleted (M8).
struct MainShell: View {
    @Environment(AppModel.self) private var model
    let actions: ShellActions
    /// Render seam: pins Today's date and the calendar's month in the
    /// offscreen shots. nil in the app.
    var renderDate: Date? = nil

    var body: some View {
        // .top: any overflow must be cut at the bottom, never eat the top
        // row (clipping lessons, 2026-08-20).
        ZStack(alignment: .top) {
            // The account-tinted chrome (M1, 2026-11-13), under the
            // transparent title bar too; the shell itself stays inside the
            // safe area, below the traffic lights.
            Theme.chromeGradient(identity: chromeIdentity).ignoresSafeArea()
            HStack(spacing: 0) {
                NavSidebar(actions: actions)
                VStack(spacing: 0) {
                    // Loaded mail whose refresh is failing (M6).
                    if let notice = model.connectionNotice { ConnectionBanner(notice: notice) }
                    if let message = model.actionError { ActionErrorBanner(message: message) }
                    HStack(spacing: 0) {
                        content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                            // A zone the web pins (or un-pins) redraws every time.
                            .id(model.displayTimeZoneID ?? "")
                        // The assistant keeps the mail or the day on screen
                        // beside it (M3): its own card INSIDE the content
                        // card, below the title bar (founder, 2026-11-13 —
                        // under the title bar its close button was covered).
                        if model.assistantPanelVisible {
                            AssistantPanel()
                                .padding([.trailing, .bottom], AssistantPanelRules.inset)
                        }
                    }
                }
                .clipShape(UnevenRoundedRectangle(cornerRadii: ShellChrome.contentCorners))
                // Inside the card: under a title bar the top is extra air.
                .padding(.top, Theme.s2)
                // The floating content card, inset from the window's edges.
                // It reaches up under the title bar; the content does not.
                .background {
                    RoundedRectangle(cornerRadius: Theme.Radius.contentCard)
                        .fill(Theme.todayCard)
                        .shadow(color: Theme.todayCardShadow, radius: ShellChrome.shadowRadius, y: ShellChrome.shadowY)
                        .padding(.top, Theme.s2)
                        .ignoresSafeArea(.container, edges: .top)
                }
                .padding([.trailing, .bottom], Theme.s2)
            }
            // Keyboard focus must not wander behind a modal.
            .disabled(model.fullViewModalOpen)
            // The bell's floating panel (NC2-A): inside the safe area, so
            // below the title bar; over the content and the assistant panel
            // without taking part in their layout.
            .overlay(alignment: .topTrailing) {
                if model.notificationCenter.panelOpen, model.phase == .signedIn, !model.fullViewModalOpen {
                    NotificationPanelLayer(actions: actions)
                }
            }
            .onAppear {
                model.presentTierGuideIfFirstRun()
                model.presentPurposePromptIfNeeded()
            }
        }
        .frame(
            minWidth: MainWindowRules.minSize.width, maxWidth: .infinity,
            minHeight: MainWindowRules.minSize.height, maxHeight: .infinity, alignment: .top)
        // No overlay layer here: the guide, the event editor and the
        // connect-time question are native sheets on the window (M5,
        // `MainWindowController.syncSheet`); the composer is its own window.
    }

    /// The chrome takes the selected account's tone; all accounts is espresso.
    private var chromeIdentity: Theme.RGBA? {
        AccountIdentity.color(selection: model.selectedInbox, among: model.inboxes)
    }

    @ViewBuilder
    private var content: some View {
        if model.phase != .signedIn {
            // Every section needs an account; none shows a skeleton for it.
            VStack(alignment: .leading, spacing: 0) {
                SectionHeader(title: model.mainNav.section.title)
                Rectangle().fill(Theme.line).frame(height: Theme.hairline)
                SurfaceStateView(state: model.surfaceState)
            }
        } else {
            switch FilesRules.displayed(model.mainNav.section, files: model.clientFlags.files) {
            case .today: TodayScreen(actions: actions, now: renderDate ?? Date())
            case .mail: MailSection(actions: actions)
            case .calendar: CalendarSection(actions: actions, initialAnchor: renderDate ?? Date())
            // FD-7: with the flag off `displayed` already answered Today.
            case .files: FilesSection()
            case .assistant: AssistantSection(actions: actions)
            }
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
            Text(title).font(Theme.Typo.title).foregroundStyle(Theme.text)
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

/// The content card's geometry (gen_m1e.py: inset 8, radius 12, shadow
/// 0 10 30). SwiftUI's shadow radius is half the CSS blur.
enum ShellChrome {
    static let shadowRadius: CGFloat = 15
    static let shadowY: CGFloat = 10
    /// The content clips to the card's bottom corners; its top sits below
    /// the title bar, inside the card.
    static let contentCorners = RectangleCornerRadii(
        bottomLeading: Theme.Radius.contentCard, bottomTrailing: Theme.Radius.contentCard)
}
