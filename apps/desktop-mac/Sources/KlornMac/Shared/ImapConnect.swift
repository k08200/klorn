import Foundation

/// A mail provider the desktop connects over IMAP with an app password
/// (routes/imap-connect.ts, one route family per provider). Naver's routes are
/// always live; every other provider's routes answer 404 while its server flag
/// is off (iCloud: ICLOUD_INBOX_ENABLED; the presets: IMAP_PRESETS_ENABLED,
/// also outside its rollout cohort), which hides its entry point. The raw
/// value is the server's provider enum; the case order is the display order.
enum ImapMailProvider: String, CaseIterable, Identifiable, Sendable {
    case naver = "NAVER"
    case icloud = "ICLOUD"
    // Fixed-host app-password presets (provider phase 2). ZOHOPRO is a Zoho
    // organization (paid, own-domain) mailbox, which has its own hosts.
    case daum = "DAUM"
    case kakao = "KAKAO"
    case yahoo = "YAHOO"
    case aol = "AOL"
    case fastmail = "FASTMAIL"
    case zoho = "ZOHO"
    case zohopro = "ZOHOPRO"

    var id: String { rawValue }

    /// `/api/<slug>-imap`, slug = the lowercased server enum.
    private var routePrefix: String { "/api/\(slug)-imap" }

    var statusPath: String { routePrefix + "/status" }
    var connectPath: String { routePrefix + "/connect" }
    var disconnectPath: String { routePrefix + "/disconnect" }

    /// Where the user makes the app password: the provider's own help page,
    /// opened in the default browser.
    var appPasswordHelpURL: URL? {
        switch self {
        case .naver: nil
        case .icloud: URL(string: "https://appleid.apple.com")
        case .daum: URL(string: "https://cs.daum.net/faq/service/43/category/9234/detail/24081")
        case .kakao: URL(string: "https://cs.kakao.com/helps_html/1073209983")
        case .yahoo: URL(string: "https://help.yahoo.com/kb/SLN15241.html")
        case .aol: URL(string: "https://help.aol.com/articles/create-and-manage-app-password")
        case .fastmail: URL(string: "https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords")
        case .zoho, .zohopro: URL(string: "https://www.zoho.com/mail/help/imap-access.html")
        }
    }

    /// Placeholder shapes only — never a real address.
    var emailPlaceholder: String {
        switch self {
        case .naver: "you@naver.com"
        case .icloud: "you@icloud.com"
        case .daum: "you@daum.net"
        case .kakao: "you@kakao.com"
        case .yahoo: "you@yahoo.com"
        case .aol: "you@aol.com"
        case .fastmail: "you@fastmail.com"
        case .zoho: "you@zoho.com"
        case .zohopro: "you@yourcompany.com"
        }
    }

    var passwordPlaceholder: String {
        self == .icloud ? "xxxx-xxxx-xxxx-xxxx" : ""
    }

    // MARK: copy
    // Naver and iCloud keep their own sentences (`account.<slug>.*`). The
    // presets share one shape (`account.preset.*`) with the provider's name
    // filled in; only the name and the where-to-make-the-password hint are
    // per preset.

    /// Whether this provider reads the shared preset sentences.
    var usesPresetCopy: Bool { self != .naver && self != .icloud }

    var connectLabel: String { sentence("connect") }
    var formTitle: String { sentence("title") }
    var emailLabel: String { label("email") }
    /// Always an app password: Klorn never asks for an account password.
    var passwordLabel: String { label("password") }
    var passwordHint: String { L("account.\(slug).password.hint") }
    var bodyText: String? {
        switch self {
        case .naver: nil
        case .icloud: L("account.icloud.body")
        default: L("account.preset.body")
        }
    }
    var helpLinkLabel: String? {
        switch self {
        case .naver: nil
        case .icloud: L("account.icloud.help.link")
        default: L("account.preset.help.link", presetName)
        }
    }
    var authFailedMessage: String { sentence("error.authFailed") }
    var unavailableMessage: String { sentence("error.unavailable") }

    /// A preset's name inside a sentence (a qualifier like "(organization)"
    /// is translated). Presets only: Naver and iCloud name themselves in
    /// their own copy and have no `.name` key.
    var presetName: String { L("account.\(slug).name") }

    private func sentence(_ suffix: String) -> String {
        usesPresetCopy ? L("account.preset.\(suffix)", presetName) : L("account.\(slug).\(suffix)")
    }

    private func label(_ suffix: String) -> String {
        usesPresetCopy ? L("account.preset.\(suffix)") : L("account.\(slug).\(suffix)")
    }

    private var slug: String { rawValue.lowercased() }
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
        case .appPasswordRejected: provider.authFailedMessage
        case .unreachable: L("account.imap.error.unreachable")
        case .tooManyAccounts: L("account.imap.error.tooMany")
        case .invalidEmail: L("account.imap.error.invalidEmail")
        case .rateLimited: L("account.imap.rateLimited")
        case .needsPro: L("account.imap.error.needsPro")
        case .unavailable: provider.unavailableMessage
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

/// The connect buttons Settings ▸ Accounts draws, in display order: Naver
/// always (its routes are never gated), every other provider only once its
/// status probe answered. Pure.
func offeredImapProviders(_ available: Set<ImapMailProvider>) -> [ImapMailProvider] {
    ImapMailProvider.allCases.filter { $0 == .naver || available.contains($0) }
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
