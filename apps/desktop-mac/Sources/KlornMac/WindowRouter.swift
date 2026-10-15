import AppKit
import Carbon.HIToolbox
import Foundation

/// Klorn on Mac is a standard app (founder decision 2026-10-15, superseding
/// FD-5 "the pill stays" and the older Cmd+Tab compromise): one main window
/// plus a Dock icon, with PUSH mail announced by macOS notification banners.
/// These are the app-level rules, pure so the self-check pins them.
enum AppRules {
    /// Always `.regular`: Dock icon and Cmd+Tab whether or not a window is
    /// open. There is no ambient, Dock-less state anymore.
    static let activationPolicy: NSApplication.ActivationPolicy = .regular

    /// Closing the last window never quits: the poll loop and the PUSH
    /// banners keep working with no window open. ⌘Q quits.
    static let terminatesAfterLastWindowClosed = false

    /// What a launch opens.
    enum LaunchAction: Equatable {
        case onboarding
        case mainWindow(activate: Bool)
        case none
    }

    /// Launch-at-login decision (documented in apps/desktop-mac/README.md):
    /// a login launch must not steal focus, so it opens nothing — unless the
    /// main window was open when Klorn last quit, in which case it comes back
    /// without taking focus. Any other launch is the user opening the app:
    /// the main window when signed in, onboarding when not.
    static func launchAction(
        signedIn: Bool, loginLaunch: Bool, mainWindowOpenAtQuit: Bool
    ) -> LaunchAction {
        if loginLaunch {
            return signedIn && mainWindowOpenAtQuit ? .mainWindow(activate: false) : .none
        }
        return signedIn ? .mainWindow(activate: true) : .onboarding
    }

    /// Whether the launch Apple event says "launched as a login item".
    /// `SMAppService.mainApp` login launches carry it, as legacy login items
    /// did. Pure for testing.
    static func isLoginLaunch(eventID: AEEventID?, propData: OSType?) -> Bool {
        eventID == AEEventID(kAEOpenApplication) && propData == OSType(keyAELaunchedAsLogInItem)
    }

    /// What ⌥⌘K does.
    enum HotKeyAction: Equatable { case raise, hide }

    /// Raise and focus the main window; if it is already frontmost, hide
    /// the app (NSApp.hide) — the same press puts Klorn away again.
    static func hotKeyAction(mainWindowFrontmost: Bool) -> HotKeyAction {
        mainWindowFrontmost ? .hide : .raise
    }
}

/// The main window's open/close surface, behind a seam so the routing is
/// testable without a window server.
@MainActor
protocol MainWindowPresenting: AnyObject {
    func open(activate: Bool)
    func close()
    var isFrontmost: Bool { get }
}

/// The onboarding window, behind the same kind of seam.
@MainActor
protocol OnboardingPresenting: AnyObject {
    func open()
}

/// Every "show me Klorn" entry point lands here: launch, Dock click or
/// Finder reopen, ⌥⌘K, a tapped banner, and the shell's own actions.
@MainActor
final class WindowRouter {
    private let model: AppModel
    private let mainWindow: any MainWindowPresenting
    var onboarding: (any OnboardingPresenting)?
    /// Opens the Settings window (wired to `SettingsOpener`).
    var openSettings: () -> Void = {}
    /// Hides the app (NSApp.hide); a seam for the harness.
    var hideApp: () -> Void = { NSApp.hide(nil) }

    init(model: AppModel, mainWindow: any MainWindowPresenting) {
        self.model = model
        self.mainWindow = mainWindow
    }

    func openMainWindow(activate: Bool = true) {
        mainWindow.open(activate: activate)
    }

    func launch(loginLaunch: Bool) {
        switch AppRules.launchAction(
            signedIn: model.phase == .signedIn, loginLaunch: loginLaunch,
            mainWindowOpenAtQuit: model.settings.mainWindowOpenAtQuit)
        {
        case .onboarding: onboarding?.open()
        case .mainWindow(let activate): openMainWindow(activate: activate)
        case .none: break
        }
    }

    /// Dock click, Finder double-click of a running Klorn, or ⌥⌘K raising:
    /// onboarding while it is open, else the main window.
    func reopen() {
        switch OnboardingRules.reopenTarget(onboardingOpen: model.onboardingWindowOpen) {
        case .onboarding: onboarding?.open()
        case .fullView: openMainWindow()
        }
    }

    func handleHotKey() {
        switch AppRules.hotKeyAction(mainWindowFrontmost: mainWindow.isFrontmost) {
        case .raise: reopen()
        case .hide: hideApp()
        }
    }

    /// Show one item in the main window's reading pane: the single in-app
    /// answer to "open this", shared by the shell and the banners.
    func openInApp(_ item: FirewallItem) {
        openMainWindow()
        // The window may be on Today or another section: bring Mail forward
        // on a facet that lists the item (M4b).
        model.revealInMail(item)
        Task { await model.select(item) }
    }

    /// A tapped banner lands on the mail it announced; if that mail is gone
    /// from the queue the main window still opens — a tap never does nothing.
    func handleNotificationTap(identifier: String) {
        // One lookup, reused: `queue` is an immutable snapshot, so the item
        // found while routing is the item we open.
        let queue = model.queue
        var found: FirewallItem?
        let action = PushNotifier.tapAction(identifier: identifier) { id in
            found = queue?.item(id: id)
            return found != nil
        }
        switch action {
        case .ignore:
            return  // not ours — never claim another app's notification
        case .open:
            if let item = found { openInApp(item) } else { openMainWindow() }
        case .openApp:
            openMainWindow()
        }
    }

    /// The main window shell's actions.
    func makeActions() -> ShellActions {
        ShellActions(
            onSignIn: { [weak self] in guard let self else { return }; Task { await self.model.signIn() } },
            onSignOut: { [weak self] in self?.model.signOut() },
            onOpenInApp: { [weak self] item in self?.openInApp(item) },
            onOpenTier: { [weak self] tier in
                guard let self else { return }
                self.model.showTier(tier)
                self.openMainWindow()
            },
            onOpenFull: { [weak self] in self?.openMainWindow() },
            onOpenProposals: { [weak self] in
                guard let self else { return }
                self.model.listMode = .proposals
                self.openMainWindow()
            },
            onDismiss: { [weak self] item in guard let self else { return }; Task { await self.model.dismiss(item) } },
            onSnooze: { [weak self] item, option in
                guard let self else { return }
                Task { await self.model.snooze(item, until: option.resurface()) }
            },
            onSetTier: { [weak self] item, tier in
                guard let self else { return }
                Task { await self.model.setTier(item, to: tier) }
            },
            onPinSender: { [weak self] item, tier in
                guard let self else { return }
                Task { await self.model.pinSender(item, to: tier) }
            },
            onUnpinSender: { [weak self] item in
                guard let self else { return }
                Task { await self.model.unpinSender(item) }
            },
            onSelect: { [weak self] item in guard let self else { return }; Task { await self.model.select(item) } },
            onOpenPreferences: { [weak self] in self?.openSettings() },
            onQuit: { NSApplication.shared.terminate(nil) })
    }
}
