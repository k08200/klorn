import Foundation

// Files (productization plan P12, macOS parity with the web's /files and
// Today's recent files, PR #1422 / #1430). The pure rules: how the drive list
// is asked for, how a size reads, which links a row may open. Read-only
// (decision V4: list, search, open; no upload or edit from here).

/// The server-driven client flags this build reads from `GET /api/auth/me`.
/// Both default to false: an older server that does not send them shows no
/// Files and no free-time finder, never a surface it cannot serve.
struct ClientFlags: Equatable, Sendable, Decodable {
    /// FD-7: Files appears only while a drive source is enabled.
    var files = false
    /// TEAM_MODE_ENABLED: "When is everyone free?" may be offered.
    var teamMode = false

    init(files: Bool = false, teamMode: Bool = false) {
        self.files = files
        self.teamMode = teamMode
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A non-boolean value is not "on" either.
        files = (try? c.decodeIfPresent(Bool.self, forKey: .files)) ?? false
        teamMode = (try? c.decodeIfPresent(Bool.self, forKey: .teamMode)) ?? false
    }

    private enum CodingKeys: String, CodingKey { case files, teamMode }
}

/// `GET /api/auth/me`: only the flags; the rest of the user is not read here.
struct MeFlagsResponse: Decodable, Sendable {
    let user: ClientFlags
}

/// One row of `GET /api/drive/files` (DriveFileWire in packages/contract/src/drive.ts).
struct DriveFileWire: Codable, Sendable, Identifiable, Equatable {
    let id: String
    /// "KLORN" | "GOOGLE" | "ONEDRIVE"; an unknown value is kept as text.
    let provider: String
    let externalId: String
    /// The source's text: rendered as text only.
    let name: String
    let mimeType: String?
    let isFolder: Bool
    let sizeBytes: Double?
    let modifiedAt: String
    let webUrl: String?
}

/// `GET /api/drive/files` — newest first, one page.
struct DriveFilesPage: Codable, Sendable {
    let files: [DriveFileWire]
    let nextCursor: String?
}

/// `GET /api/drive/files/:id/download` — a signed link, at most 300 s.
struct DriveDownloadWire: Codable, Sendable {
    let url: String
}

/// What activating a row does; `.none` leaves it plain text.
enum FileOpenAction: Equatable, Sendable {
    case link(URL)
    case download
    case folder
    case none
}

/// One opened Klorn drive folder: the row id, the id its children name, its name.
struct FolderCrumb: Equatable, Sendable {
    let id: String
    let externalId: String
    let name: String
}

/// Why a download did not start. The keys are the web's.
enum FileDownloadError: String, Equatable, Sendable {
    case gone = "files.download.gone"
    case busy = "files.download.busy"
    case failed = "files.download.error"
}

enum FilesRules {
    /// One page of Files. The server serves at most 100.
    static let pageSize = 50
    /// Today's "Recent files".
    static let recentLimit = 5
    /// The server reads the first 100 characters of a search; send no more.
    static let searchMaxChars = 100
    /// The search field settles for this long before it asks.
    static let searchDebounce: Duration = .milliseconds(250)

