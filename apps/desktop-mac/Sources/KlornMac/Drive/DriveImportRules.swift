import Foundation

// Step D7 (docs/providers/unified-platform-plan.md): import files the user picks
// on this Mac (iCloud Drive, a cloud folder such as MYBOX, local disk) into the
// Klorn drive through D3's `POST /api/drive/files`. The pick is the opt-in
// (decision P4): nothing is read or uploaded that the user did not choose in the
// open panel, and nothing is watched afterwards. This file holds the pure rules
// the self-check pins: the limits, the size pre-check, the error mapping, the
// backoff and the multipart framing.

/// The bounds of one import. Every number is named here and pinned by the self-check.
enum DriveImportLimits {
    /// D3's cap (`KLORN_DRIVE_MAX_FILE_BYTES`, 25 MiB). The server's `/limits` answer wins when it has one.
    static let maxFileBytes: Int64 = 25 * 1024 * 1024
    /// Files one import uploads at most; a picked folder is walked up to this many.
    static let maxFiles = 200
    /// Folders one import creates at most (each picked folder and each one inside it).
    static let maxFolders = 50
    /// Levels below a picked folder that are walked (the picked folder is level 0).
    static let maxFolderDepth = 8
    /// Bytes one import uploads at most, in all (1 GiB).
    static let maxTotalBytes: Int64 = 1024 * 1024 * 1024
    /// Uploads in flight at once. D3 allows 20 uploads a minute per user, so more buys nothing.
    static let uploadConcurrency = 2
    /// Tries for one request the server rate limits or that fails for a passing reason.
    static let maxAttempts = 5
    /// The first wait before a retry without a `Retry-After`; doubled each time.
    static let baseBackoffSeconds = 2
    /// No wait is longer than this, whatever the server's `Retry-After` says.
    static let maxBackoffSeconds = 60
    /// Bytes read from the source and written to the request body at a time.
    static let copyChunkBytes = 1024 * 1024
}

/// Why one item was not uploaded. Each has its own text (`messageKey`).
enum DriveImportFailure: Error, Equatable, Sendable {
    /// The server's dark gate (404 without a drive code): the Klorn drive is off there.
    case featureOff
    /// 401: the session ended.
    case unauthorized
    /// 503 `quota-not-configured`: the server refuses every upload until a quota is set.
    case quotaNotConfigured
    /// 413 `quota-exceeded`.
    case quotaExceeded
    /// 409 `account-purging`: a data deletion is running.
    case accountPurging
    /// 413 `too-large`, or over the size pre-check.
    case tooLarge
    /// 429, still limited after every retry.
    case rateLimited
    /// 400 `multipart-malformed` or `invalid-upload`: the body did not arrive whole.
    case malformed
    /// 400 `invalid-name`.
    case invalidName
    /// 404 `parent-not-found`, or the folder it belongs in could not be created.
    case folderMissing
    /// 503 `storage-unavailable`, still failing after every retry.
    case storageUnavailable
    /// No answer from the server (offline, timeout), after every retry.
    case offline
    /// A cloud file (iCloud Drive, a File Provider folder) that could not be downloaded to read it.
    case notDownloaded
    /// This Mac could not read the file (permissions, a disk error).
    case unreadable
    /// The file changed size while it was read; uploading it would send a mix.
    case changedWhileReading
    /// A link, an app or another package: not one file (and a link may point outside the pick).
    case unsupported
    /// Not uploaded because the import was cancelled.
    case cancelled
    /// Anything else.
    case generic
}

enum DriveImportRules {
    /// The codes D3 answers (`DriveErrorCode` in packages/contract/src/drive.ts) that the import maps.
    static let quotaNotConfiguredCode = "quota-not-configured"
    static let quotaExceededCode = "quota-exceeded"
    static let accountPurgingCode = "account-purging"
    static let tooLargeCode = "too-large"
    static let rateLimitedCode = "rate-limited"
    static let malformedCode = "multipart-malformed"
    static let invalidUploadCode = "invalid-upload"
    static let invalidNameCode = "invalid-name"
    static let parentNotFoundCode = "parent-not-found"
    static let storageUnavailableCode = "storage-unavailable"

    /// What a refused request means for the import. A 404 carrying none of the
    /// drive's codes is the dark gate's default 404 (routes/dark-route-gate.ts):
    /// the feature is off, so the menu item and the section hide.
    static func failure(status: Int, code: String?) -> DriveImportFailure {
        switch (status, code) {
        case (401, _): return .unauthorized
        case (_, quotaNotConfiguredCode?): return .quotaNotConfigured
        case (_, quotaExceededCode?): return .quotaExceeded
        case (_, accountPurgingCode?): return .accountPurging
        case (_, tooLargeCode?), (413, _): return .tooLarge
        case (_, rateLimitedCode?), (429, _): return .rateLimited
        case (_, malformedCode?), (_, invalidUploadCode?): return .malformed
        case (_, invalidNameCode?): return .invalidName
        case (_, parentNotFoundCode?): return .folderMissing
        case (_, storageUnavailableCode?): return .storageUnavailable
        case (404, nil): return .featureOff
        default: return .generic
        }
    }

