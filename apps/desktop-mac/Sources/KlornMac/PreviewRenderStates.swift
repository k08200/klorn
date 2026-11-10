import AppKit
import SwiftUI

// Offscreen shots of the states that are not "ready" (M6), part of
// `--render-previews`: signed out, signing in, offline and failed on the
// bar's surfaces, and the first-launch onboarding window. The main window's
// versions of the same states are shot in `renderMainWindow`.

extension PreviewRender {
    /// A load that timed out, in the words the app really shows for it.
    static var timeoutError: String {
        AppModel.describe(APIError.transport("timed out", code: URLError.Code.timedOut.rawValue))
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

    static func renderStates(dir: URL, dark: Bool, actions: ShellActions, firewallJSON: String) -> Bool {
        var ok = true
        func shot(
            _ name: String, size: CGSize, align: Alignment = .center, _ model: AppModel,
            @ViewBuilder _ content: () -> some View
        ) {
            ok = writeShot(name, size: size, align: align, model: model, dir: dir, dark: dark, content) && ok
        }
        let everyProvider = ["google", "apple", "naver"]

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
             stateModel(phase: .signedOut, loginProviders: everyProvider, signInError: AppModel.message(.timeout))) {
            OnboardingView()
        }
        return ok
    }
}
