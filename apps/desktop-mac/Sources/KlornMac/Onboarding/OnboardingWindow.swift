import AppKit
import SwiftUI

/// Pure rules for the first launch (productization plan §3, macOS M6),
/// pinned by the self-check.
enum OnboardingRules {
    static let size = NSSize(width: 460, height: 600)
    /// Fixed size: the content is one column that fits, so there is
    /// nothing to resize into.
    static let styleMask: NSWindow.StyleMask = [.titled, .closable]

    /// What the first launch after install opens. Later launches open
    /// nothing: the pill is the resting surface.
    enum LaunchAction: Equatable { case onboarding, fullView, none }

    /// No account yet: the onboarding window, not a logged-out full view.
    /// Already signed in (a restored token): the full view, as before.
    /// The same for both values of `macMainWindow`.
    static func launchAction(firstLaunch: Bool, signedIn: Bool) -> LaunchAction {
        guard firstLaunch else { return .none }
        return signedIn ? .fullView : .onboarding
    }

    /// The window has done its job the moment an account is signed in.
    static func completes(phase: AppModel.Phase) -> Bool {
        phase == .signedIn
    }

    /// The lanes the explainer lists: all five live ones, loudest first.
    static var lanes: [Tier] { Tier.coreOrder }
}

/// The onboarding window's content, telling the controller when sign-in
/// lands.
struct OnboardingRoot: View {
    let model: AppModel
    let onPhaseChange: () -> Void

    var body: some View {
        OnboardingView()
            .environment(model)
            // L() is not observable; rebuild on a language change.
            .id(model.settings.languageRevision)
            .onChange(of: model.phase) { _, _ in onPhaseChange() }
    }
}

/// Owns the first-launch window: a small fixed AppKit NSWindow, created
/// only when the first launch finds no account. Sign-in goes through the
/// existing entry points; when it lands the window closes and hands over to
/// the existing post-login flow (`onSignedIn`).
@MainActor
final class OnboardingWindowController: NSObject, NSWindowDelegate {
    private let model: AppModel
    private let onSignedIn: () -> Void
    private(set) var window: NSWindow?

    init(model: AppModel, onSignedIn: @escaping () -> Void) {
        self.model = model
        self.onSignedIn = onSignedIn
    }

    func open() {
        let window = self.window ?? makeWindow()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        model.onboardingWindowOpen = true
    }

    private func makeWindow() -> NSWindow {
        let host = NSHostingController(
            rootView: OnboardingRoot(model: model) { [weak self] in self?.phaseChanged() })
        // The window owns its frame (clipping lessons, 2026-08-19).
        host.sizingOptions = []
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: OnboardingRules.size),
            styleMask: OnboardingRules.styleMask, backing: .buffered, defer: false)
        window.contentViewController = host
        window.title = L("onboarding.windowTitle")
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.tabbingMode = .disallowed
        window.delegate = self
        window.setContentSize(OnboardingRules.size)
        window.center()
        self.window = window
        return window
    }

    private func phaseChanged() {
        guard OnboardingRules.completes(phase: model.phase), window?.isVisible == true else { return }
        window?.close()
        onSignedIn()
    }

    func windowWillClose(_ notification: Notification) {
        model.onboardingWindowOpen = false
    }
}
