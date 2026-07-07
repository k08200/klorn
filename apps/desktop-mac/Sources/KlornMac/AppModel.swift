import Foundation
import Observation

/// App-wide state. @MainActor + @Observable: all UI reads/writes happen on the
/// main actor, and SwiftUI views observe changes automatically.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case signedOut
        case signingIn
        case signedIn
    }

    private(set) var phase: Phase
    var signInError: String?
    private(set) var queue: FirewallResponse?
    private(set) var loadError: String?
    private(set) var isLoadingQueue = false

    /// Called with newly-arrived PUSH items (never the first-load baseline).
    /// The AppDelegate wires this to the HUD; if unset, PUSH surfacing is a no-op.
    var onNewPush: (([FirewallItem]) -> Void)?

    /// Refresh cadence so new PUSH mail surfaces a notification even with the
    /// window closed (also keeps the free-tier API warm).
    static let pollIntervalSeconds: Double = 60
    private var seenPush: Set<String> = []
    private var baselineEstablished = false
    private var didRequestNotifyAuth = false
    private var pollTask: Task<Void, Never>?
    private var realtime: RealtimeClient?

    private let api: APIClient

    init(api: APIClient = APIClient()) {
        self.api = api
        self.phase = KeychainStore.load() != nil ? .signedIn : .signedOut
    }

    /// Kick off the headless lifecycle at app launch. With no window driving it,
    /// this is what starts the background poll loop when we already hold a token.
    /// `loadQueue()` -> `ensureActive()` establishes the silent PUSH baseline and
    /// starts polling; idempotent, so calling it once on launch is enough.
    func start() {
        guard phase == .signedIn else { return }
        Task { await loadQueue() }
    }

    func signIn() async {
        phase = .signingIn
        signInError = nil
        switch await GoogleSignIn.run(api: api) {
        case .success(let token):
            if !KeychainStore.save(token) {
                Log.app.warning("Keychain save denied (unsigned dev build?) — token kept in memory for this session only")
            }
            phase = .signedIn
            await loadQueue()
        case .failure(let reason, let detail):
            Log.app.error("sign-in failed: \(reason.rawValue, privacy: .public) \(detail, privacy: .private)")
            if reason != .cancelled { signInError = Self.message(reason) }
            phase = .signedOut
        }
    }

    func signOut() {
        stopPolling()
        realtime?.stop()
        realtime = nil
        seenPush = []
        baselineEstablished = false
        didRequestNotifyAuth = false
        KeychainStore.clear()
        queue = nil
        loadError = nil
        phase = .signedOut
    }

    func loadQueue() async {
        isLoadingQueue = true
        defer { isLoadingQueue = false }
        do {
            queue = try await api.get("/api/inbox/firewall", as: FirewallResponse.self)
            loadError = nil
            reconcilePush()
            ensureActive()
        } catch APIError.unauthorized {
            signOut()  // token expired/invalid — drop to sign-in
        } catch {
            loadError = Self.describe(error)
        }
    }

    /// Surface PUSH items new since the last load (the first load is a silent
    /// baseline). Routed to `onNewPush` (the HUD); the HUD falls back to an OS
    /// banner when it can't draw a panel.
    private func reconcilePush() {
        guard let queue else { return }
        let plan = planPushNotifications(
            seen: seenPush,
            baselineEstablished: baselineEstablished,
            pushItems: queue.items(for: .push))
        if !plan.toNotify.isEmpty { onNewPush?(plan.toNotify) }
        seenPush = plan.seen
        baselineEstablished = true
    }

    /// Once signed in: request notification permission (once) and start the
    /// background refresh loop. Idempotent.
    private func ensureActive() {
        guard phase == .signedIn else { return }
        if !didRequestNotifyAuth {
            didRequestNotifyAuth = true
            Task { await PushNotifier.requestAuthorization() }
        }
        if pollTask == nil { startPolling() }
        startRealtime()
    }

    /// Open the WebSocket wake channel once signed in. On a server push it
    /// refetches immediately; the poll loop remains the backstop. Idempotent.
    private func startRealtime() {
        guard realtime == nil, let token = KeychainStore.load() else { return }
        let client = RealtimeClient(onWake: { [weak self] in
            // Skip if a load is already in flight — avoids overlapping refetches
            // if the server bursts events.
            guard let self, !self.isLoadingQueue else { return }
            Task { await self.loadQueue() }
        })
        client.start(token: token)
        realtime = client
    }

    private func startPolling() {
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(AppModel.pollIntervalSeconds))
                if Task.isCancelled { break }
                await self?.loadQueue()
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private static func message(_ reason: SignInFailure) -> String {
        switch reason {
        case .nonceFailed: "Couldn't reach Klorn to start sign-in. Check the API and try again."
        case .invalidNonce: "The sign-in session wasn't recognized. Please try again."
        case .expired: "Sign-in took too long and expired. Please try again."
        case .timeout: "Timed out waiting for the browser. Finish sign-in there, then retry."
        case .cancelled: "Sign-in was cancelled."
        }
    }

    /// User-facing message only — the raw error (which can echo response bytes
    /// or internal shape) is logged privately, never surfaced.
    private static func describe(_ error: Error) -> String {
        Log.app.error("queue load failed: \(String(describing: error), privacy: .private)")
        switch error {
        case APIError.http(let code): return "Server error (\(code))."
        case APIError.transport: return "Network error — check your connection."
        case APIError.decoding: return "Unexpected response from the server."
        case APIError.unauthorized: return "Session expired. Please sign in again."
        default: return "Something went wrong."
        }
    }
}
