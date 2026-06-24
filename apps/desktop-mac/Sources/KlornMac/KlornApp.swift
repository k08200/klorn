import AppKit
import Foundation
import SwiftUI

/// Entry point. `--self-check` runs the verification harness and exits (so tests
/// work on a Command Line Tools toolchain with no XCTest); otherwise the app
/// launches normally.
@main
enum Entry {
    static func main() {
        if CommandLine.arguments.contains("--self-check") {
            exit(runSelfChecksBlocking() ? 0 : 1)
        }
        // An unbundled `swift run` executable launches as a background process
        // (no Info.plist) — promote it to a regular foreground app so the window
        // actually appears and takes focus. A signed `.app` gets this for free.
        NSApplication.shared.setActivationPolicy(.regular)
        KlornApp.main()
    }
}

/// Brings the window forward on launch — needed for the unbundled dev run, where
/// the window server won't auto-foreground a policy-promoted process.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        NSApp.windows.first?.makeKeyAndOrderFront(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool {
        true
    }
}

/// The SwiftUI app: a main window for the decision queue plus a menu-bar
/// surface — the firewall belongs in the menu bar, always present, surfacing
/// the counts at a glance.
struct KlornApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup("Klorn") {
            RootView()
                .environment(model)
                .frame(minWidth: 720, minHeight: 480)
        }
        .defaultSize(width: 1040, height: 720)

        MenuBarExtra("Klorn", systemImage: "shield.lefthalf.filled") {
            MenuBarContent()
                .environment(model)
        }
        .menuBarExtraStyle(.menu)
    }
}

/// Menu-bar dropdown: live tier counts + quick actions.
struct MenuBarContent: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let s = model.queue?.summary {
            Text("PUSH \(s.push)  ·  QUEUE \(s.queue)  ·  SILENT \(s.silent)")
            Divider()
        } else {
            Text("Klorn — not signed in")
            Divider()
        }
        Button("Refresh") { Task { await model.loadQueue() } }
            .disabled(model.phase != .signedIn)
        Divider()
        Button("Quit Klorn") { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
    }
}
