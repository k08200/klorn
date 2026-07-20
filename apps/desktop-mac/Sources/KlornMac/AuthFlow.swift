import AppKit
import CryptoKit
import Foundation
import os

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

/// PKCE pair for the desktop login (security audit 2026-07-20: the server has
/// supported challenge/verifier since the relay work, but this client never
/// sent one — so the server's "legacy caller" branch skipped the gate).
struct PKCE: Sendable {
    let verifier: String   // base64url(32 random bytes), kept local
    let challenge: String  // base64url(SHA-256(verifier)), sent at nonce mint

    static func generate() -> PKCE {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let verifier = Data(bytes).base64URLEncoded()
        return PKCE(verifier: verifier, challenge: Self.challenge(for: verifier))
    }

    /// base64url(SHA-256(verifier)) — must match the server's
    /// `createHash("sha256").update(verifier).digest("base64url")`.
    static func challenge(for verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded()
    }
}

extension Data {
    func base64URLEncoded() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// Thread-safe mailbox for the OAuth deep-link relay code. The OS delivers
/// `klorn://oauth-callback?code=…` to the app delegate, which deposits the
/// code here; the sign-in loop takes it and exchanges it for the JWT. The
/// relay defeats ACTIVE login-CSRF (attacker-minted nonce) structurally: the
/// JWT is never parked for polling — it goes to whichever app instance the OS
/// routes the callback to, i.e. this machine.
enum RelayInbox {
    private static let code = OSAllocatedUnfairLock<String?>(initialState: nil)

    static func deposit(_ value: String) { code.withLock { $0 = value } }
    static func take() -> String? { code.withLock { let v = $0; $0 = nil; return v } }
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
    /// Deep-link relay: a parked `klorn://oauth-callback` code, if one arrived.
    var takeRelayCode: @Sendable () -> String? = { nil }
    /// POST /api/auth/exchange-code — one-time 60 s code → JWT.
    var exchangeCode: @Sendable (String) async -> String? = { _ in nil }
}

/// Drives the server browser-bounce sign-in:
///   1. GET /api/auth/desktop-nonce?challenge=   (PKCE)      → nonce
///   2. open /api/auth/google/login?source=desktop&nonce=…&appScheme=klorn
///   3. EITHER the OS routes klorn://oauth-callback?code= back to us (relay,
///      preferred — exchange for the JWT) OR we poll /desktop-token/:nonce
///      with the PKCE verifier header (fallback for browsers that block the
///      custom-scheme bounce).
enum AuthFlow {
    static let pollIntervalSeconds: Double = 3       // 20/min, under the server's 30/min limit
    static let maxWaitSeconds: Double = 10 * 60      // matches the server nonce TTL
    static let appScheme = "klorn"                   // server NATIVE_OAUTH_SCHEMES allowlist

    /// Query-value encoding: .urlQueryAllowed minus the sub-delimiters that
    /// would otherwise let a non-hex nonce split the query string.
    private static let nonceAllowed: CharacterSet = {
        var s = CharacterSet.urlQueryAllowed
        s.remove(charactersIn: "&=+?#")
        return s
    }()

    /// The browser-bounce URL. Pure for testing.
    static func loginURL(apiBase: String, nonce: String) -> String {
        let encoded = nonce.addingPercentEncoding(withAllowedCharacters: nonceAllowed) ?? nonce
        return "\(apiBase)/api/auth/google/login?source=desktop&nonce=\(encoded)&appScheme=\(appScheme)"
    }

    /// Parse a relay deep link (`klorn://oauth-callback?code=…`). Pure for testing.
    static func relayCode(from url: URL) -> String? {
        guard url.scheme?.lowercased() == appScheme,
              url.host?.lowercased() == "oauth-callback",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let code = items.first(where: { $0.name == "code" })?.value,
              !code.isEmpty
        else { return nil }
        return code
    }

    static func run(_ deps: AuthFlowDeps, apiBase: String) async -> SignInResult {
        guard let nonce = await deps.fetchNonce(), !nonce.isEmpty else {
            return .failure(reason: .nonceFailed, detail: "could not obtain a sign-in nonce")
        }
        deps.openLogin(loginURL(apiBase: apiBase, nonce: nonce))

        let deadline = deps.now() + maxWaitSeconds
        while deps.now() < deadline {
            if deps.isCancelled() {
                return .failure(reason: .cancelled, detail: "cancelled")
            }
            // Relay first: the deep link lands out-of-band; exchanging it beats
            // the next poll by up to a full interval. A failed exchange (code
            // already spent / expired) falls back to the poll path.
            if let code = deps.takeRelayCode() {
                if let token = await deps.exchangeCode(code), !token.isEmpty {
                    return .success(token: token)
                }
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
        let pkce = PKCE.generate()
        let deps = AuthFlowDeps(
            fetchNonce: {
                try? await api.get(
                    "/api/auth/desktop-nonce?challenge=\(pkce.challenge)",
                    authed: false, as: DesktopNonce.self
                ).nonce
            },
            openLogin: { urlString in
                guard let url = URL(string: urlString) else { return }
                DispatchQueue.main.async { NSWorkspace.shared.open(url) }
            },
            pollToken: { nonce in await poll(api: api, nonce: nonce, verifier: pkce.verifier) },
            sleep: { try? await Task.sleep(for: .seconds(AuthFlow.pollIntervalSeconds)) },
            now: { Date().timeIntervalSinceReferenceDate },
            isCancelled: { Task.isCancelled },
            takeRelayCode: { RelayInbox.take() },
            exchangeCode: { code in
                // Success body is `{ token }` (no status field).
                struct ExchangeCodeResponse: Codable { let token: String? }
                let resp = try? await api.post(
                    "/api/auth/exchange-code", json: ["code": code],
                    as: ExchangeCodeResponse.self, authed: false)
                return resp?.token
            }
        )
        return await AuthFlow.run(deps, apiBase: apiBase)
    }

    /// One poll. The API client throws on non-2xx, so 404/410 surface as
    /// APIError.http; 200/202 return a body whose `status` distinguishes ok vs
    /// pending. A non-JSON 2xx (proxy page) or transport blip is transient.
    /// The PKCE verifier rides a header (never the URL) per the server contract.
    private static func poll(api: APIClient, nonce: String, verifier: String) async -> PollOutcome {
        do {
            let data = try await api.data(
                "/api/auth/desktop-token/\(nonce)", authed: false,
                headers: ["x-desktop-verifier": verifier])
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
