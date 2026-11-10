import Foundation

/// A mail provider the desktop connects over IMAP with an app password
/// (routes/imap-connect.ts, one route family per provider). Naver's routes are
/// always live; iCloud's answer 404 while ICLOUD_INBOX_ENABLED is off, which
/// hides its entry point. The raw value is the server's provider enum.
enum ImapMailProvider: String, CaseIterable, Identifiable, Sendable {
    case naver = "NAVER"
    case icloud = "ICLOUD"

    var id: String { rawValue }

    private var routePrefix: String {
        switch self {
        case .naver: "/api/naver-imap"
        case .icloud: "/api/icloud-imap"
        }
    }

    var statusPath: String { routePrefix + "/status" }
    var connectPath: String { routePrefix + "/connect" }
    var disconnectPath: String { routePrefix + "/disconnect" }

    /// Where the user makes the app password. Opened in the default browser.
    var appPasswordHelpURL: URL? {
        switch self {
        case .naver: nil
        case .icloud: URL(string: "https://appleid.apple.com")
        }
    }

    /// Localization keys, one place per provider.
    var connectKey: String { "account.\(keyStem).connect" }
    var titleKey: String { "account.\(keyStem).title" }
    var emailKey: String { "account.\(keyStem).email" }
    var passwordKey: String { "account.\(keyStem).password" }
    var hintKey: String { "account.\(keyStem).password.hint" }
    var bodyKey: String? { self == .icloud ? "account.icloud.body" : nil }
    var helpLinkKey: String? { self == .icloud ? "account.icloud.help.link" : nil }
    var authFailedKey: String { "account.\(keyStem).error.authFailed" }
    var unavailableKey: String { "account.\(keyStem).error.unavailable" }

    /// Placeholder shapes only — never a real address.
    var emailPlaceholder: String {
        switch self {
        case .naver: "you@naver.com"
        case .icloud: "you@icloud.com"
        }
    }

    var passwordPlaceholder: String {
        switch self {
        case .naver: ""
        case .icloud: "xxxx-xxxx-xxxx-xxxx"
        }
    }

    private var keyStem: String {
        switch self {
        case .naver: "naver"
        case .icloud: "icloud"
        }
    }
}

/// The connect request. The body is exactly `{ email, password }`: the server
/// picks the provider's fixed host itself, so the client never sends one.
enum ImapConnectRequest {
    /// Thrown instead of sending an app password over plain http to a remote host.
    struct InsecureTransport: Error, Sendable {}

    /// Both fields are trimmed: an app password pasted from a web page often
    /// carries a trailing space or newline, and neither Apple's nor Naver's
    /// app passwords contain whitespace at the ends.
    static func body(email: String, password: String) throws -> Data {
        let mail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let secret = password.trimmingCharacters(in: .whitespacesAndNewlines)
        return try JSONEncoder().encode(["email": mail, "password": secret])
    }

    /// The API base may carry an app password: https, or http to this Mac only
    /// (a local dev server). Anything else is refused before a byte is sent.
    static func isSecureBase(_ base: String) -> Bool {
        guard let url = URL(string: base), let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased()
        else { return false }
        if scheme == "https" { return true }
        return scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)
    }
}

/// A non-2xx connect answer, with the server's machine `code` when it sent one
/// (IMAP_AUTH_FAILED / IMAP_UNREACHABLE) and its English `message`.
struct ImapConnectRejection: Error, Sendable, Equatable {
    let status: Int
    let code: String?
    let message: String?
}

/// Why a connect failed, in words the user can act on. Pure for the harness.
enum ImapConnectFailure: Equatable, Sendable {
    case appPasswordRejected
    case unreachable
    case tooManyAccounts
    case invalidEmail
    case rateLimited
    case needsPro
    case unavailable
    case offline
    case insecureTransport
    case generic

    /// Classify a thrown error. A 401 is not handled here: the caller signs
    /// the session out instead of showing a sentence.
    static func classify(_ error: Error) -> ImapConnectFailure {
        switch error {
        case let rejection as ImapConnectRejection: return classify(rejection)
        case is ImapConnectRequest.InsecureTransport: return .insecureTransport
        case APIError.forbidden: return .needsPro
        case let APIError.transport(_, code?) where offlineCodes.contains(code): return .offline
        default: return .generic
        }
    }

    static func classify(_ rejection: ImapConnectRejection) -> ImapConnectFailure {
        switch rejection.code {
        case "IMAP_AUTH_FAILED": return .appPasswordRejected
        case "IMAP_UNREACHABLE": return .unreachable
        case "ENTITLEMENT_REQUIRED": return .needsPro
        default: break
        }
        switch rejection.status {
        case 403: return .needsPro
        case 404: return .unavailable
        case 429: return .rateLimited
        default: break
        }
        guard let message = rejection.message, !message.isEmpty else { return .generic }
        // An older server sends no code: read its stable English prefixes.
        if message.range(of: "login failed", options: .caseInsensitive) != nil { return .appPasswordRejected }
        if message.hasPrefix("Could not reach") { return .unreachable }  // wire-value
        if message.hasPrefix("At most ") { return .tooManyAccounts }
        if message.hasPrefix("body/email") { return .invalidEmail }
        // Anything else is raw library text (untranslated, may name a host):
        // never shown — the localized generic sentence instead.
        return .generic
    }

    func message(for provider: ImapMailProvider) -> String {
        switch self {
        case .appPasswordRejected: L(provider.authFailedKey)
        case .unreachable: L("account.imap.error.unreachable")
        case .tooManyAccounts: L("account.imap.error.tooMany")
        case .invalidEmail: L("account.imap.error.invalidEmail")
        case .rateLimited: L("account.imap.rateLimited")
        case .needsPro: L("account.imap.error.needsPro")
        case .unavailable: L(provider.unavailableKey)
        case .offline: L("account.imap.error.offline")
        case .insecureTransport: L("account.imap.error.insecure")
        case .generic: L("account.imap.failed")
        }
    }

    private static let offlineCodes: Set<Int> = [
        URLError.notConnectedToInternet.rawValue,
        URLError.networkConnectionLost.rawValue,
        URLError.dataNotAllowed.rawValue,
    ]
}

/// What a connect attempt came to. `.ignored` = nothing to show (a second
/// submit while one runs, a session that changed or was signed out).
enum ImapConnectOutcome: Equatable, Sendable {
    case connected
    case failed(ImapConnectFailure)
    case ignored
}

/// Account rows from /api/email/inboxes that the IMAP status lists already
/// show (with their host and a disconnect button) — dropped so a mailbox is
/// never listed twice once the provider selector flag sends them. Pure.
func inboxesNotListedAsImap(
    _ inboxes: [InboxOption], imap: [ImapMailProvider: [ImapAccount]]
) -> [InboxOption] {
    inboxes.filter { inbox in
        guard let provider = inbox.provider.flatMap({ ImapMailProvider(rawValue: $0.uppercased()) }),
              let email = inbox.email?.lowercased(),
              let accounts = imap[provider]
        else { return true }
        return !accounts.contains { $0.email.lowercased() == email }
    }
}
