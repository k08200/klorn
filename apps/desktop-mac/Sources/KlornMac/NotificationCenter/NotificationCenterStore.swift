import Foundation
import Observation

/// The bell's state (NC2-A): the rows from GET /api/notifications, the
/// alert channels for the footer, and whether the panel is open.
///
/// Refreshes on session start, when the panel opens, on the realtime wake
/// (`AppModel.realtimeDidWake`) and every 60 s while the panel is open —
/// never on a timer while it is closed. Read marks are optimistic and roll
/// back when the server refuses. Sends nothing else: no reply, approve or
/// send path lives here.
///
/// Session hygiene, as `FilesStore`: `reset()` bumps `generation`; an
/// answer for an older generation writes nothing.
@MainActor
@Observable
final class NotificationCenterStore {
    enum Phase: Equatable, Sendable {
        case idle, loading, loaded, failed
    }

    /// GET limit: the panel shows the latest 50.
    nonisolated static let listPath = "/api/notifications?limit=50"
    nonisolated static let healthPath = "/api/notifications/alert-endpoints/health"
    nonisolated static let refreshSeconds = 60

    private let api: APIClient
    private(set) var rows: [NotificationWire] = []
    private(set) var phase: Phase = .idle
    /// The footer's channels; nil until the health read answers.
    private(set) var channels: AlertChannelHealth?
    /// Where each row was delivered, by row id, read lazily
    /// (`loadDelivery`). A 404 or any failure caches "unknown" (empty), so a
    /// row asks once per session.
    private(set) var delivery: [String: [String]] = [:]
    /// The day's interrupt budget from the list (`{used, limit}`); nil when
    /// the server sent none (only v3 users with a budget get one).
    private(set) var budget: NotificationBudget?
    /// Set only by a 404 that proves the delivery route itself is missing
    /// (`DeliveryFailure.classify`); then no row asks again this session.
    private(set) var deliveryRouteMissing = false
    /// The floating panel. Opening refreshes and starts the 60 s timer;
    /// closing stops it.
    var panelOpen = false {
        didSet {
            guard panelOpen != oldValue else { return }
            panelOpen ? didOpen() : stopTimer()
        }
    }

    /// Harness seams: the cadence, and whether a timer runs at all.
    @ObservationIgnored var refreshInterval: Duration = .seconds(NotificationCenterStore.refreshSeconds)
    @ObservationIgnored var runsTimer = true
    /// Off for render fixtures: nothing reaches a server.
    @ObservationIgnored var usesNetwork = true
    /// Called after a 401: the session is gone (`AppModel.sessionRejected`).
    @ObservationIgnored var onUnauthorized: (() -> Void)?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var inFlight = false

    init(api: APIClient) {
        self.api = api
    }

    var badgeCount: Int { NotificationFeedRules.badgeCount(rows) }
    var hasUnread: Bool { rows.contains { !$0.isRead } }
    var isTimerRunning: Bool { timer != nil }

    // MARK: Loading

    /// Fetch the rows and the channels. A refresh already in flight absorbs
    /// a second request (a realtime burst).
    func refresh() async {
        guard usesNetwork, !inFlight else { return }
        inFlight = true
        defer { inFlight = false }
        let started = generation
        if rows.isEmpty { phase = .loading }
        async let list: Result<NotificationsResponse, Error> = fetch(Self.listPath)
        async let health: Result<AlertChannelHealth, Error> = fetch(Self.healthPath)
        let (listResult, healthResult) = await (list, health)
        guard started == generation else { return }
        switch listResult {
        case .success(let response):
            rows = response.notifications
            budget = response.budget
            phase = .loaded
        case .failure(let error):
            handle(error)
            // A failed refresh keeps the rows on screen.
            if rows.isEmpty { phase = .failed }
        }
        if case .success(let value) = healthResult { channels = value }
    }

    private func fetch<T: Decodable & Sendable>(_ path: String) async -> Result<T, Error> {
        do { return .success(try await api.get(path)) } catch { return .failure(error) }
    }

    private func handle(_ error: Error) {
        if case APIError.unauthorized = error { onUnauthorized?() }
        Log.net.error("notifications: \(String(describing: error), privacy: .public)")
    }

    /// The realtime wake: the badge follows a new row without waiting.
    func nudge() {
        Task { await refresh() }
    }

    /// The bell row about this mail (`sourceEmailId` = the mail's EmailMessage
    /// id), newest first, from memory only. Banners read its verified quote.
    func row(forEmail emailId: String?) -> NotificationWire? {
        guard let emailId, !emailId.isEmpty else { return nil }
        return rows.first { $0.sourceEmailId == emailId }
    }

