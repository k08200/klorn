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
/// launches as a menu-bar-less accessory whose only chrome is the custom top bar.
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
        // Single instance: an accessory app draws no window on re-launch, so a
        // second copy silently stacks a second top bar (the "two bars" dogfood
        // bug, 2026-07-16). If Klorn is already running, hand focus to it and
        // exit instead of launching a duplicate.
        if let existing = existingInstance() {
            existing.activate()
            return
        }
        // Ambient firewall: no Dock icon, no system menu bar, and never steal focus
        // from whatever the user is working in. `.accessory` gives a chrome-less
        // process; the custom top bar (an NSPanel) is the app's entire surface.
        NSApplication.shared.setActivationPolicy(.accessory)
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

/// Owns the model and the top bar, driving the headless lifecycle. Both live here
/// (not in the SwiftUI `App`) so the poll loop and the bar exist on launch with no
/// window and no system-menu-bar item.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let model = AppModel()
    private var topBar: TopBarController?
    private var pushCard: PushCardController?
    private var meetingCard: MeetingCardController?
    private var statusItem: StatusItemController?
    private var hotKey: HotKey?
    private var settingsOpener: SettingsOpener?
    private var mainWindow: MainWindowController?
    private var composeWindow: ComposeWindowController?
    private var onboarding: OnboardingWindowController?

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

    /// A tapped banner must land on the mail it interrupted you for. Without
    /// this delegate the OS banner was a dead end — it took the interruption
    /// and gave nothing back (dogfood: "the notification does nothing").
    /// Set before any banner can be posted so no tap is dropped.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let identifier = response.notification.request.identifier
        // Hop the (main-actor) UI work off, then tell the system we're done.
        // The handler is called here rather than inside the Task because it is
        // not Sendable under every SDK we build against, and it only signals
        // "delivery handled" — opening the pane does not need to precede it.
        Task { @MainActor [weak self] in
            self?.openFromNotification(identifier: identifier)
        }
        completionHandler()
    }

    /// Banners posted while Klorn is frontmost still show: the app is an
    /// accessory whose window is usually hidden, so suppressing them would
    /// silently drop the interrupt the firewall exists to deliver.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler:
            @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    /// Resolve a banner identifier to its item and open it in the reading pane.
    /// The item may be gone (already handled elsewhere, or the queue refreshed);
    /// in that case fall back to expanding the bar rather than doing nothing, so
    /// a tap always produces a visible response.
    func openFromNotification(identifier: String) {
        // One lookup, reused: `queue` is an immutable Sendable snapshot, so the
        // item found while routing is the item we open.
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
            guard let item = found else {
                topBar?.expand()
                return
            }
            topBar?.openInApp(item)
        case .expand:
            topBar?.expand()
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Reassert accessory policy post-launch; do NOT activate or foreground.
        NSApp.setActivationPolicy(.accessory)
        // Appearance: system by default, or the Preferences override. Set
        // before any panel draws so the first frame is already themed.
        NSApp.appearance = model.settings.appearance.nsAppearance
        model.settings.onAppearanceChanged = { choice in
            NSApp.appearance = choice.nsAppearance
        }
        // Claim notification taps before the first banner can be posted.
        if PushNotifier.isAvailable {
            UNUserNotificationCenter.current().delegate = self
        }
        let bar = TopBarController(model: model)
        let card = PushCardController(model: model)
        // Settings scene (M0): one opener for the status item, the in-app
        // Preferences buttons, and anything else outside SwiftUI's own ⌘,.
        let opener = SettingsOpener()
        bar.onOpenSettings = { [weak opener] in opener?.open() }
        model.onWindowPresenceChanged = { [weak bar] in bar?.refreshActivationPolicy() }
        settingsOpener = opener
        // Main window (M2, behind `macMainWindow`): the bar routes every
        // "open the full view" to it while the flag is on.
        let mainWindow = MainWindowController(model: model)
        mainWindow.actionsProvider = { [weak bar] in bar?.mainWindowActions() }
        self.mainWindow = mainWindow
        bar.onOpenMainWindow = { [weak mainWindow] in mainWindow?.open() }
        bar.onCloseMainWindow = { [weak mainWindow] in mainWindow?.close() }
        // Compose window (M5, same flag): the model's composer state drives it.
        let composeWindow = ComposeWindowController(model: model)
        model.onComposePresentationChanged = { [weak composeWindow] in composeWindow?.sync() }
        self.composeWindow = composeWindow
        // Menu-bar anchor while the pill is hidden (one-anchor rule): appears
        // when the pill's ✕ / Preferences hides the bar, disappears when the
        // bar comes back. Without it a hidden-pill accessory app is invisible
        // AND unkillable from the UI (dogfood feedback 2026-07-16).
        let status = StatusItemController(model: model, topBar: bar)
        status.startSyncing()
        statusItem = status
        // The card is the primary PUSH surface; the OS banner stays as the
        // fallback for when a card can't draw (headless). The VoiceOver
        // announcement in handleNewPush fires either way.
        model.onNewPush = { [weak bar, weak card] items in
            let cardShown = card?.present(items) ?? false
            bar?.handleNewPush(items, bannerFallback: !cardShown)
        }
        card.onShowAll = { [weak bar] in bar?.expand() }
        card.onOpenInApp = { [weak bar] item in bar?.openInApp(item) }
        // Meeting-prep card shares the PushCard's slot; mail interrupts win
        // and the planner re-offers the meeting on the next refresh tick.
        let meetingCard = MeetingCardController(
            model: model, isSlotBusy: { [weak card] in card?.isVisible ?? false })
        model.onMeetingSoon = { [weak meetingCard] event in
            meetingCard?.present(event) ?? false
        }
        self.meetingCard = meetingCard
        bar.show()
        topBar = bar
        pushCard = card
        // First run after install: open the real app window once. The resting
        // pill at the top edge is easy to miss right after a download — people
        // reported not realizing the app had launched (2026-08-05).
        // With no account yet that window is the onboarding window (M6),
        // not a logged-out full view; signing in there continues into the
        // full view, where the existing post-login flow takes over.
        let onboarding = OnboardingWindowController(model: model) { [weak bar] in bar?.openFull() }
        self.onboarding = onboarding
        switch OnboardingRules.launchAction(
            firstLaunch: model.settings.consumeFirstLaunch(), signedIn: model.phase == .signedIn)
        {
        case .onboarding: onboarding.open()
        case .fullView: bar.openFull()
        case .none: break
        }

        // Global toggle shortcut (default ⌥⌘K, user-configurable in Preferences):
        // while a card is up it arms/releases the card's keyboard (1/2/3/⏎/esc);
        // otherwise it expands/collapses the bar. No focus steal, no permission.
        let key = HotKey(onFire: { [weak bar, weak card] in
            if card?.isVisible == true { card?.armKeyboard() } else { bar?.toggle() }
        })
        key.register(model.settings.shortcut)
        hotKey = key
        // Re-register live when the user records a new shortcut.
        model.settings.onShortcutChanged = { [weak key] shortcut in key?.register(shortcut) }
        // Apply show-in-Dock the moment it is flipped, not at the next state change.
        model.settings.onShowInDockChanged = { [weak bar] _ in bar?.refreshActivationPolicy() }
        // Suspend the hotkey while the recorder captures, so re-recording the
        // currently-bound chord reaches the recorder instead of toggling the bar.
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

    /// App-menu dispatch (M1). Every case is an existing action; commands
    /// that need the full view open it first (menus also show with the bar
    /// collapsed when show-in-Dock or Settings keeps the app .regular).
    func perform(_ command: MenuCommand) {
        switch command {
        case .compose:
            // With its own window (M5) the composer needs no full view
            // under it; ⌘N on an open composer brings it forward.
            if !ComposeWindowRules.usesWindow(macMainWindow: model.settings.macMainWindow) {
                ensureFullView()
            }
            model.showCompose = true
        case .find:
            ensureFullView()
            if !model.listMode.hasSearchField { model.go(to: .inbox) }
            // The search field lives in Mail; the main window may be elsewhere.
            if model.settings.macMainWindow { model.navigate(to: .mail) }
            model.searchFocusPending = true
        case .go(let mode):
            ensureFullView()
            model.go(to: mode)
        case .section(let section):
            ensureFullView()
            model.navigate(to: section)
        case .reply:
            model.requestReply()
        case .dismiss:
            guard let item = model.menuTargetItem else { return }
            Task { await model.dismiss(item) }
        case .moveTo(let tier):
            guard let item = model.menuTargetItem else { return }
            Task { await model.setTier(item, to: tier) }
        }
    }

    /// Open the full view only if it isn't already up: a same-state render
    /// rebuilds the hosting view, which would reset in-progress UI state.
    private func ensureFullView() {
        if !model.isFullViewOpen { topBar?.openFull() }
    }

    /// Closing the main window must never quit Klorn: the bar and the poll
    /// loop are the app, the window is only a view of it. Explicit so it
    /// never depends on SwiftUI's scene-derived default.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// Finder/Dock re-open of a running Klorn (LaunchServices sends reopen
    /// instead of spawning a second process): show the app window. Without
    /// this, double-clicking Klorn.app again appears to do nothing — the
    /// accessory pill gives no visible response.
    func applicationShouldHandleReopen(
        _ sender: NSApplication, hasVisibleWindows flag: Bool
    ) -> Bool {
        topBar?.openFull()
        return false
    }
}

/// The custom top bar (an AppKit NSPanel) is the main UI. SwiftUI owns the
/// Settings window (M0) and the app menus (M1); both surface only while the
/// app is `.regular`, i.e. while one of its windows is summoned. The M2 main
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
