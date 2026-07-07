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
    private var hotKey: HotKey?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Reassert accessory policy post-launch; do NOT activate or foreground.
        NSApp.setActivationPolicy(.accessory)
        let bar = TopBarController(model: model)
        model.onNewPush = { [weak bar] items in bar?.handleNewPush(items) }
        bar.show()
        topBar = bar

        // ⌥⌘K from anywhere expands/collapses the bar (no focus, no permission).
        let key = HotKey(onFire: { [weak bar] in bar?.toggle() })
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
