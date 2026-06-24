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

    private let api: APIClient

    init(api: APIClient = APIClient()) {
        self.api = api
        self.phase = KeychainStore.load() != nil ? .signedIn : .signedOut
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
        } catch APIError.unauthorized {
            signOut()  // token expired/invalid — drop to sign-in
        } catch {
            loadError = Self.describe(error)
        }
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
