import Foundation

/// App configuration. The API base is resolved without a rebuild so the same
/// code runs against local dev, a self-hosted deploy, or prod.
enum Config {
    /// Resolution order: `KLORN_API_URL` env (dev) → `KlornAPIURL` baked into a
    /// packaged `.app`'s Info.plist (prod) → local dev default. A non-http(s) or
    /// malformed value is ignored. Returned without a trailing slash.
    static let apiBaseURL: String = resolveAPIBase()

    /// Keychain coordinates for the persisted JWT. The API authenticates with
    /// `Authorization: Bearer` (no cookie session), so the token must survive
    /// across launches.
    static let keychainService = "ai.klorn.desktop"
    static let keychainAccount = "klorn-token"

    private static func resolveAPIBase() -> String {
        let fallback = "http://localhost:3001"
        if let raw = ProcessInfo.processInfo.environment["KLORN_API_URL"],
           let url = validated(raw) { return url }
        if let raw = Bundle.main.object(forInfoDictionaryKey: "KlornAPIURL") as? String,
           let url = validated(raw) { return url }
        return fallback
    }

    private static func validated(_ raw: String) -> String? {
        guard let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return nil }
        return raw.hasSuffix("/") ? String(raw.dropLast()) : raw
    }
}
