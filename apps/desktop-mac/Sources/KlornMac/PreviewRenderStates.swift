import AppKit
import SwiftUI

// Offscreen shots of the states that are not "ready" (M6), part of
// `--render-previews`: signed out, signing in, offline and failed on the
// bar's surfaces, and the first-launch onboarding window. The main window's
// versions of the same states are shot in `renderMainWindow`.

extension PreviewRender {
    private static let stateErrorJSON = """
    ["The server did not respond (timed out after 30 s).", "Sign-in timed out. Please try again."]
    """

    private static func stateStrings() -> [String] {
        (try? JSONDecoder().decode([String].self, from: Data(stateErrorJSON.utf8))) ?? ["", ""]
    }

    /// A model in one state, on the in-memory token store (see `run`).
    static func stateModel(
        phase: AppModel.Phase, firewallJSON: String? = nil, loadError: String? = nil,
        offline: Bool = false, loginProviders: [String]? = nil, signInError: String? = nil
    ) -> AppModel {
        let model = AppModel(tokenStore: InMemoryTokenStore())
        if let firewallJSON {
            model.seedForPreview(firewallJSON: firewallJSON, emailJSON: "", selectedItemId: nil)
        }
        model.seedStateForRender(
            phase: phase, loadError: loadError, offline: offline,
            loginProviders: loginProviders, signInError: signInError)
        return model
    }

    static func renderStates(dir: URL, dark: Bool, actions: TopBarActions, firewallJSON: String) -> Bool {
        var ok = true
        func shot(
            _ name: String, size: CGSize, align: Alignment = .center, _ model: AppModel,
            @ViewBuilder _ content: () -> some View
        ) {
            ok = writeShot(name, size: size, align: align, model: model, dir: dir, dark: dark, content) && ok
        }
        let strings = stateStrings()
        let network = L("error.network")
        let everyProvider = ["google", "apple", "naver"]

        // The bar's full view: the surface everyone has while `macMainWindow`
        // is off.
        let full = TopBarMetrics.size(for: .full)
        let barStates: [(String, AppModel)] = [
            ("full-signed-out", stateModel(phase: .signedOut, loginProviders: everyProvider)),
            ("full-signing-in", stateModel(phase: .signingIn)),
            ("full-offline", stateModel(phase: .signedIn, loadError: network, offline: true)),
            ("full-error", stateModel(phase: .signedIn, loadError: strings[0])),
            // Loaded mail, refresh failing: the banner, the mail still there.
            ("full-stale-offline", stateModel(
                phase: .signedIn, firewallJSON: firewallJSON, loadError: network, offline: true)),
        ]
        for (name, model) in barStates {
            shot(name, size: full, model) { TopBarRoot(state: .full, actions: actions) }
        }

        let expanded = TopBarMetrics.size(for: .expanded)
        shot("expanded-signed-out", size: expanded, stateModel(phase: .signedOut)) {
            TopBarRoot(state: .expanded, actions: actions)
        }
        shot("expanded-offline", size: expanded,
             stateModel(phase: .signedIn, loadError: network, offline: true)) {
            TopBarRoot(state: .expanded, actions: actions)
        }

        let pill = CGSize(
            width: TopBarMetrics.size(for: .collapsed).width + 80,
            height: TopBarMetrics.size(for: .collapsed).height + 40)
        shot("collapsed-offline", size: pill, stateModel(
            phase: .signedIn, firewallJSON: firewallJSON, loadError: network, offline: true)) {
            TopBarRoot(state: .collapsed, actions: actions)
        }
        shot("collapsed-not-updating", size: pill, stateModel(
            phase: .signedIn, firewallJSON: firewallJSON, loadError: strings[0])) {
            TopBarRoot(state: .collapsed, actions: actions)
        }

        // First launch, no account.
        let onboarding = CGSize(width: OnboardingRules.size.width, height: OnboardingRules.size.height)
        shot("onboarding", size: onboarding, align: .top, stateModel(phase: .signedOut)) {
            OnboardingView()
        }
        shot("onboarding-providers", size: onboarding, align: .top,
             stateModel(phase: .signedOut, loginProviders: everyProvider)) {
            OnboardingView()
        }
        shot("onboarding-signing-in", size: onboarding, align: .top, stateModel(phase: .signingIn)) {
            OnboardingView()
        }
        shot("onboarding-sign-in-failed", size: onboarding, align: .top,
             stateModel(phase: .signedOut, loginProviders: everyProvider, signInError: strings[1])) {
            OnboardingView()
        }
        return ok
    }
}
