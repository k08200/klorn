import AppKit
import Foundation
import SwiftUI

/// Entry point. `--self-check` runs the verification harness and exits (so tests
/// work on a Command Line Tools toolchain with no XCTest); otherwise the app
/// launches as a menu-bar-only accessory.
@main
enum Entry {
    static func main() {
        if CommandLine.arguments.contains("--self-check") {
            exit(runSelfChecksBlocking() ? 0 : 1)
        }
        // Ambient firewall: live in the menu bar, never in the Dock, and never
        // steal focus from whatever the user is working in. `.accessory` gives
        // us a menu-bar presence with no Dock icon and no forced foregrounding.
        NSApplication.shared.setActivationPolicy(.accessory)
        KlornApp.main()
    }
}

/// Owns the app-wide model and drives the headless lifecycle. The model lives
/// here (not in the SwiftUI `App` struct) so the poll loop runs on launch even
/// though there is no window — a menu-bar app whose menu may never be opened.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Reassert accessory policy post-launch; do NOT activate or foreground —
        // surfacing PUSH must never pull the user out of their current app.
        NSApp.setActivationPolicy(.accessory)
        model.start()
    }
}

/// The SwiftUI app: a single menu-bar surface, no window. The firewall belongs
/// in the menu bar — always present, surfacing counts at a glance, and (from
/// Phase 1) a non-focus-stealing HUD panel for incoming PUSH.
struct KlornApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra("Klorn", systemImage: "shield.lefthalf.filled") {
            MenuBarContent()
                .environment(appDelegate.model)
        }
        .menuBarExtraStyle(.menu)
    }
}

/// Menu-bar dropdown: sign-in state, live tier counts, and quick actions.
struct MenuBarContent: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.phase {
        case .signedIn:
            if let s = model.queue?.summary {
                Text("PUSH \(s.push)  ·  QUEUE \(s.queue)  ·  SILENT \(s.silent)")
            } else if model.loadError != nil {
                Text("Klorn — can't reach the server")
            } else {
                Text("Klorn — syncing…")
            }
            Divider()
            Button("Refresh") { Task { await model.loadQueue() } }
            Button("Sign Out") { model.signOut() }
        case .signingIn:
            Text("Signing in — finish in your browser…")
        case .signedOut:
            Text("Klorn — not signed in")
            if let err = model.signInError {
                Text(err).foregroundStyle(.secondary)
            }
            Divider()
            Button("Sign In with Google") { Task { await model.signIn() } }
        }
        Divider()
        Button("Quit Klorn") { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
    }
}
