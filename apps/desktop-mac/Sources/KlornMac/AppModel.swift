import Foundation
import Observation

/// App-wide state. @MainActor + @Observable: all UI reads/writes happen on the
/// main actor, and SwiftUI views observe changes automatically.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case signedOut
        case signingIn
        case signedIn
    }

    private(set) var phase: Phase
    var signInError: String?
    private(set) var queue: FirewallResponse?
    private(set) var loadError: String?
    private(set) var isLoadingQueue = false

    /// Called with newly-arrived PUSH items (never the first-load baseline).
    /// The AppDelegate wires this to the HUD; if unset, PUSH surfacing is a no-op.
    var onNewPush: (([FirewallItem]) -> Void)?

    /// User preferences (persisted). Observed by the Preferences panel and read
    /// by the controller before posting an OS banner.
    let settings = AppSettings()

    /// Drives the Preferences overlay in the full view.
    var showPreferences = false

    // Reading pane (full view): the selected row + its loaded email content.
    private(set) var selectedItemId: String?
    private(set) var openedEmail: EmailDetail?
    private(set) var isLoadingEmail = false
    private(set) var emailError: String?
    private(set) var replyError: String?

    /// Refresh cadence so new PUSH mail surfaces a notification even with the
    /// window closed (also keeps the free-tier API warm).
    static let pollIntervalSeconds: Double = 60
    private var seenPush: Set<String> = []
    /// AttentionItem ids the user dismissed locally; hidden until the server's
    /// async reconcile drops them from the queue (then pruned here).
    private var dismissed: Set<String> = []
    private var baselineEstablished = false
    private var didRequestNotifyAuth = false
    private var pollTask: Task<Void, Never>?
    private var realtime: RealtimeClient?

    private let api: APIClient

    init(api: APIClient = APIClient()) {
        self.api = api
        self.phase = KeychainStore.load() != nil ? .signedIn : .signedOut
    }

    /// Kick off the headless lifecycle at app launch. With no window driving it,
    /// this is what starts the background poll loop when we already hold a token.
    /// `loadQueue()` -> `ensureActive()` establishes the silent PUSH baseline and
    /// starts polling; idempotent, so calling it once on launch is enough.
    func start() {
        guard phase == .signedIn else { return }
        Task { await loadQueue() }
    }

    func signIn() async {
        phase = .signingIn
        signInError = nil
        switch await GoogleSignIn.run(api: api) {
        case .success(let token):
            if !KeychainStore.save(token) {
                Log.app.warning("Keychain save denied (unsigned dev build?) — token kept in memory for this session only")
            }
            phase = .signedIn
            await loadQueue()
        case .failure(let reason, let detail):
            Log.app.error("sign-in failed: \(reason.rawValue, privacy: .public) \(detail, privacy: .private)")
            if reason != .cancelled { signInError = Self.message(reason) }
            phase = .signedOut
        }
    }

    /// Select a row in the full view and load its email into the reading pane.
    /// Clicking works in the non-focus-stealing panel (mouse events are delivered),
    /// so reading needs no focus change — only replying (later) does.
    func select(_ item: FirewallItem) async {
        selectedItemId = item.id
        emailError = nil
        guard let emailDbId = item.email?.emailDbId else {
            openedEmail = nil  // non-email item: nothing to read in-app
            return
        }
        openedEmail = nil
        isLoadingEmail = true
        defer { isLoadingEmail = false }
        do {
            openedEmail = try await api.get(
                "/api/email/\(emailDbId)?markRead=true", as: EmailDetail.self)
        } catch APIError.unauthorized {
            signOut()
        } catch {
            emailError = Self.describe(error)
        }
    }

    func clearSelection() {
        selectedItemId = nil
        openedEmail = nil
        emailError = nil
        replyError = nil
    }

    private(set) var isDrafting = false

    /// Ask Klorn's AI to write a reply draft for this email (POST
    /// /api/email/:id/reply-draft). Returns the drafted body to prefill the
    /// composer — the user still reviews and sends (approval-before-action).
    func draftReply(_ item: FirewallItem) async -> String? {
        guard let emailDbId = item.email?.emailDbId else { return nil }
        struct Draft: Decodable { let body: String? }
        isDrafting = true
        defer { isDrafting = false }
        replyError = nil
        do {
            let draft: Draft = try await api.post("/api/email/\(emailDbId)/reply-draft", json: [:], as: Draft.self)
            return draft.body
        } catch APIError.unauthorized {
            signOut()
            return nil
        } catch APIError.forbidden {
            replyError = "AI reply drafts need Klorn Pro."
            return nil
        } catch {
            replyError = Self.describe(error)
            return nil
        }
    }

    /// Outcome of fetching the 3 quick-reply drafts for the PushCard. Its own
    /// type (not replyError) because the card owns its state independently of
    /// the reading pane.
    enum ReplyOptionsFetch: Sendable {
        case ready(ReplyOptionsResponse)
        case needsPro
        case failed(String)
    }

    /// Fetch the 3 tone-differentiated drafts for a PUSH item's card
    /// (POST /api/email/:id/reply-options). 403 = free tier → the card shows
    /// its Pro hint instead of an error.
    func fetchReplyOptions(_ item: FirewallItem) async -> ReplyOptionsFetch {
        guard let emailDbId = item.email?.emailDbId else {
            return .failed("Quick replies only work for email items.")
        }
        do {
            let options: ReplyOptionsResponse = try await api.post(
                "/api/email/\(emailDbId)/reply-options", json: [:], as: ReplyOptionsResponse.self)
            return .ready(options)
        } catch APIError.unauthorized {
            signOut()
            return .failed("Session expired. Please sign in again.")
        } catch APIError.forbidden {
            return .needsPro
        } catch {
            return .failed(Self.describe(error))
        }
    }

    /// Load an email's detail for the card's expanded view — Klorn's AI summary
    /// lives there, not on the firewall wire. Plain GET, never `markRead`: an
    /// unattended card must not silently mark mail as read. Best-effort — the
    /// expanded view falls back to the snippet when this returns nil.
    func fetchEmailDetail(_ item: FirewallItem) async -> EmailDetail? {
        guard let emailDbId = item.email?.emailDbId else { return nil }
        do {
            return try await api.get("/api/email/\(emailDbId)", as: EmailDetail.self)
        } catch {
            Log.app.debug("card detail fetch failed: \(String(describing: error), privacy: .private)")
            return nil
        }
    }

    /// Send a threaded reply to an email's sender (POST /api/email/:id/reply).
    /// Returns nil on success or a user-facing error message. Deliberately does
    /// NOT touch the shared `replyError` slot: the PushCard and the reading-pane
    /// composer can both be mid-send for DIFFERENT emails at once, and a shared
    /// slot would let one surface clear or overwrite the other's live error.
    /// A 403 means the account isn't entitled (Pro) — surfaced, NOT a sign-out.
    func sendReply(_ item: FirewallItem, body: String) async -> String? {
        guard let emailDbId = item.email?.emailDbId,
              !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return "Nothing to send." }
        do {
            try await api.post("/api/email/\(emailDbId)/reply", json: ["body": body])
            return nil
        } catch APIError.unauthorized {
            signOut()
            return "Session expired. Please sign in again."
        } catch APIError.forbidden {
            return "Replying from the app needs Klorn Pro."
        } catch {
            return Self.describe(error)
        }
    }

    /// Reading-pane composer wrapper: same send, but publishes the outcome to
    /// the live-bound `replyError` the full view renders. Returns true on success.
    func reply(_ item: FirewallItem, body: String) async -> Bool {
        replyError = nil
        let error = await sendReply(item, body: body)
        replyError = error
        return error == nil
    }

    /// Dismiss a PUSH item: clear it from the firewall queue (status DISMISSED,
    /// leaves the source email in Gmail) and hide it immediately (optimistic).
    /// Works for any source. On failure, un-hide and refetch the truth.
    func dismiss(_ item: FirewallItem) async {
        hideLocally(item)
        do {
            try await api.post("/api/inbox/firewall/\(item.id)/dismiss")
        } catch APIError.unauthorized {
            signOut()
        } catch {
            unhide(item, error)
        }
    }

    /// Snooze a PUSH item until `until`; it resurfaces server-side when the time
    /// passes. Works for any source (uses the AttentionItem id, not the email id).
    func snooze(_ item: FirewallItem, until: Date = AppModel.tomorrow9am()) async {
        hideLocally(item)
        do {
            try await api.post(
                "/api/inbox/firewall/\(item.id)/snooze",
                json: ["snoozeUntil": ISO8601DateFormatter().string(from: until)])
        } catch APIError.unauthorized {
            signOut()
        } catch {
            unhide(item, error)
        }
    }

    /// Optimistically drop an item from the visible queue + counts; keep it hidden
    /// across reloads until the server resolves/snoozes it (then pruned in loadQueue).
    private func hideLocally(_ item: FirewallItem) {
        dismissed.insert(item.id)
        queue = queue?.removingIDs([item.id])
        if selectedItemId == item.id { clearSelection() }
    }

    /// Undo an optimistic hide when the mutation failed, then refetch the truth.
    private func unhide(_ item: FirewallItem, _ error: Error) {
        dismissed.remove(item.id)
        loadError = Self.describe(error)
        Task { await loadQueue() }
    }

    /// Default snooze target: 9am local tomorrow. Pure for testing. Delegates to
    /// `SnoozeOption` so the resurface math lives in one place.
    nonisolated static func tomorrow9am(from now: Date = Date(), calendar: Calendar = .current) -> Date {
        SnoozeOption.tomorrow.resurface(from: now, calendar: calendar)
    }

    func signOut() {
        stopPolling()
        realtime?.stop()
        realtime = nil
        seenPush = []
        dismissed = []
        clearSelection()
        baselineEstablished = false
        didRequestNotifyAuth = false
        KeychainStore.clear()
        queue = nil
        loadError = nil
        phase = .signedOut
    }

    /// Today's calendar (expanded panel's TODAY column). Best-effort: a
    /// calendar hiccup must never block the mail queue, so failures just keep
    /// the previous value.
    private(set) var today: TodaySummary?

    /// Meeting-prep interrupt: fires once per event when its start enters the
    /// lead window. The AppDelegate wires this to the meeting card; a false
    /// return means "slot busy — offer it again on the next tick".
    var onMeetingSoon: ((CalendarEventWire) -> Bool)?
    static let meetingLeadMinutes = 10
    private var shownMeetingIds: Set<String> = []

    private func refreshToday() async {
        do {
            today = try await api.get("/api/calendar/today/summary", as: TodaySummary.self)
        } catch {
            Log.app.debug("today summary fetch failed: \(String(describing: error), privacy: .private)")
        }
        // Replan on every refresh tick (poll + WS wake — the same cadence that
        // keeps the TODAY column fresh keeps the lead window honest).
        if let upcoming = today?.upcoming,
           let due = meetingCardPlan(
               now: Date(), events: upcoming,
               leadMinutes: Self.meetingLeadMinutes, shown: shownMeetingIds),
           onMeetingSoon?(due) == true
        {
            shownMeetingIds.insert(due.id)
        }
    }

    /// Daily AI quota for the ACCOUNT gauge. Best-effort on the same tick.
    private(set) var usage: BillingStatusWire.Usage?

    private func refreshUsage() async {
        do {
            let status: BillingStatusWire = try await api.get("/api/billing/models", as: BillingStatusWire.self)
            usage = status.usage
        } catch {
            Log.app.debug("usage fetch failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// GET /api/calendar/:id/prep-pack for the meeting card. Best-effort.
    func fetchPrepPack(eventId: String) async -> MeetingPrepPack? {
        do {
            return try await api.get("/api/calendar/\(eventId)/prep-pack", as: MeetingPrepPack.self)
        } catch {
            Log.app.debug("prep pack fetch failed: \(String(describing: error), privacy: .private)")
            return nil
        }
    }

    func loadQueue() async {
        isLoadingQueue = true
        defer { isLoadingQueue = false }
        // Piggyback on the same cadence as the queue (poll + WS wake) without
        // serializing the fetches.
        Task { await refreshToday() }
        Task { await refreshUsage() }
        do {
            let fetched = try await api.get("/api/inbox/firewall", as: FirewallResponse.self)
            // Drop dismissed ids the server has since resolved; hide the rest.
            dismissed.formIntersection(fetched.allItemIDs)
            queue = fetched.removingIDs(dismissed)
            loadError = nil
            reconcilePush()
            ensureActive()
        } catch APIError.unauthorized {
            signOut()  // token expired/invalid — drop to sign-in
        } catch {
            loadError = Self.describe(error)
        }
    }

    /// Surface PUSH items new since the last load (the first load is a silent
    /// baseline). Routed to `onNewPush` (the HUD); the HUD falls back to an OS
    /// banner when it can't draw a panel.
    private func reconcilePush() {
        guard let queue else { return }
        let plan = planPushNotifications(
            seen: seenPush,
            baselineEstablished: baselineEstablished,
            pushItems: queue.items(for: .push))
        if !plan.toNotify.isEmpty { onNewPush?(plan.toNotify) }
        seenPush = plan.seen
        baselineEstablished = true
    }

    /// Once signed in: request notification permission (once) and start the
    /// background refresh loop. Idempotent.
    private func ensureActive() {
        guard phase == .signedIn else { return }
        if !didRequestNotifyAuth {
            didRequestNotifyAuth = true
            Task { await PushNotifier.requestAuthorization() }
        }
        if pollTask == nil { startPolling() }
        startRealtime()
    }

    /// Open the WebSocket wake channel once signed in. On a server push it
    /// refetches immediately; the poll loop remains the backstop. Idempotent.
    private func startRealtime() {
        guard realtime == nil, let token = KeychainStore.load() else { return }
        let client = RealtimeClient(onWake: { [weak self] in
            // Skip if a load is already in flight — avoids overlapping refetches
            // if the server bursts events.
            guard let self, !self.isLoadingQueue else { return }
            Task { await self.loadQueue() }
        })
        client.start(token: token)
        realtime = client
    }

    private func startPolling() {
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(AppModel.pollIntervalSeconds))
                if Task.isCancelled { break }
                await self?.loadQueue()
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private static func message(_ reason: SignInFailure) -> String {
        switch reason {
        case .nonceFailed: "Couldn't reach Klorn to start sign-in. Check the API and try again."
        case .invalidNonce: "The sign-in session wasn't recognized. Please try again."
        case .expired: "Sign-in took too long and expired. Please try again."
        case .timeout: "Timed out waiting for the browser. Finish sign-in there, then retry."
        case .cancelled: "Sign-in was cancelled."
        }
    }

    /// User-facing message only — the raw error (which can echo response bytes
    /// or internal shape) is logged privately, never surfaced.
    private static func describe(_ error: Error) -> String {
        Log.app.error("queue load failed: \(String(describing: error), privacy: .private)")
        switch error {
        case APIError.http(let code, let msg): return msg ?? "Server error (\(code))."
        case APIError.transport: return "Network error — check your connection."
        case APIError.decoding: return "Unexpected response from the server."
        case APIError.unauthorized: return "Session expired. Please sign in again."
        case APIError.forbidden: return "This action needs Klorn Pro."
        default: return "Something went wrong."
        }
    }
}
