import AppKit
import Foundation
import SwiftUI
// @preconcurrency: the UNUserNotificationCenterDelegate completion handlers are
// annotated @Sendable in the macOS 26 SDK but not in the macOS 15 SDK the CI
// runner builds against, so a signature that satisfies one rejects the other.
// Importing preconcurrency lets one signature compile on both.
@preconcurrency import UserNotifications

/// Entry point. `--self-check` runs the verification harness and exits (so tests
/// work on a Command Line Tools toolchain with no XCTest); otherwise the app
/// launches as a standard app: a main window and a Dock icon (founder decision
/// 2026-10-15).
@main
enum Entry {
    static func main() {
        if CommandLine.arguments.contains("--self-check") {
            exit(runSelfChecksBlocking() ? 0 : 1)
        }
        // Design tooling: render the real surfaces to PNG and exit. Screen
        // capture is unavailable in some environments, and judging a UI change
        // by reading its diff does not work.
        if let i = CommandLine.arguments.firstIndex(of: "--render-previews") {
            let dir = CommandLine.arguments.count > i + 1
                ? CommandLine.arguments[i + 1] : "./previews"
            exit(MainActor.assumeIsolated { PreviewRender.run(outputDir: dir) } ? 0 : 1)
        }
        // Single instance: a second copy would poll and post every banner
        // twice. If Klorn is already running (e.g. `open -n`), hand focus to
        // it and exit instead of launching a duplicate.
        if let existing = existingInstance() {
            existing.activate()
            return
        }
        // A standard app: Dock icon and Cmd+Tab, always (AppRules).
        NSApplication.shared.setActivationPolicy(AppRules.activationPolicy)
        KlornApp.main()
    }

    /// The already-running Klorn, if any (excludes this process). nil for an
    /// unbundled `swift run` (no bundle id) so the dev loop never self-blocks.
    private static func existingInstance() -> NSRunningApplication? {
        guard let bundleID = Bundle.main.bundleIdentifier else { return nil }
        return NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .first { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
    }

    /// Pure decision for the self-check: defer to an existing instance only for
    /// a real bundle with another copy already running.
    nonisolated static func shouldDeferToExistingInstance(
        bundleID: String?, otherInstanceCount: Int
    ) -> Bool {
        bundleID != nil && otherInstanceCount > 0
    }
}

/// Owns the model, the windows and the banner wiring, driving the app's
/// lifecycle. They live here (not in the SwiftUI `App`) so the poll loop runs
/// from launch whether or not a window is open.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let model = AppModel()
    private var router: WindowRouter?
    private var alerter: PushAlerter?
    private var hotKey: HotKey?
    private var settingsOpener: SettingsOpener?
    private var mainWindow: MainWindowController?
    private var composeWindow: ComposeWindowController?
    private var onboarding: OnboardingWindowController?
    /// Read from the launch Apple event before it is gone (see
    /// `applicationWillFinishLaunching`).
    private var loginLaunch = false

