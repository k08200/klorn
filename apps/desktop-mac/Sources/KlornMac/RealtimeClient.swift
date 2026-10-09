import AppKit
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
///
/// Liveness: macOS sleep, NAT rebinding, and proxy idling can kill the TCP
/// path WITHOUT erroring `receive()` — a half-open socket looks connected and
/// silently receives nothing, so every wake signal is lost and the 60 s poll
/// quietly becomes the app's real latency (dogfood report 2026-08-06: web
/// updated in ~1 s, desktop didn't). Two defenses:
///   1. a heartbeat ping every 30 s; a missing pong recycles the socket, and
///   2. an immediate reconnect + refetch when the Mac wakes from sleep.
@MainActor
final class RealtimeClient {
    private var task: URLSessionWebSocketTask?
    private var loop: Task<Void, Never>?
    private var stopped = true
    private var lastToken: String?
    private var wakeObserver: NSObjectProtocol?
    private let onWake: () -> Void

    private nonisolated static let maxBackoff: Double = 30
    /// Probe cadence, and how long a pong may take before the socket is
    /// declared half-open. The interval must comfortably exceed the timeout so
    /// probes never overlap.
    nonisolated static let pingIntervalSeconds: Double = 30
    nonisolated static let pongTimeoutSeconds: Double = 10

    /// Subprotocol marker that carries the JWT out of the URL. Must match the
    /// server (websocket.ts `WS_AUTH_SUBPROTOCOL`). The client offers
    /// [marker, jwt]; the server reads the value after the marker.
    private static let authSubprotocol = "klorn-ws-v1"

    init(onWake: @escaping () -> Void) { self.onWake = onWake }

    func start(token: String) {
        stop()
        stopped = false
        lastToken = token
        loop = Task { [weak self] in await self?.run(token: token) }
        // System sleep tears the socket down without an error. Reconnect the
        // moment the Mac wakes instead of waiting out a dead receive() or a
        // 30 s backoff, and refetch immediately — mail that arrived during
        // sleep is exactly what the user opens the lid to see.
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.bounce()
                self.onWake()
            }
        }
    }

    func stop() {
        stopped = true
        loop?.cancel(); loop = nil
        task?.cancel(with: .goingAway, reason: nil); task = nil
        if let observer = wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            wakeObserver = nil
        }
    }

    /// Tear down the current socket and reconnect NOW with a fresh backoff.
    private func bounce() {
        guard !stopped, let token = lastToken else { return }
        loop?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        loop = Task { [weak self] in await self?.run(token: token) }
    }

    /// Connect → receive until the socket errors → back off → reconnect, until
    /// `stop()` (or this loop is replaced by `bounce()` — the cancellation
    /// checks are what keep a superseded loop from racing the new one).
    /// A healthy message resets the backoff.
    private func run(token: String) async {
        guard let url = Self.wsURL() else {
            Log.net.error("realtime: could not build ws url")
            return
        }
        var backoff: Double = 1
        while !stopped, !Task.isCancelled {
            // JWT via the Sec-WebSocket-Protocol header, not the URL — keeps the
            // credential out of access logs. The server negotiates the marker back.
            let socket = URLSession.shared.webSocketTask(
                with: url,
                protocols: [Self.authSubprotocol, token]
            )
            task = socket
            socket.resume()
            let heartbeat = heartbeatTask(for: socket)
            do {
                while !stopped {
                    let message = try await socket.receive()
                    // A message received just before `stop()` (sign-out) or
                    // `bounce()` resumes here afterwards: it is not delivered.
                    if stopped || Task.isCancelled { break }
                    backoff = 1
                    if Self.isWake(message) { onWake() }
                }
            } catch {
                if stopped || Task.isCancelled { heartbeat.cancel(); return }
                Log.net.debug("realtime disconnected: \(String(describing: error), privacy: .private)")
            }
            heartbeat.cancel()
            if stopped || Task.isCancelled { return }
            try? await Task.sleep(for: .seconds(min(backoff, Self.maxBackoff)))
            backoff = Self.nextBackoff(backoff)
        }
    }

    /// Ping every `pingIntervalSeconds`; a missing/failed pong within
    /// `pongTimeoutSeconds` declares the socket half-open and cancels it,
    /// which makes the blocked `receive()` throw and the run loop reconnect.
    private func heartbeatTask(for socket: URLSessionWebSocketTask) -> Task<Void, Never> {
        Task { [weak socket] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.pingIntervalSeconds))
                guard let socket, !Task.isCancelled else { return }
                let alive = await Self.pongReceived(socket, within: Self.pongTimeoutSeconds)
                if Task.isCancelled { return }
                if !alive {
                    Log.net.debug("realtime heartbeat missed — recycling the socket")
                    socket.cancel(with: .goingAway, reason: nil)
                    return
                }
            }
        }
    }

    /// True when the socket answers a ping within `timeout`. Polled in half-
    /// second steps; the pong handler may fire late (or never) on a dead
    /// socket, so a locked one-way flag keeps the race harmless. A cancelled
    /// probe reports alive — cancellation must never kill the socket.
    private static func pongReceived(
        _ socket: URLSessionWebSocketTask, within timeout: Double
    ) async -> Bool {
        let box = PongBox()
        socket.sendPing { error in
            if error == nil { box.mark() }
        }
        let steps = max(1, Int((timeout / 0.5).rounded(.up)))
        for _ in 0..<steps {
            try? await Task.sleep(for: .seconds(0.5))
            if box.isMarked { return true }
            if Task.isCancelled { return true }
        }
        return box.isMarked
    }

    /// Exponential backoff step, capped. Pure for the harness.
    nonisolated static func nextBackoff(_ current: Double) -> Double {
        min(current * 2, maxBackoff)
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

/// Thread-safe one-way flag for the pong race (URLSession's callback queue
/// writes, the probe loop reads). Pure enough for the harness.
final class PongBox: @unchecked Sendable {
    private let lock = NSLock()
    private var marked = false

    func mark() {
        lock.lock()
        marked = true
        lock.unlock()
    }

    var isMarked: Bool {
        lock.lock()
        defer { lock.unlock() }
        return marked
    }
}
