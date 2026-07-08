import AppKit
import Foundation

enum SignInFailure: String, Sendable {
    case nonceFailed, invalidNonce, expired, timeout, cancelled
}

enum SignInResult: Sendable, Equatable {
    case success(token: String)
    case failure(reason: SignInFailure, detail: String)
}

/// One poll outcome from GET /api/auth/desktop-token/:nonce.
enum PollOutcome: Sendable, Equatable {
    case pending
    case ok(token: String)
    case invalidNonce  // 404
    case expired       // 410
    case retry         // transient blip / odd status / non-JSON 2xx
}

/// Injectable dependencies so the flow is unit-testable without a real server,
/// browser, or clock. A faithful port of desktop-login.ts (already unit-tested).
struct AuthFlowDeps: Sendable {
    var fetchNonce: @Sendable () async -> String?
    var openLogin: @Sendable (String) -> Void
    var pollToken: @Sendable (String) async -> PollOutcome
    var sleep: @Sendable () async -> Void
    var now: @Sendable () -> Double
    var isCancelled: @Sendable () -> Bool
}

/// Drives the server browser-bounce + nonce-poll sign-in:
///   1. GET /api/auth/desktop-nonce                      → nonce
///   2. open /api/auth/google/login?source=desktop&nonce= in the OS browser
///      (one consent also grants Gmail/Calendar; the callback parks a JWT)
///   3. poll /api/auth/desktop-token/:nonce              → pending → ok(token)
enum AuthFlow {
    static let pollIntervalSeconds: Double = 3       // 20/min, under the server's 30/min limit
    static let maxWaitSeconds: Double = 10 * 60      // matches the server nonce TTL

    /// Query-value encoding: .urlQueryAllowed minus the sub-delimiters that
    /// would otherwise let a non-hex nonce split the query string.
    private static let nonceAllowed: CharacterSet = {
        var s = CharacterSet.urlQueryAllowed
        s.remove(charactersIn: "&=+?#")
        return s
    }()

    static func run(_ deps: AuthFlowDeps, apiBase: String) async -> SignInResult {
        guard let nonce = await deps.fetchNonce(), !nonce.isEmpty else {
            return .failure(reason: .nonceFailed, detail: "could not obtain a sign-in nonce")
        }
        let encoded = nonce.addingPercentEncoding(withAllowedCharacters: nonceAllowed) ?? nonce
        deps.openLogin("\(apiBase)/api/auth/google/login?source=desktop&nonce=\(encoded)")

        let deadline = deps.now() + maxWaitSeconds
        while deps.now() < deadline {
            if deps.isCancelled() {
                return .failure(reason: .cancelled, detail: "cancelled")
            }
            switch await deps.pollToken(nonce) {
            case .ok(let token):
                return .success(token: token)
            case .invalidNonce:
                return .failure(reason: .invalidNonce, detail: "nonce not recognized (404)")
            case .expired:
                return .failure(reason: .expired, detail: "nonce expired (410)")
            case .pending, .retry:
                if deps.isCancelled() {
                    return .failure(reason: .cancelled, detail: "cancelled")
                }
                await deps.sleep()
            }
        }
        return .failure(reason: .timeout, detail: "no completion within \(Int(maxWaitSeconds))s")
    }
}

/// Real wiring of AuthFlow against the live API + OS browser. Cancellation rides
/// on the enclosing Task (cancel the task to abort sign-in).
enum GoogleSignIn {
    static func run(api: APIClient = APIClient(), apiBase: String = Config.apiBaseURL) async -> SignInResult {
        let deps = AuthFlowDeps(
            fetchNonce: {
                try? await api.get("/api/auth/desktop-nonce", authed: false, as: DesktopNonce.self).nonce
            },
            openLogin: { urlString in
                guard let url = URL(string: urlString) else { return }
                DispatchQueue.main.async { NSWorkspace.shared.open(url) }
            },
            pollToken: { nonce in await poll(api: api, nonce: nonce) },
            sleep: { try? await Task.sleep(for: .seconds(AuthFlow.pollIntervalSeconds)) },
            now: { Date().timeIntervalSinceReferenceDate },
            isCancelled: { Task.isCancelled }
        )
        return await AuthFlow.run(deps, apiBase: apiBase)
    }

    /// One poll. The API client throws on non-2xx, so 404/410 surface as
    /// APIError.http; 200/202 return a body whose `status` distinguishes ok vs
    /// pending. A non-JSON 2xx (proxy page) or transport blip is transient.
    private static func poll(api: APIClient, nonce: String) async -> PollOutcome {
        do {
            let data = try await api.data("/api/auth/desktop-token/\(nonce)", authed: false)
            guard let resp = try? JSONDecoder().decode(DesktopTokenResponse.self, from: data) else {
                return .retry
            }
            if resp.status == "ok", let token = resp.token, !token.isEmpty {
                return .ok(token: token)
            }
            return .pending
        } catch APIError.http(404, _) {
            return .invalidNonce
        } catch APIError.http(410, _) {
            return .expired
        } catch {
            return .retry
        }
    }
}