    /// GET /api/notifications/:id/delivery for a row on screen, once. A 404
    /// disables only that row (it is not the caller's, or was deleted after
    /// the list loaded); only a proven missing route stops every row.
    func loadDelivery(_ id: String) async {
        guard usesNetwork, !deliveryRouteMissing, delivery[id] == nil else { return }
        let started = generation
        delivery[id] = []
        let result: Result<NotificationDelivery, Error> = await fetch(Self.deliveryPath(id))
        guard started == generation else { return }
        switch result {
        case .success(let value): delivery[id] = value.channels
        case .failure(let error):
            switch DeliveryFailure.classify(error) {
            case .routeMissing: deliveryRouteMissing = true
            case .rowGone: return  // this row stays empty; the others still ask
            case .unauthorized: onUnauthorized?()
            case .other: Log.net.error("notification delivery: \(String(describing: error), privacy: .public)")
            }
        }
    }

    nonisolated static func deliveryPath(_ id: String) -> String { "/api/notifications/\(pathId(id))/delivery" }
    nonisolated static func readPath(_ id: String) -> String { "/api/notifications/\(pathId(id))/read" }

    /// A row id as one path segment (server ids are uuids; anything else is
    /// escaped, never allowed to add a segment).
    nonisolated static func pathId(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(["-"])) ?? ""
    }

    /// The row's channels: the list's own field when sent, else the lazy read.
    func deliveredTo(_ row: NotificationWire) -> [String] {
        row.deliveredTo.isEmpty ? (delivery[row.id] ?? []) : row.deliveredTo
    }

    // MARK: Read marks

    /// PATCH /api/notifications/:id/read, optimistic.
    func markRead(_ id: String) async {
        guard let index = rows.firstIndex(where: { $0.id == id }), !rows[index].isRead else { return }
        let started = generation
        rows = rows.map { $0.id == id ? $0.markedRead() : $0 }
        guard usesNetwork else { return }
        do {
            try await api.patch(Self.readPath(id), json: [:])
        } catch {
            guard started == generation else { return }
            handle(error)
            await refresh()
        }
    }

    /// PATCH /api/notifications/read-all, optimistic.
    func markAllRead() async {
        guard hasUnread else { return }
        let started = generation
        rows = rows.map { $0.isRead ? $0 : $0.markedRead() }
        guard usesNetwork else { return }
        do {
            try await api.patch("/api/notifications/read-all", json: [:])
        } catch {
            guard started == generation else { return }
            handle(error)
            await refresh()
        }
    }

    // MARK: Timer

    private func didOpen() {
        Task { await refresh() }
        guard runsTimer, timer == nil else { return }
        let started = generation
        timer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: self?.refreshInterval ?? .seconds(Self.refreshSeconds))
                guard !Task.isCancelled, let self, self.generation == started, self.panelOpen else { break }
                await self.refresh()
            }
        }
    }

    private func stopTimer() {
        timer?.cancel()
        timer = nil
    }

    // MARK: Session

    /// Everything the leaving account fetched; in-flight answers are dropped.
    func reset() {
        generation += 1
        stopTimer()
        panelOpen = false
        rows = []
        phase = .idle
        channels = nil
        delivery = [:]
        budget = nil
        deliveryRouteMissing = false
        inFlight = false
    }

    /// Render seam: fixture rows and channels, no network.
    func seedForRender(
        rows: [NotificationWire], channels: AlertChannelHealth?, delivery: [String: [String]] = [:],
        budget: NotificationBudget? = nil
    ) {
        self.rows = rows
        self.budget = budget
        self.delivery = delivery
        usesNetwork = false
        runsTimer = false
        self.channels = channels
        phase = .loaded
    }
}

/// What a failed delivery read means. Only Fastify's default not-found answer
/// ("Route GET:/api/... not found", sent when no route matches) proves the
/// route is missing; the route's own 404 ("Notification not found": not the
/// caller's row, or deleted after the list loaded) and any other 404 concern
/// that one row. Pure.
enum DeliveryFailure: Equatable {
    case routeMissing, rowGone, unauthorized, other

    static func classify(_ error: Error) -> DeliveryFailure {
        switch error {
        case APIError.http(404, let message): isRouteMissingMessage(message) ? .routeMissing : .rowGone
        case APIError.unauthorized: .unauthorized
        default: .other
        }
    }

    static func isRouteMissingMessage(_ message: String?) -> Bool {
        guard let message else { return false }
        return message.range(of: #"^Route [A-Z]+:\S+ not found$"#, options: .regularExpression) != nil
    }
}