    /// Failures that end the whole import: every later file would meet the same refusal.
    static func stopsImport(_ failure: DriveImportFailure) -> Bool {
        switch failure {
        case .featureOff, .unauthorized, .quotaNotConfigured, .quotaExceeded, .accountPurging: true
        default: false
        }
    }

    /// Failures worth the same request again after a wait.
    static func isRetryable(_ failure: DriveImportFailure) -> Bool {
        switch failure {
        case .rateLimited, .storageUnavailable, .offline: true
        default: false
        }
    }

    /// Seconds to wait before try `attempt + 1` (`attempt` counts from 1): the
    /// server's `Retry-After` when it sent one, else 2, 4, 8 … seconds; never
    /// under 1 or over `maxBackoffSeconds`.
    static func backoffSeconds(attempt: Int, retryAfter: Int?) -> Int {
        let cap = DriveImportLimits.maxBackoffSeconds
        if let retryAfter { return min(max(retryAfter, 1), cap) }
        let exponent = min(max(attempt - 1, 0), 16)
        return min(DriveImportLimits.baseBackoffSeconds << exponent, cap)
    }

    /// `Retry-After` as whole seconds (the rate limiter sends seconds, never a date).
    static func retryAfterSeconds(_ header: String?) -> Int? {
        guard let header, let seconds = Int(header.trimmingCharacters(in: .whitespaces)), seconds >= 0
        else { return nil }
        return seconds
    }

    /// The size pre-check, before a single byte is read: nil when the file may
    /// go, `.tooLarge` over the cap, `.unreadable` without a size.
    static func sizeVerdict(_ size: Int64?, maxFileBytes: Int64) -> DriveImportFailure? {
        guard let size, size >= 0 else { return .unreadable }
        return size > maxFileBytes ? .tooLarge : nil
    }

    /// The localized text for a failure (all 7 languages).
    static func messageKey(_ failure: DriveImportFailure) -> String {
        switch failure {
        case .featureOff: "driveImport.error.unavailable"
        case .unauthorized: "driveImport.error.signedOut"
        case .quotaNotConfigured: "driveImport.error.notConfigured"
        case .quotaExceeded: "driveImport.error.full"
        case .accountPurging: "driveImport.error.purging"
        case .tooLarge: "driveImport.error.tooLarge"
        case .rateLimited: "driveImport.error.rateLimited"
        case .malformed: "driveImport.error.malformed"
        case .invalidName: "driveImport.error.invalidName"
        case .folderMissing: "driveImport.error.folderMissing"
        case .storageUnavailable: "driveImport.error.storage"
        case .offline: "driveImport.error.offline"
        case .notDownloaded: "driveImport.error.notDownloaded"
        case .unreadable: "driveImport.error.unreadable"
        case .changedWhileReading: "driveImport.error.changed"
        case .unsupported: "driveImport.error.unsupported"
        case .cancelled: "driveImport.error.cancelled"
        case .generic: "driveImport.error.generic"
        }
    }

    /// The text, with the size cap filled in where the text names it.
    static func message(_ failure: DriveImportFailure, maxFileBytes: Int64) -> String {
        failure == .tooLarge
            ? L("driveImport.error.tooLarge", Int(maxFileBytes / (1024 * 1024)))
            : L(messageKey(failure))
    }
}

/// The multipart/form-data framing of one upload (D3: `size`, an optional
/// `parentExternalId`, then exactly one `file` part). Only the bytes around the
/// file are built here; the file itself is copied from disk in chunks.
enum DriveMultipart {
    /// Used when nothing of a name is left once it is made safe for a header.
    static let fallbackFileName = "file"

    static func makeBoundary() -> String { "KlornDriveImport-\(UUID().uuidString)" }

    static func contentType(boundary: String) -> String {
        "multipart/form-data; boundary=\(boundary)"
    }

    /// Everything before the file's first byte.
    static func head(
        boundary: String, size: Int64, parentExternalId: String?, fileName: String
    ) -> Data {
        var text = field(boundary: boundary, name: "size", value: String(size))
        if let parentExternalId {
            text += field(boundary: boundary, name: "parentExternalId", value: headerSafe(parentExternalId))
        }
        text += "--\(boundary)\r\n"
        text += "Content-Disposition: form-data; name=\"file\"; filename=\"\(quotedFileName(fileName))\"\r\n"
        text += "Content-Type: application/octet-stream\r\n\r\n"
        return Data(text.utf8)
    }

    /// Everything after the file's last byte.
    static func tail(boundary: String) -> Data { Data("\r\n--\(boundary)--\r\n".utf8) }

    /// A file name as the server's parser reads it back (busboy): UTF-8 kept
    /// as is (the server normalises to NFC); control characters dropped (a CR
    /// or LF would end the header); a slash or backslash replaced, because the
    /// parser keeps only what follows the last one; a quote escaped.
    static func quotedFileName(_ name: String) -> String {
        let cleaned = headerSafe(name)
            .replacingOccurrences(of: "\\", with: "_")
            .replacingOccurrences(of: "/", with: "_")
        let named = cleaned.trimmingCharacters(in: .whitespaces).isEmpty ? fallbackFileName : cleaned
        return named.replacingOccurrences(of: "\"", with: "\\\"")
    }

    private static func field(boundary: String, name: String, value: String) -> String {
        "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n"
    }

    /// Drops C0 controls and DEL.
    private static func headerSafe(_ text: String) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7F }))
    }
}
