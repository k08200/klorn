import Foundation

/// What the server did with one device calendar snapshot (step C6).
enum DeviceSnapshotReply: Sendable, Equatable { case applied, stale }

enum APIError: Error, Sendable, Equatable {
    /// Non-2xx status + the server's `message`/`error` field when present, so the
    /// UI can show the real reason (e.g. a 409 "no-reply sender") not just a code.
    case http(Int, String?)
    case unauthorized  // 401 — session invalid/expired (drop to sign-in)
    case forbidden     // 403 — authenticated but not entitled (e.g. Pro-only); do NOT sign out
    case transport(String)
    case decoding(String)
}

/// Thin async URLSession client. The API authenticates with a Bearer JWT (no
/// cookie session), so authed calls attach the token from the store. Stateless
/// and Sendable — safe to use from any task.
struct APIClient: Sendable {
    var base: String = Config.apiBaseURL
    var session: URLSession = .shared
    /// Token provider, injectable for tests; defaults to the Keychain.
    var token: @Sendable () -> String? = { KeychainStore.load() }

    private func url(_ path: String) throws -> URL {
        guard let u = URL(string: base + path) else {
            throw APIError.transport("invalid URL")
        }
        return u
    }

    /// Decode a GET response. `authed` attaches the Bearer token when present.
    func get<T: Decodable>(_ path: String, authed: Bool = true, as _: T.Type = T.self) async throws -> T {
        let data = try await data(path, authed: authed)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            // Keep the raw decoder error (which can echo response bytes / model
            // shape) out of the thrown error; log it privately instead.
            Log.net.debug("decode failed for \(path, privacy: .public): \(String(describing: error), privacy: .private)")
            throw APIError.decoding(path)
        }
    }

    /// GET /api/email/inboxes — the caller's mailboxes (primary + linked) for
    /// the per-inbox selector. Read-only; the server returns no tokens.
    func fetchInboxes() async throws -> InboxesResponse {
        try await get("/api/email/inboxes")
    }

    /// GET /api/naver-imap/status — connected Naver mailboxes. Not gated by
    /// the provider-selector flag, so it is the reliable source for the
    /// account list even when /api/email/inboxes hides non-Google rows.
    func fetchNaverStatus() async throws -> ImapStatusResponse {
        try await get("/api/naver-imap/status")
    }

    /// POST /api/naver-imap/connect. The app password is passed straight
    /// through to the server (which verifies it with a live IMAP login and
    /// stores it enciphered) and is never persisted on this machine.
    func connectNaver(email: String, password: String) async throws {
        let body = try JSONEncoder().encode(["email": email, "password": password])
        _ = try await data(
            "/api/naver-imap/connect", method: "POST", body: body,
            contentType: "application/json")
    }

    /// POST /api/naver-imap/disconnect — ALWAYS with an email: the bodyless
    /// form removes every mailbox for the provider, which no desktop control
    /// should be able to trigger by accident.
    func disconnectNaver(email: String) async throws {
        let body = try JSONEncoder().encode(["email": email])
        _ = try await data(
            "/api/naver-imap/disconnect", method: "POST", body: body,
            contentType: "application/json")
    }

    /// GET /api/device-calendar/sources — the device calendars this user uploaded
    /// (step C6). The server answers its default 404 while the feature is off, which
    /// DeviceCalendarBridge reads as "hide the setting".
    func fetchDeviceCalendarSources() async throws -> DeviceCalendarSourcesResponse {
        try await get("/api/device-calendar/sources")
    }

    /// PUT one opted-in calendar's full snapshot of its window. `key` is the
    /// device-scoped hash (DeviceCalendarSnapshot.sourceKey), never the raw
    /// EventKit identifier.
    /// The body is already encoded (off the main thread, by DeviceCalendarReader).
    /// Its own request, like `rawGet`: the reply's body matters on both sides of 2xx.
    /// A 200 may say `stale: true` (ignored as older than what the server holds),
    /// and a 409 carries a machine `code` naming the cap that was hit, thrown as the
    /// error's message so the bridge can pick the text.
    func putDeviceCalendarSnapshot(key: String, body: Data) async throws -> DeviceSnapshotReply {
        var req = URLRequest(url: try url("/api/device-calendar/sources/\(key)/window"))
        req.httpMethod = "PUT"
        req.httpBody = body
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        let bytes: Data
        let resp: URLResponse
        do {
            (bytes, resp) = try await session.data(for: req)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
        guard let http = resp as? HTTPURLResponse else { throw APIError.transport("non-HTTP response") }
        struct Reply: Decodable { let stale: Bool?; let code: String? }
        let reply = try? JSONDecoder().decode(Reply.self, from: bytes)
        switch http.statusCode {
        case 200...299: return reply?.stale == true ? .stale : .applied
        case 401: throw APIError.unauthorized
        case 403: throw APIError.forbidden
        case 409: throw APIError.http(409, reply?.code ?? Self.serverMessage(bytes))
        default: throw APIError.http(http.statusCode, Self.serverMessage(bytes))
        }
    }

    /// DELETE a calendar the user turned off: the server removes it and its events.
    func deleteDeviceCalendarSource(key: String) async throws {
        try await delete("/api/device-calendar/sources/\(key)")
    }

    /// GET /api/automations — server-owned behaviour settings (agent mode,
    /// reply tone, notification categories, quiet hours).
    func fetchAutomationSettings() async throws -> AutomationSettings {
        try await get("/api/automations")
    }

    /// PATCH /api/automations. Returns the server's post-write state so the UI
    /// settles on what was actually stored (normalized tone/mode included)
    /// rather than on what it optimistically painted.
    func updateAutomationSettings(_ settings: AutomationSettings) async throws -> AutomationSettings {
        let body = try JSONSerialization.data(withJSONObject: settings.patchPayload)
        let data = try await data(
            "/api/automations", method: "PATCH", body: body, contentType: "application/json")
        do {
            return try JSONDecoder().decode(AutomationSettings.self, from: data)
        } catch {
            Log.net.debug("decode failed for PATCH /api/automations: \(String(describing: error), privacy: .private)")
            throw APIError.decoding("/api/automations")
        }
    }

    /// Fire a POST (empty body); discard the response, mapping status to APIError.
    func post(_ path: String, authed: Bool = true) async throws {
        _ = try await data(path, method: "POST", authed: authed)
    }

    /// POST a JSON object; discard the response body.
    func post(_ path: String, json: [String: String], authed: Bool = true) async throws {
        let body = try JSONEncoder().encode(json)
        _ = try await data(path, method: "POST", body: body, contentType: "application/json", authed: authed)
    }

    /// POST any Encodable body; discard the response (arrays/optionals that
    /// the [String: String] helper cannot express — e.g. event attendees).
    func post(_ path: String, encodable: some Encodable, authed: Bool = true) async throws {
        let body = try JSONEncoder().encode(encodable)
        _ = try await data(path, method: "POST", body: body, contentType: "application/json", authed: authed)
    }

    /// DELETE a resource; discard the response body.
    func delete(_ path: String, authed: Bool = true) async throws {
        _ = try await data(path, method: "DELETE", authed: authed)
    }

    /// PATCH an Encodable body; discard the response. For payloads a
    /// [String: String] can't express (optional fields must serialize null).
    func patch(_ path: String, encodable: some Encodable, authed: Bool = true) async throws {
        let body = try JSONEncoder().encode(encodable)
        _ = try await data(path, method: "PATCH", body: body, contentType: "application/json", authed: authed)
    }

    /// PUT an Encodable body; discard the response (e.g. a sender label —
    /// "this address is X", create-or-overwrite semantics).
    func put(_ path: String, encodable: some Encodable, authed: Bool = true) async throws {
        let body = try JSONEncoder().encode(encodable)
        _ = try await data(path, method: "PUT", body: body, contentType: "application/json", authed: authed)
    }

    /// PATCH a JSON object; discard the response body (e.g. commitment status).
    func patch(_ path: String, json: [String: String], authed: Bool = true) async throws {
        let body = try JSONEncoder().encode(json)
        _ = try await data(path, method: "PATCH", body: body, contentType: "application/json", authed: authed)
    }

    /// POST a JSON object and decode the response (e.g. an AI reply draft).
    /// Encodable body + decoded response — for payloads a [String: String]
    /// can't express (nested objects, optional fields).
    func post<T: Decodable>(
        _ path: String, encodable: some Encodable, as _: T.Type = T.self, authed: Bool = true
    ) async throws -> T {
        let reqBody = try JSONEncoder().encode(encodable)
        let data = try await data(path, method: "POST", body: reqBody, contentType: "application/json", authed: authed)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            Log.net.debug("decode failed for \(path, privacy: .public): \(String(describing: error), privacy: .private)")
            throw APIError.decoding(path)
        }
    }

    func post<T: Decodable>(_ path: String, json: [String: String], as _: T.Type = T.self, authed: Bool = true) async throws -> T {
        let reqBody = try JSONEncoder().encode(json)
        let data = try await data(path, method: "POST", body: reqBody, contentType: "application/json", authed: authed)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            Log.net.debug("decode failed for \(path, privacy: .public): \(String(describing: error), privacy: .private)")
            throw APIError.decoding(path)
        }
    }

    /// Raw request → body bytes. Maps non-2xx to APIError (401/403 → .unauthorized).
    @discardableResult
    func data(
        _ path: String,
        method: String = "GET",
        body: Data? = nil,
        contentType: String? = nil,
        authed: Bool = true,
        headers: [String: String]? = nil
    ) async throws -> Data {
        var req = URLRequest(url: try url(path))
        req.httpMethod = method
        if let body { req.httpBody = body }
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let headers {
            for (name, value) in headers { req.setValue(value, forHTTPHeaderField: name) }
        }
        if authed, let t = token() {
            req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        }
        let bytes: Data
        let resp: URLResponse
        do {
            (bytes, resp) = try await session.data(for: req)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
        guard let http = resp as? HTTPURLResponse else {
            throw APIError.transport("non-HTTP response")
        }
        switch http.statusCode {
        case 200...299: return bytes
        case 401: throw APIError.unauthorized
        case 403: throw APIError.forbidden
        default: throw APIError.http(http.statusCode, Self.serverMessage(bytes))
        }
    }

    /// GET raw bytes plus the server's content type — inline mail images,
    /// where the MIME type matters and the body is not JSON.
    func rawGet(_ path: String) async throws -> (Data, String?) {
        var req = URLRequest(url: try url(path))
        if let t = token() {
            req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        }
        let bytes: Data
        let resp: URLResponse
        do {
            (bytes, resp) = try await session.data(for: req)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
        guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIError.transport("inline fetch failed")
        }
        return (bytes, http.value(forHTTPHeaderField: "Content-Type"))
    }

    /// Pull a human message out of an error response body (`{message}`/`{error}`).
    private static func serverMessage(_ data: Data) -> String? {
        struct Body: Decodable { let message: String?; let error: String? }
        guard let body = try? JSONDecoder().decode(Body.self, from: data) else { return nil }
        let msg = body.message ?? body.error
        return (msg?.isEmpty == false) ? msg : nil
    }
}