    /// OAuth deep-link relay: the browser bounces `klorn://oauth-callback?code=…`
    /// back to us; the code goes to the RelayInbox where the sign-in loop
    /// exchanges it for the JWT. Structural defense against active login-CSRF
    /// (security audit 2026-07-20) — the JWT is never parked for polling.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            if let code = AuthFlow.relayCode(from: url) {
                RelayInbox.deposit(code)
            }
        }
    }

    /// A tapped banner lands on the mail it announced (WindowRouter).
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let identifier = response.notification.request.identifier
        // Hop the (main-actor) UI work off, then tell the system we're done.
        // The handler is called here rather than inside the Task because it is
        // not Sendable under every SDK we build against, and it only signals
        // "delivery handled" — opening the window does not need to precede it.
        Task { @MainActor [weak self] in
            self?.router?.handleNotificationTap(identifier: identifier)
        }
        completionHandler()
    }

    /// Banners posted while Klorn is frontmost still show: the main window
    /// may be on another section, and a PUSH is exactly the interrupt the
    /// user asked for.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler:
            @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    /// The launch event is only current here, before didFinishLaunching.
    func applicationWillFinishLaunching(_ notification: Notification) {
        let event = NSAppleEventManager.shared().currentAppleEvent
        loginLaunch = AppRules.isLoginLaunch(
            eventID: event?.eventID,
            propData: event?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(AppRules.activationPolicy)
        // Appearance: system by default, or the Preferences override. Set
        // before any window draws so the first frame is already themed.
        NSApp.appearance = model.settings.appearance.nsAppearance
        model.settings.onAppearanceChanged = { choice in
            NSApp.appearance = choice.nsAppearance
        }
        // Claim notification taps before the first banner can be posted.
        if PushNotifier.isAvailable {
            UNUserNotificationCenter.current().delegate = self
        }
        // Settings scene (M0): one opener for the shell, the in-app
        // Preferences buttons, and anything else outside SwiftUI's own ⌘,.
        let opener = SettingsOpener()
        settingsOpener = opener
        // An import shows its progress in Settings › Accounts (D7).
        model.driveImport.onImportStarted = { [weak opener] in
            UserDefaults.standard.set(SettingsTab.accounts.rawValue, forKey: SettingsTab.storageKey)
            opener?.open()
        }
        let mainWindow = MainWindowController(model: model)
        self.mainWindow = mainWindow
        let router = WindowRouter(model: model, mainWindow: mainWindow)
        router.openSettings = { [weak opener] in opener?.open() }
        mainWindow.actionsProvider = { [weak router] in router?.makeActions() }
        self.router = router
        // Compose window (M5): the model's composer state drives it.
        let composeWindow = ComposeWindowController(model: model)
        model.onComposePresentationChanged = { [weak composeWindow] in composeWindow?.sync() }
        self.composeWindow = composeWindow
        // PUSH mail is announced with macOS banners (founder decision
        // 2026-10-15); a tap routes through `router`.
        let alerter = PushAlerter(model: model)
        self.alerter = alerter
        model.onNewPush = { [weak alerter] items in alerter?.handleNewPush(items) }
        // A meeting entering its lead window is a banner too (the floating
        // meeting card was removed, 2026-10-15: no floating Klorn surfaces).
        model.onMeetingSoon = { [weak alerter] event in alerter?.handleMeetingSoon(event) ?? false }
        // Sign-out (or another account signing in): the banners still show
        // the account that left. Take them down with the session.
        model.onSessionEnded = { [weak model] in
            model?.pushNotifier.clearAll()
        }
        // No account yet: the onboarding window. Signing in there continues
        // into the main window.
        let onboarding = OnboardingWindowController(model: model) { [weak router] in
            router?.openMainWindow()
        }
        self.onboarding = onboarding
        router.onboarding = onboarding
        router.launch(loginLaunch: loginLaunch)

        // Global shortcut (default ⌥⌘K, user-configurable in Settings): raise
        // and focus the main window; when it is already frontmost, hide Klorn.
        let key = HotKey(onFire: { [weak router] in router?.handleHotKey() })
        key.register(model.settings.shortcut)
        hotKey = key
        // Re-register live when the user records a new shortcut.
        model.settings.onShortcutChanged = { [weak key] shortcut in key?.register(shortcut) }
        // Suspend the hotkey while the recorder captures, so re-recording the
        // currently-bound chord reaches the recorder instead of firing.
        model.settings.onShortcutRecordingChanged = { [weak key, weak self] recording in
            guard let key else { return }
            if recording {
                key.unregister()
            } else if let self {
                key.register(self.model.settings.shortcut)
            }
        }

        model.start()
    }

    /// Remembered so a launch at login can bring the window back (AppRules).
    func applicationWillTerminate(_ notification: Notification) {
        model.settings.mainWindowOpenAtQuit = model.mainWindowOpen
    }

    /// App-menu dispatch (M1). Every case is an existing action; commands
    /// that need the main window open it first.
    func perform(_ command: MenuCommand) {
        switch command {
        case .compose:
            // The composer is its own window (M5) and needs no full view
            // under it; ⌘N on an open composer brings it forward.
            model.showCompose = true
        case .find:
            ensureMainWindow()
            if !model.listMode.hasSearchField { model.go(to: .inbox) }
            // The search field lives in Mail; the main window may be elsewhere.
            model.navigate(to: .mail)
            model.searchFocusPending = true
        case .go(let mode):
            ensureMainWindow()
            model.go(to: mode)
        case .section(let section):
            ensureMainWindow()
            model.navigate(to: section)
        case .reply:
            model.requestReply()
        case .dismiss:
            guard let item = model.menuTargetItem else { return }
            Task { await model.dismiss(item) }
        case .moveTo(let tier):
            guard let item = model.menuTargetItem else { return }
            Task { await model.setTier(item, to: tier) }
        case .importToDrive:
            // The open panel first; nothing is read unless the user picks something.
            Task { await model.driveImport.chooseAndImport() }
        }
    }

    /// Open the main window only if it isn't already up.
    private func ensureMainWindow() {
        if !model.isFullViewOpen { router?.openMainWindow() }
    }

    /// Closing the main window must never quit Klorn: the poll loop and the
    /// banners are the app, the window is only a view of it. Explicit so it
    /// never depends on SwiftUI's scene-derived default.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        AppRules.terminatesAfterLastWindowClosed
    }

    /// Dock click, or Finder/Dock re-open of a running Klorn (LaunchServices
    /// sends reopen instead of spawning a second process): show the window.
    func applicationShouldHandleReopen(
        _ sender: NSApplication, hasVisibleWindows flag: Bool
    ) -> Bool {
        router?.reopen()
        return false
    }
}

/// SwiftUI owns the Settings window (M0) and the app menus (M1). The main
/// window is AppKit (`MainWindowController`), not a scene.
struct KlornApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            SettingsRoot().environment(appDelegate.model)
        }
        .commands {
            KlornCommands(model: appDelegate.model) { [appDelegate] command in
                appDelegate.perform(command)
            }
        }
    }
}
