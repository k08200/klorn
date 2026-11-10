import Foundation

// Step D7: the Klorn drive routes the import calls (D3, routes/klorn-drive.ts).
// Their own requests, like `putDeviceCalendarSnapshot`: a refusal's `code` and
// `Retry-After` decide what the import does next, and `APIClient.data` keeps
// neither.

/// `GET /api/drive/limits` (DriveLimitsResponse in packages/contract/src/drive.ts).
struct DriveLimitsWire: Decodable, Equatable, Sendable {
    let maxFileBytes: Int64
    /// nil while the server refuses every upload (`quota-not-configured`).
    let quotaBytes: Int64?
    let usedBytes: Int64
}

/// A non-2xx answer of a drive route, or no answer at all.
enum DriveRequestError: Error, Equatable, Sendable {
    /// `retryable`: the server's own word on retrying, when it sent one.
    case refused(status: Int, code: String?, retryable: Bool? = nil, retryAfter: Int?)
    case transport(cancelled: Bool)

    var failure: DriveImportFailure {
        switch self {
        case .refused(let status, let code, _, _): DriveImportRules.failure(status: status, code: code)
        case .transport(let cancelled): cancelled ? .cancelled : .offline
        }
    }

    var retryAfter: Int? {
        if case .refused(_, _, _, let seconds) = self { return seconds }
        return nil
    }

    /// False only when the server said so.
    var serverAllowsRetry: Bool {
        if case .refused(_, _, let retryable?, _) = self { return retryable }
        return true
    }
}

extension APIClient {
    /// The probe: 200 = the Klorn drive is live for this user; the dark gate's 404 = it is off.
    func fetchDriveLimits() async throws -> DriveLimitsWire {
        var req = URLRequest(url: try driveURL("/api/drive/limits"))
        req.httpMethod = "GET"
        let bytes = try await driveSend(req, uploadFrom: nil)
        return try driveDecode(DriveLimitsWire.self, bytes, path: "/api/drive/limits")
    }

    /// `POST /api/drive/folders`; the new folder's `externalId`.
    func createDriveFolder(name: String, parentExternalId: String?) async throws -> String {
        struct Body: Encodable { let name: String; let parentExternalId: String? }
        var req = URLRequest(url: try driveURL("/api/drive/folders"))
        req.httpMethod = "POST"
        req.httpBody = try JSONEncoder().encode(Body(name: name, parentExternalId: parentExternalId))
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let bytes = try await driveSend(req, uploadFrom: nil)
        return try driveDecode(DriveCreatedWire.self, bytes, path: "/api/drive/folders").file.externalId
    }

    /// `POST /api/drive/files` with a body already framed on disk
    /// (DriveImportBody). URLSession streams it from the file: the upload never
    /// sits in memory whole.
    func uploadDriveFile(bodyFile: URL, boundary: String) async throws -> String {
        var req = URLRequest(url: try driveURL("/api/drive/files"))
        req.httpMethod = "POST"
        req.setValue(DriveMultipart.contentType(boundary: boundary), forHTTPHeaderField: "Content-Type")
        let bytes = try await driveSend(req, uploadFrom: bodyFile)
        return try driveDecode(DriveCreatedWire.self, bytes, path: "/api/drive/files").file.externalId
    }

    private struct DriveCreatedWire: Decodable {
        struct File: Decodable { let externalId: String }
        let file: File
    }

    private func driveURL(_ path: String) throws -> URL {
        guard let url = URL(string: base + path) else { throw DriveRequestError.transport(cancelled: false) }
        return url
    }

    private func driveSend(_ request: URLRequest, uploadFrom file: URL?) async throws -> Data {
        var req = request
        if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        let bytes: Data
        let resp: URLResponse
        do {
            if let file {
                (bytes, resp) = try await session.upload(for: req, fromFile: file)
            } else {
                (bytes, resp) = try await session.data(for: req)
            }
        } catch {
            let cancelled = (error as? URLError)?.code == .cancelled || error is CancellationError
            throw DriveRequestError.transport(cancelled: cancelled || Task.isCancelled)
        }
        guard let http = resp as? HTTPURLResponse else { throw DriveRequestError.transport(cancelled: false) }
        guard (200...299).contains(http.statusCode) else {
            struct Refusal: Decodable { let code: String?; let retryable: Bool? }
            let refusal = try? JSONDecoder().decode(Refusal.self, from: bytes)
            throw DriveRequestError.refused(
                status: http.statusCode, code: refusal?.code, retryable: refusal?.retryable,
                retryAfter: DriveImportRules.retryAfterSeconds(http.value(forHTTPHeaderField: "Retry-After")))
        }
        return bytes
    }

    private func driveDecode<T: Decodable>(_ type: T.Type, _ bytes: Data, path: String) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: bytes)
        } catch {
            Log.net.debug("decode failed for \(path, privacy: .public): \(String(describing: error), privacy: .private)")
            throw APIError.decoding(path)
        }
    }
}
