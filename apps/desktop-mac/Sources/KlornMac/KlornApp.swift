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
        KlornApp.main()
    }
}

/// The SwiftUI app: a main window for the decision queue plus a menu-bar
/// surface — the firewall belongs in the menu bar, always present, surfacing
/// the counts at a glance.
struct KlornApp: App {
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
