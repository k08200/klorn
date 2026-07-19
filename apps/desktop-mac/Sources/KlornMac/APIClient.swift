import Foundation

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

    /// Fire a POST (empty body); discard the response, mapping status to APIError.
    func post(_ path: String, authed: Bool = true) async throws {
        _ = try await data(path, method: "POST", authed: authed)
    }

    /// POST a JSON object; discard the response body.
    func post(_ path: String, json: [String: String], authed: Bool = true) async throws {
        let body = try JSONEncoder().encode(json)
        _ = try await data(path, method: "POST", body: body, contentType: "application/json", authed: authed)
    }

    /// PATCH a JSON object; discard the response body (e.g. commitment status).
    func patch(_ path: String, json: [String: String], authed: Bool = true) async throws {
        let body = try JSONEncoder().encode(json)
        _ = try await data(path, method: "PATCH", body: body, contentType: "application/json", authed: authed)
    }

    /// POST a JSON object and decode the response (e.g. an AI reply draft).
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
        authed: Bool = true
    ) async throws -> Data {
        var req = URLRequest(url: try url(path))
        req.httpMethod = method
        if let body { req.httpBody = body }
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
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

    /// Pull a human message out of an error response body (`{message}`/`{error}`).
    private static func serverMessage(_ data: Data) -> String? {
        struct Body: Decodable { let message: String?; let error: String? }
        guard let body = try? JSONDecoder().decode(Body.self, from: data) else { return nil }
        let msg = body.message ?? body.error
        return (msg?.isEmpty == false) ? msg : nil
    }
}
