import Foundation

/// Real-time wake signal. Reuses the API's existing WebSocket hub
/// (`/ws?token=<JWT>&type=desktop` — the `desktop` client type is already
/// supported server-side) rather than adding a second channel. On a server
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
        guard let url = Self.wsURL(token: token) else {
            Log.net.error("realtime: could not build ws url")
            return
        }
        var backoff: Double = 1
        while !stopped {
            let socket = URLSession.shared.webSocketTask(with: url)
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

    nonisolated static func wsURL(token: String) -> URL? {
        var base = Config.apiBaseURL
        // Never send the token over plaintext to a remote host — force TLS for
        // anything that isn't loopback (dev may still use ws://localhost).
        if base.hasPrefix("http://"), !base.contains("localhost"), !base.contains("127.0.0.1") {
            base = "https://" + base.dropFirst("http://".count)
        }
        if base.hasPrefix("https") { base = "wss" + base.dropFirst(5) }
        else if base.hasPrefix("http") { base = "ws" + base.dropFirst(4) }
        guard var comps = URLComponents(string: base + "/ws") else { return nil }
        comps.queryItems = [
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "type", value: "desktop"),
        ]
        return comps.url
    }
}
