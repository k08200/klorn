import AppKit
import Foundation
import SwiftUI

/// Entry point. `--self-check` runs the verification harness and exits (so tests
/// work on a Command Line Tools toolchain with no XCTest); otherwise the app
/// launches as a menu-bar-less accessory whose only chrome is the custom top bar.
@main
enum Entry {
    static func main() {
        if CommandLine.arguments.contains("--self-check") {
            exit(runSelfChecksBlocking() ? 0 : 1)
        }
        // Ambient firewall: no Dock icon, no system menu bar, and never steal focus
        // from whatever the user is working in. `.accessory` gives a chrome-less
        // process; the custom top bar (an NSPanel) is the app's entire surface.
        NSApplication.shared.setActivationPolicy(.accessory)
        KlornApp.main()
    }
}

/// Owns the model and the top bar, driving the headless lifecycle. Both live here
/// (not in the SwiftUI `App`) so the poll loop and the bar exist on launch with no
/// window and no system-menu-bar item.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()
    private var topBar: TopBarController?
    private var pushCard: PushCardController?
    private var meetingCard: MeetingCardController?
    private var statusItem: StatusItemController?
    private var hotKey: HotKey?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Reassert accessory policy post-launch; do NOT activate or foreground.
        NSApp.setActivationPolicy(.accessory)
        let bar = TopBarController(model: model)
        let card = PushCardController(model: model)
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

        // ⌥⌘K from anywhere: while a card is up it arms/releases the card's
        // keyboard (1/2/3/⏎/esc); otherwise it expands/collapses the bar.
        // No focus steal, no permission either way.
        let key = HotKey(onFire: { [weak bar, weak card] in
            if card?.isVisible == true { card?.armKeyboard() } else { bar?.toggle() }
        })
        key.register()
        hotKey = key

        model.start()
    }
}

/// The custom top bar (an AppKit NSPanel) is the whole UI, so SwiftUI needs only a
/// placeholder scene. `Settings` is invisible under `.accessory` (no menu to open it).
struct KlornApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings { EmptyView() }
    }
}
