import Foundation

/// Real-time wake signal. Reuses the API's existing WebSocket hub (`/ws`, the
/// server-supported `desktop` client type) rather than adding a second channel.
/// The auth JWT rides in the `Sec-WebSocket-Protocol` header (marker
/// `klorn-ws-v1`), never the URL, so it can't leak into proxy/LB access logs.
/// On a server
/// `notification`/`sync` event the firewall refetches immediately instead of
/// waiting for the 60s poll. Native `URLSessionWebSocketTask` — no dependency.
///
/// The poll loop stays as a backstop (reconnect gaps, keep-warm), so this is a
/// latency improvement, not the sole source of truth.
@MainActor
final class RealtimeClient {
    private var task: URLSessionWebSocketTask?
    private var loop: Task<Void, Never>?
    private var stopped = true
    private let onWake: () -> Void

    private static let maxBackoff: Double = 30

    /// Subprotocol marker that carries the JWT out of the URL. Must match the
    /// server (websocket.ts `WS_AUTH_SUBPROTOCOL`). The client offers
    /// [marker, jwt]; the server reads the value after the marker.
    private static let authSubprotocol = "klorn-ws-v1"

    init(onWake: @escaping () -> Void) { self.onWake = onWake }

    func start(token: String) {
        stop()
        stopped = false
        loop = Task { [weak self] in await self?.run(token: token) }
    }

    func stop() {
        stopped = true
        loop?.cancel(); loop = nil
        task?.cancel(with: .goingAway, reason: nil); task = nil
    }

    /// Connect → receive until the socket errors → back off → reconnect, until
    /// `stop()`. A healthy message resets the backoff.
    private func run(token: String) async {
        guard let url = Self.wsURL() else {
            Log.net.error("realtime: could not build ws url")
            return
        }
        var backoff: Double = 1
        while !stopped {
            // JWT via the Sec-WebSocket-Protocol header, not the URL — keeps the
            // credential out of access logs. The server negotiates the marker back.
            let socket = URLSession.shared.webSocketTask(
                with: url,
                protocols: [Self.authSubprotocol, token]
            )
            task = socket
            socket.resume()
            do {
                while !stopped {
                    let message = try await socket.receive()
                    backoff = 1
                    if Self.isWake(message) { onWake() }
                }
            } catch {
                if stopped { return }
                Log.net.debug("realtime disconnected: \(String(describing: error), privacy: .private)")
            }
            if stopped { return }
            try? await Task.sleep(for: .seconds(min(backoff, Self.maxBackoff)))
            backoff = min(backoff * 2, Self.maxBackoff)
        }
    }

    private nonisolated static func isWake(_ message: URLSessionWebSocketTask.Message) -> Bool {
        switch message {
        case .string(let text): return shouldWake(text)
        case .data(let data): return shouldWake(String(data: data, encoding: .utf8) ?? "")
        @unknown default: return false
        }
    }

    /// Refetch on server-pushed change signals; ignore connection chatter
    /// (`connected`, `client_joined`, etc.). Pure + testable.
    nonisolated static func shouldWake(_ text: String) -> Bool {
        struct Envelope: Decodable { let type: String }
        guard let data = text.data(using: .utf8),
              let env = try? JSONDecoder().decode(Envelope.self, from: data) else { return false }
        return env.type == "notification" || env.type == "sync"
    }

    nonisolated static func wsURL() -> URL? {
        var base = Config.apiBaseURL
        // Never talk to a remote host in plaintext — force TLS for anything that
        // isn't loopback (dev may still use ws://localhost). The JWT now travels
        // in the handshake headers, so TLS still protects it.
        if base.hasPrefix("http://"), !base.contains("localhost"), !base.contains("127.0.0.1") {
            base = "https://" + base.dropFirst("http://".count)
        }
        if base.hasPrefix("https") { base = "wss" + base.dropFirst(5) }
        else if base.hasPrefix("http") { base = "ws" + base.dropFirst(4) }
        guard var comps = URLComponents(string: base + "/ws") else { return nil }
        comps.queryItems = [
            URLQueryItem(name: "type", value: "desktop"),
        ]
        return comps.url
    }
}
