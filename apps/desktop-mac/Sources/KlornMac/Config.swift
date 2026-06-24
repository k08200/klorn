import Foundation

/// App configuration. The API base is env-overridable so the same build runs
/// against local dev, a self-hosted deploy, or prod without a rebuild.
enum Config {
    /// API base URL. Defaults to local dev (Fastify on :3001); override with
    /// KLORN_API_URL. A non-http(s) or malformed override falls back to default.
    /// Returned without a trailing slash so path concatenation is unambiguous.
    static let apiBaseURL: String = {
        let fallback = "http://localhost:3001"
        guard let raw = ProcessInfo.processInfo.environment["KLORN_API_URL"],
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else { return fallback }
        let s = raw.hasSuffix("/") ? String(raw.dropLast()) : raw
        return s
    }()

    /// Keychain coordinates for the persisted JWT. The API authenticates with
    /// `Authorization: Bearer` (no cookie session), so the token must survive
    /// across launches.
    static let keychainService = "ai.klorn.desktop"
    static let keychainAccount = "klorn-token"
}