    private static let klornProvider = "KLORN"
    private static let httpNotFound = 404
    private static let httpTooMany = 429
    private static let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "::1", "[::1]"]

    /// Files is in the navigation only while the server reports a drive source.
    static func sections(files: Bool) -> [NavSection] {
        NavSection.allCases.filter { $0 != .files || files }
    }

    /// RFC 3986 unreserved characters only, as URLSearchParams leaves them.
    static func queryEscape(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        // `alphanumerics` covers non-ASCII letters; restrict to ASCII.
        let ascii = CharacterSet(charactersIn: Unicode.Scalar(0)...Unicode.Scalar(127))
        return value.addingPercentEncoding(withAllowedCharacters: allowed.intersection(ascii)) ?? ""
    }

    /// GET /api/drive/files with the page size, search, page and folder, in the web's order.
    static func listPath(
        query: String = "", cursor: String? = nil, limit: Int = pageSize, folder: String? = nil
    ) -> String {
        var params = [("limit", String(limit))]
        let text = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(searchMaxChars))
        if !text.isEmpty { params.append(("q", text)) }
        if let cursor, !cursor.isEmpty { params.append(("cursor", cursor)) }
        if let folder, !folder.isEmpty { params.append(("folder", folder)) }
        let query = params.map { "\($0.0)=\(queryEscape($0.1))" }.joined(separator: "&")
        return "/api/drive/files?\(query)"
    }

    /// The authenticated request for one file's signed link.
    static func downloadLinkPath(id: String) -> String {
        "/api/drive/files/\(queryEscape(id))/download"
    }

    /// A file's link into its own service, only when it is https with no
    /// credentials and a host. Anything else is never opened.
    static func safeWebURL(_ raw: String?) -> URL? {
        guard let raw, let url = URL(string: raw.trimmingCharacters(in: .whitespaces)),
              url.scheme?.lowercased() == "https", noCredentials(url), hasHost(url)
        else { return nil }
        return url
    }

    /// The signed link, only when it is absolute https without credentials
    /// (or http to a loopback host: a local object store in development).
    static func safeDownloadURL(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty, let url = URL(string: raw), noCredentials(url), hasHost(url),
              let scheme = url.scheme?.lowercased()
        else { return nil }
        if scheme == "https" { return url }
        if scheme == "http", let host = url.host?.lowercased(), loopbackHosts.contains(host) { return url }
        return nil
    }

    private static func noCredentials(_ url: URL) -> Bool {
        (url.user ?? "").isEmpty && (url.password ?? "").isEmpty
    }

    private static func hasHost(_ url: URL) -> Bool {
        !(url.host ?? "").isEmpty
    }

    static func openAction(for file: DriveFileWire) -> FileOpenAction {
        if file.provider.uppercased() == klornProvider {
            return file.isFolder ? .folder : .download
        }
        return safeWebURL(file.webUrl).map(FileOpenAction.link) ?? .none
    }

    /// The trail cut back to `index` (-1: all files). A new array.
    static func trail(_ trail: [FolderCrumb], to index: Int) -> [FolderCrumb] {
        Array(trail.prefix(max(0, index + 1)))
    }

    static func downloadError(for error: Error) -> FileDownloadError {
        guard case APIError.http(let status, _) = error else { return .failed }
        switch status {
        case httpNotFound: return .gone
        case httpTooMany: return .busy
        default: return .failed
        }
    }

    /// "1.5 KB"; empty for a folder or a size the source did not report.
    static func formatSize(_ bytes: Double?, locale: Locale) -> String {
        guard let bytes, bytes.isFinite, bytes >= 0 else { return "" }
        let units = ["B", "KB", "MB", "GB", "TB"]
        let step = 1024.0
        var value = bytes
        var unit = 0
        while value >= step, unit < units.count - 1 {
            value /= step
            unit += 1
        }
        let number = NumberFormatter()
        number.locale = locale
        number.maximumFractionDigits = 1
        number.minimumFractionDigits = 0
        return "\(number.string(from: NSNumber(value: value)) ?? String(value)) \(units[unit])"
    }

    /// "Oct 15" in the user's zone; empty for an unreadable time.
    static func modifiedLabel(_ iso: String, locale: Locale, timeZone: TimeZone = .current) -> String {
        guard let date = parseInstant(iso) else { return "" }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.setLocalizedDateFormatFromTemplate("MMMd")
        return formatter.string(from: date)
    }

    /// "Oct 15 · 1.5 KB" (or "· Folder").
    static func meta(for file: DriveFileWire, locale: Locale, timeZone: TimeZone = .current) -> String {
        let size = file.isFolder ? L("files.folder") : formatSize(file.sizeBytes, locale: locale)
        return [modifiedLabel(file.modifiedAt, locale: locale, timeZone: timeZone), size]
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// ISO 8601 with or without fractional seconds.
    static func parseInstant(_ iso: String) -> Date? {
        let plain = ISO8601DateFormatter()
        if let date = plain.date(from: iso) { return date }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso)
    }

    /// The row glyph: a folder, or a document.
    static func icon(for file: DriveFileWire) -> String {
        file.isFolder ? "folder" : "doc"
    }
}
