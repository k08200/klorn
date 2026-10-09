import AppKit
import Foundation
import SwiftUI

// Self-check for the not-ready states and the first launch (M6), run by
// `KlornMac --self-check`. Pure rules first, then the model on an in-memory
// store, then source pins.

/// Every M6 check, as (name, passed).
@MainActor
func stateSelfChecks(sourceDir: URL) -> [(String, Bool)] {
    var results: [(String, Bool)] = []
    func check(_ name: String, _ passed: Bool) { results.append((name, passed)) }
    let bools = [false, true]
    let phases: [AppModel.Phase] = [.signedOut, .signingIn, .signedIn]
    func state(_ phase: AppModel.Phase, queue: Bool, error: String?, offline: Bool) -> SurfaceState {
        SurfaceStateRules.state(phase: phase, hasQueue: queue, loadError: error, offline: offline)
    }

    // MARK: state → view
    check("signed out and signing in are their own states, whatever else is true",
          bools.allSatisfy { queue in
              bools.allSatisfy { offline in
                  [nil, "x"].allSatisfy { error in
                      state(.signedOut, queue: queue, error: error, offline: offline) == .signedOut
                          && state(.signingIn, queue: queue, error: error, offline: offline) == .signingIn
                  }
              }
          })
    check("signed in with nothing loaded: loading, offline or failed with the reason",
          state(.signedIn, queue: false, error: nil, offline: false) == .loading
          && state(.signedIn, queue: false, error: "x", offline: true) == .offline
          && state(.signedIn, queue: false, error: "x", offline: false) == .failed("x"))
    check("loaded mail stays on screen through a failed refresh",
          bools.allSatisfy { state(.signedIn, queue: true, error: "x", offline: $0) == .ready })
    let everyState: [SurfaceState] = [.signedOut, .signingIn, .loading, .offline, .failed("x"), .ready]
    check("the sorting skeleton shows while loading and in no other state",
          everyState.filter(SurfaceStateRules.showsSkeleton) == [.loading])
    check("signed out, signing in, offline and failed replace the content",
          everyState.filter(SurfaceStateRules.isBlocking) == [.signedOut, .signingIn, .offline, .failed("x")])
    check("a state is never both the skeleton and a message",
          everyState.allSatisfy { !(SurfaceStateRules.showsSkeleton($0) && SurfaceStateRules.isBlocking($0)) })
    check("the banner shows only over loaded mail whose refresh failed",
          SurfaceStateRules.notice(phase: .signedIn, hasQueue: true, loadError: "x", offline: true) == .offline
          && SurfaceStateRules.notice(phase: .signedIn, hasQueue: true, loadError: "x", offline: false) == .stale
          && SurfaceStateRules.notice(phase: .signedIn, hasQueue: true, loadError: nil, offline: false) == nil
          && SurfaceStateRules.notice(phase: .signedIn, hasQueue: false, loadError: "x", offline: true) == nil
          && SurfaceStateRules.notice(phase: .signedOut, hasQueue: true, loadError: "x", offline: true) == nil)
    check("the banner and a blocking state never show together",
          phases.allSatisfy { phase in
              bools.allSatisfy { queue in
                  bools.allSatisfy { offline in
                      [nil, "x"].allSatisfy { error in
                          let blocking = SurfaceStateRules.isBlocking(
                              state(phase, queue: queue, error: error, offline: offline))
                          let notice = SurfaceStateRules.notice(
                              phase: phase, hasQueue: queue, loadError: error, offline: offline)
                          return !(blocking && notice != nil)
                      }
                  }
              }
          })
    check("the pill says offline only for the network, and nothing while signed out",
          SurfaceStateRules.pillNotice(phase: .signedIn, loadError: "x", offline: true) == .offline
          && SurfaceStateRules.pillNotice(phase: .signedIn, loadError: "x", offline: false) == .stale
          && SurfaceStateRules.pillNotice(phase: .signedIn, loadError: nil, offline: false) == nil
          && SurfaceStateRules.pillNotice(phase: .signedOut, loadError: "x", offline: true) == nil)
    func kind(_ code: URLError.Code?) -> SurfaceStateRules.FailureKind {
        SurfaceStateRules.failureKind(APIError.transport("x", code: code?.rawValue))
    }
    let offlineCodes: [URLError.Code] = [
        .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .dnsLookupFailed,
        .dataNotAllowed, .internationalRoamingOff,
    ]
    check("offline is exactly the no-network codes",
          offlineCodes.allSatisfy { kind($0) == .offline }
          && SurfaceStateRules.offlineCodes.count == offlineCodes.count)
    let unreachable: [URLError.Code] = [
        .timedOut, .cannotConnectToHost, .secureConnectionFailed, .serverCertificateUntrusted,
        .badServerResponse, .badURL, .unsupportedURL, .cannotParseResponse,
    ]
    check("timeouts, TLS and bad answers are a failure, never 'offline'",
          unreachable.allSatisfy { kind($0) == .failed } && kind(nil) == .failed)
    check("a cancelled request is not an error state", kind(.cancelled) == .ignored)
    check("an answer from the server is a failure, never 'offline'",
          SurfaceStateRules.failureKind(APIError.http(503, nil)) == .failed
          && SurfaceStateRules.failureKind(APIError.decoding("x")) == .failed
          && SurfaceStateRules.failureKind(APIError.forbidden) == .failed
          && !SurfaceStateRules.isOffline(APIError.http(503, nil))
          && SurfaceStateRules.isOffline(APIError.transport("x", code: URLError.Code.notConnectedToInternet.rawValue)))
    check("one retry at a time", SurfaceStateRules.mayRetry(isLoading: false)
          && !SurfaceStateRules.mayRetry(isLoading: true))
    check("Today's rule is the shared rule",
          TodayRules.state(phase: .signedIn, hasQueue: false, loadError: "x") == .failed("x")
          && TodayRules.state(phase: .signedIn, hasQueue: false, loadError: "x", offline: true) == .offline)

    // MARK: first launch
    check("first launch with no account opens onboarding, not a logged-out full view",
          OnboardingRules.launchAction(firstLaunch: true, signedIn: false) == .onboarding)
    check("first launch with an account opens the full view, as before",
          OnboardingRules.launchAction(firstLaunch: true, signedIn: true) == .fullView)
    check("later launches open nothing",
          bools.allSatisfy { OnboardingRules.launchAction(firstLaunch: false, signedIn: $0) == .none })
    check("onboarding is done exactly when an account is signed in",
          OnboardingRules.completes(phase: .signedIn) && !OnboardingRules.completes(phase: .signingIn)
          && !OnboardingRules.completes(phase: .signedOut))
    check("onboarding closes on sign-in whenever it is open, visible or not",
          OnboardingRules.closesOnPhase(.signedIn, windowOpen: true)
          && !OnboardingRules.closesOnPhase(.signedIn, windowOpen: false)
          && !OnboardingRules.closesOnPhase(.signingIn, windowOpen: true)
          && !OnboardingRules.closesOnPhase(.signedOut, windowOpen: true))
    check("a Dock click during onboarding focuses onboarding, not a signed-out full view",
          OnboardingRules.reopenTarget(onboardingOpen: true) == .onboarding
          && OnboardingRules.reopenTarget(onboardingOpen: false) == .fullView)
    check("the explainer lists the five live lanes and no retired one",
          OnboardingRules.lanes.map(\.rawValue) == ["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"])
    check("every lane has its own line in the explainer",
          Set(OnboardingRules.lanes.map(\.onboardingLine)).count == OnboardingRules.lanes.count
          && OnboardingRules.lanes.allSatisfy { !$0.onboardingLine.hasPrefix("onboarding.") })
    check("an open onboarding window makes the app regular; closed is the pre-M6 rule",
          TopBarController.activationPolicy(for: .collapsed, onboardingOpen: true) == .regular
          && [BarState.collapsed, .expanded, .full].allSatisfy { state in
              bools.allSatisfy { dock in
                  bools.allSatisfy { main in
                      bools.allSatisfy { compose in
                          TopBarController.activationPolicy(
                              for: state, showInDock: dock, mainWindowOpen: main,
                              composeWindowOpen: compose, onboardingOpen: false)
                              == TopBarController.activationPolicy(
                                  for: state, showInDock: dock, mainWindowOpen: main,
                                  composeWindowOpen: compose)
                      }
                  }
              }
          })

    // MARK: strings
    check("new integer formats render",
          L("onboarding.value", 5).contains("5") && !L("onboarding.value", 5).contains("%")
          && L("error.server", 503).contains("503") && !L("error.server", 503).contains("%"))
    check("new string formats render",
          L("bar.retry.a11y", "x").contains("x") && !L("bar.retry.a11y", "x").contains("%"))

    // MARK: model (in-memory store)
    let model = AppModel(tokenStore: InMemoryTokenStore())
    check("a model with no token is signed out, with no banner",
          model.surfaceState == .signedOut && model.connectionNotice == nil && model.pillNotice == nil)
    model.seedStateForRender(phase: .signedIn, loadError: "x", offline: true)
    let offline = model.surfaceState
    model.seedStateForRender(phase: .signedIn, loadError: nil, offline: true)
    check("offline never outlives the error it describes",
          offline == .offline && model.surfaceState == .loading && !model.loadOffline)
    // Sign-out: nothing of the previous account may be painted again.
    let leaving = AppModel(tokenStore: InMemoryTokenStore())
    leaving.seedForPreview(
        firewallJSON: #"{"tiers":{"PUSH":[],"MEETING":[],"QUEUE":[],"INFO":[],"SILENT":[],"AUTO":[]},"summary":{"PUSH":0,"MEETING":0,"QUEUE":0,"INFO":0,"SILENT":0,"AUTO":0,"total":0}}"#, emailJSON: "", selectedItemId: nil)
    let cachedBefore = !leaving.queueCacheIsEmpty
    leaving.showActionError("x")
    leaving.signOut()
    check("sign-out clears the per-inbox queue snapshots",
          cachedBefore && leaving.queueCacheIsEmpty && leaving.queue == nil)
    check("sign-out clears a pending action error", leaving.actionError == nil)
    model.showActionError("pin failed")
    check("a failed action is its own notice: no banner, no pill chip, no offline state",
          model.actionError == "pin failed" && model.loadError == nil && !model.loadOffline
          && model.connectionNotice == nil && model.pillNotice == nil)
    model.dismissActionError()
    check("an action error can be dismissed", model.actionError == nil)
    check("restarting sign-in defaults to Google until a provider was chosen", model.signInProvider == "google")
    // Sign-in error ink: the PUSH lane red on the canvas, both modes.
    func luminance(_ c: (r: Double, g: Double, b: Double, a: Double)) -> Double {
        func channel(_ v: Double) -> Double { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
    }
    func ratio(_ a: (r: Double, g: Double, b: Double, a: Double), _ b: (r: Double, g: Double, b: Double, a: Double)) -> Double {
        let (hi, lo) = (max(luminance(a), luminance(b)), min(luminance(a), luminance(b)))
        return (hi + 0.05) / (lo + 0.05)
    }
    check("the sign-in error ink clears 4.5:1 on the canvas in light and dark",
          ratio(Theme.laneComponents(.push, dark: false), Theme.bgLight) >= 4.5
          && ratio(Theme.laneComponents(.push, dark: true), Theme.bgDark) >= 4.5)
    var presence = 0
    model.onWindowPresenceChanged = { presence += 1 }
    model.onboardingWindowOpen = true
    model.onboardingWindowOpen = false
    check("the onboarding window opening and closing re-applies the activation policy", presence == 2)

    // MARK: source pins
    let files = swiftSources(under: sourceDir)
    func text(_ name: String) -> String {
        files.first { $0.lastPathComponent == name }
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }
    func users(of needle: String) -> [String] {
        files.map(\.lastPathComponent)
            .filter { !$0.hasPrefix("SelfCheck") && text($0).contains(needle) }.sorted()
    }
    let blockingGuard = "SurfaceStateRules.isBlocking(model.surfaceState)"
    check("every surface that draws the skeleton for a missing queue checks the state first",
          ["FullView.swift", "ExpandedDashboard.swift", "MailSection.swift"]
              .allSatisfy { text($0).contains(blockingGuard) }
          && text("TodayScreen.swift").contains("case .signedOut, .signingIn, .offline, .failed:"))
    check("the skeleton has only its known call sites",
          users(of: "FirstSync" + "State()") == [
              "ExpandedDashboard.swift", "FullList.swift", "MailboxList.swift", "TodayScreen.swift",
          ])
    check("the pill's chip is labelled by the rule, never a fixed 'offline'",
          !text("CollapsedPill.swift").contains("L(\"bar.offline\")")
          && text("CollapsedPill.swift").contains("model.pillNotice"))
    check("load failures are recorded with their kind, in one place",
          text("AppModel.swift").components(separatedBy: "loadError = Self.describe(error)").count == 2
          && text("AppModel.swift").contains("loadOffline = kind == .offline"))
    // Only a refresh may raise the "couldn't refresh" banner and the pill
    // chip; pin, unpin, dismiss and snooze failures go to the action notice.
    check("only the queue refresh records a load failure; actions have their own channel",
          text("AppModel.swift").components(separatedBy: "            noteLoadFailure(error)\n").count == 2
          && text("AppModel.swift").components(separatedBy: "noteActionFailure(error)\n").count == 4)
    check("every retry control goes through the guarded retry",
          users(of: "await model.retry" + "Load()") == ["CollapsedPill.swift", "SurfaceState.swift"]
          && text("CollapsedPill.swift")
              .contains(".disabled(!SurfaceStateRules.mayRetry(isLoading: model.isLoadingQueue))")
          && !text("SurfaceState.swift").contains("await model.loadQueue()"))
    check("restarting sign-in keeps the provider the user chose",
          users(of: "await model.restart" + "SignIn()") == ["OnboardingView.swift", "SurfaceState.swift"]
          && text("AppModel.swift").contains("signInProvider = provider\n        signInTask?.cancel()"))
    check("the API client carries the URLError code on every transport failure",
          text("APIClient.swift").components(separatedBy: "code: (error as? URLError)?.code.rawValue").count == 4)
    check("the sign-in error is not system orange",
          !text("SurfaceState.swift").contains(".orange") && !text("OnboardingView.swift").contains(".orange"))
    let onboardingFiles = ["OnboardingWindow.swift", "OnboardingView.swift", "SurfaceState.swift"]
    check("onboarding adds no auth code: sign-in is the model's existing entry point",
          onboardingFiles.allSatisfy { name in
              let source = text(name)
              return !source.contains("GoogleSignIn") && !source.contains("api.")
                  && !source.contains("tokenStore") && !source.contains("URLSession")
          }
          && text("SurfaceState.swift").contains("await model.signIn(provider: provider)"))
    check("first launch goes through the rule, and nothing else is gated on it",
          text("KlornApp.swift").contains("switch OnboardingRules.launchAction(")
          && users(of: "consumeFirst" + "Launch()") == ["KlornApp.swift", "Settings.swift"]
          && users(of: "OnboardingWindow" + "Controller(model:") == ["KlornApp.swift"])
    let m6Files = onboardingFiles + ["PreviewRenderStates.swift", "MainShell.swift", "TodayScreen.swift"]
    check("every M6 file exists and stays under 400 lines",
          m6Files.allSatisfy { name in
              let lines = text(name).split(separator: "\n", omittingEmptySubsequences: false).count
              return lines > 1 && lines <= 400
          })
    return results
}
