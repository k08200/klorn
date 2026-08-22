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

    /// Drives the tier explainer. Set on first run and by the sidebar's
    /// "How sorting works", which is what keeps it re-readable.
    var showTierGuide = false

    /// Close the guide and remember it was seen. Dismissing IS the
    /// acknowledgement — a separate "don't show again" would be a second
    /// decision about a screen the user has already finished with.
    func dismissTierGuide() {
        showTierGuide = false
        GuideSeen.value = true
    }

    /// Offer the guide once, after sign-in has actually produced a mailbox to
    /// explain. Called when the full view appears.
    func presentTierGuideIfFirstRun() {
        if GuideSeen.shouldPresent(seen: GuideSeen.value, signedIn: phase == .signedIn) {
            showTierGuide = true
        }
    }

    /// What the full view's list column shows. Model state rather than view
    /// state so any surface can open the full view already pointed at the right
    /// thing — a tier count in the compact panel, or an urgent-mail card.
    var listMode: ListMode = .tier(.push)

    /// Open the full view on `tier`, and clear any reading-pane selection so the
    /// pane doesn't keep showing a message from the tier the user just left.
    func showTier(_ tier: Tier) {
        listMode = .tier(tier)
        clearSelection()
    }

    // Reading pane (full view): the selected row + its loaded email content.
    private(set) var selectedItemId: String?
    private(set) var openedEmail: EmailDetail?
    /// Calendar cross-reference for the opened meeting email (nil while
    /// loading, for non-meeting mail, or when the server has nothing).
    private(set) var meetingContext: MeetingContextWire?
    /// Relationship context for the opened mail's sender (nil while loading
    /// or when there is no history/provider).
    private(set) var senderDossier: SenderDossierWire?
    private(set) var threadBrief: ThreadBriefWire?
    private(set) var isLoadingEmail = false
    private(set) var emailError: String?
    private(set) var replyError: String?
    /// On-demand deep re-summary ("AI 정리") in flight / failed for the pane.
    private(set) var isSummarizing = false
    private(set) var summarizeFailed = false

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
    /// Error from the last add-account attempt; cleared on the next attempt.
    private(set) var linkAccountError: String?
    private var isLinkingAccount = false
    /// Bounded watcher that picks up the newly linked inbox after the browser
    /// handoff, without waiting for the 60 s poll tick.
    private var linkWatchTask: Task<Void, Never>?

    private let api: APIClient

    init(api: APIClient = APIClient()) {
        self.api = api
        self.phase = KeychainStore.load() != nil ? .signedIn : .signedOut
        self.selectedInbox =
            UserDefaults.standard.string(forKey: Self.selectedInboxKey) ?? "all"
    }

    // MARK: Multi-inbox

    /// The user's mailboxes (primary + linked). The selector renders at 2+;
    /// every mail-list fetch is scoped by `selectedInbox` (doctrine: never
    /// assume the primary account).
    private(set) var inboxes: [InboxOption] = []
    /// Server-enabled login providers (GET /api/auth/providers, unauthed).
    /// Defaults to ["google"] so the UI works before/without the fetch.
    private(set) var loginProviders: [String] = ["google"]

    func refreshLoginProviders() async {
        struct Row: Codable { let id: String }
        struct Providers: Codable { let providers: [Row] }
        if let resp = try? await api.get("/api/auth/providers", authed: false, as: Providers.self),
           !resp.providers.isEmpty
        {
            loginProviders = resp.providers.map(\.id)
        }
    }
    // MARK: Teams (team mode P1)

    /// The user's saved teams for team-availability questions.
    private(set) var teams: [TeamWire] = []
    private(set) var teamError: String?
    /// False when the server answers 403 TEAM_REQUIRED — team mode is a paid
    /// team-tier capability shipped dark; every team surface hides.
    private(set) var teamModeAvailable = false

    func refreshTeams() async {
        struct Resp: Codable { let teams: [TeamWire] }
        do {
            let resp = try await api.get("/api/teams", as: Resp.self)
            teams = resp.teams
            teamModeAvailable = true
        } catch APIError.forbidden {
            teamModeAvailable = false
        } catch {
            // Transient failure — keep the last known availability.
        }
    }

    func createTeam(name: String, membersText: String) async {
        teamError = nil
        let members = membersText
            .split(whereSeparator: { $0 == "," || $0 == "\n" || $0 == " " })
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { !$0.isEmpty }
        struct Body: Encodable { let name: String; let members: [String] }
        do {
            try await api.post("/api/teams", encodable: Body(name: name, members: members))
            await refreshTeams()
        } catch {
            teamError = L("teams.saveFailed")
            Log.app.error("team create failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Availability for the dedicated team screen. Window = now → +3 days;
    /// anchored client-side because "when can we meet" means from now.
    private(set) var teamAvailability: TeamAvailabilityWire?
    private(set) var checkingTeamId: String?
    /// One-shot outcome line after booking a team meeting (cleared on next check).
    private(set) var teamBookingResult: String?

    func checkTeamAvailability(teamId: String, durationMinutes: Int) async {
        checkingTeamId = teamId
        teamAvailability = nil
        teamBookingResult = nil
        defer { checkingTeamId = nil }
        let fmt = ISO8601DateFormatter()
        let start = fmt.string(from: Date())
        let end = fmt.string(from: Date().addingTimeInterval(3 * 24 * 3600))
        let path = "/api/teams/\(teamId)/availability?window_start=\(start)&window_end=\(end)&duration_minutes=\(durationMinutes)"
        teamAvailability = try? await api.get(path, as: TeamAvailabilityWire.self)
    }

    /// Book a team meeting from a chosen slot. This IS the approval: the
    /// screen shows the invitee list on the button, and this call posts to
    /// the human-approval endpoint that sends the invitations.
    func bookTeamMeeting(title: String, slot: TeamAvailabilityWire.Slot, members: [String]) async -> Bool {
        struct Body: Encodable {
            let title: String
            let startTime: String
            let endTime: String
            let attendees: [String]
        }
        do {
            try await api.post(
                "/api/calendar",
                encodable: Body(
                    title: title, startTime: slot.startTime, endTime: slot.endTime,
                    attendees: members))
            teamBookingResult = L("teams.booked")
            Task { await refreshToday() }
            return true
        } catch {
            teamBookingResult = L("teams.bookFailed")
            Log.app.error("team booking failed: \(String(describing: error), privacy: .private)")
            return false
        }
    }

    func deleteTeam(id: String) async {
        try? await api.delete("/api/teams/\(id)")
        await refreshTeams()
    }

    /// Naver IMAP mailboxes, fetched from the ungated status endpoint so the
    /// account list is complete even while the provider selector flag is off.
    private(set) var imapAccounts: [ImapAccount] = []
    private(set) var imapError: String?
    private(set) var isConnectingImap = false

    /// Selector value: "all" | "primary" | a linked inbox id. Persisted so the
    /// scope survives relaunch (klorn.-prefixed defaults key — required).
    private(set) var selectedInbox: String
    static let selectedInboxKey = "klorn.selectedInbox"

    /// Change the per-inbox scope and persist it. The list view's task keys on
    /// this value, so an active search re-fetches with the new scope; the tier
    /// list is fetched imperatively, so reload the queue too (loadQueue scopes
    /// the firewall fetch via firewallPath). The "all" fallback in
    /// refreshInboxes can't loop: with "all" selected firewallPath's guard
    /// fails and the stale-id branch never fires again.
    /// Last-known queue per inbox selection — stale-while-revalidate so an
    /// inbox switch paints instantly from the previous fetch instead of
    /// blanking for a full server round trip (founder: "숫자 갈림 좀 느림",
    /// 2026-07-23). Session-scoped by design: repainted by every loadQueue.
    private var queueCache: [String: FirewallResponse] = [:]

    func selectInbox(_ value: String) {
        guard value != selectedInbox else { return }
        selectedInbox = value
        UserDefaults.standard.set(value, forKey: Self.selectedInboxKey)
        // Paint the cached snapshot for this inbox immediately (if any), then
        // revalidate against the server in the background.
        if let cached = queueCache[value] {
            queue = cached.removingIDs(dismissed)
        }
        Task { await loadQueue() }
    }

    /// Refresh the mailbox list (poll + WS cadence, like the other surfaces).
    /// A persisted selection whose linked inbox was since unlinked falls back
    /// to "all" — a stale id would silently scope every list to zero rows.
    private func refreshInboxes() async {
        do {
            let resp = try await api.fetchInboxes()
            inboxes = resp.inboxes
            if let value = inboxQueryParam(selected: selectedInbox), value != "primary",
               !resp.inboxes.contains(where: { $0.id == value })
            {
                selectInbox("all")
            }
        } catch {
            Log.app.debug("inboxes fetch failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Reload the Naver IMAP mailbox list. Silent on failure — the section
    /// simply shows nothing rather than an error the user can't act on.
    func refreshImapAccounts() async {
        do {
            let status = try await api.fetchNaverStatus()
            imapAccounts = status.resolvedAccounts(fallbackEmail: nil)
        } catch {
            Log.app.debug("imap status fetch failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Connect a Naver mailbox. The app password travels straight to the
    /// server (live IMAP verify + enciphered storage) and is never written to
    /// disk here. Returns true when the mailbox was accepted, so the form can
    /// clear its fields on success only.
    func connectNaverInbox(email: String, password: String) async -> Bool {
        guard !isConnectingImap else { return false }
        isConnectingImap = true
        defer { isConnectingImap = false }
        imapError = nil
        do {
            try await api.connectNaver(email: email, password: password)
            await refreshImapAccounts()
            await refreshInboxes()
            await loadQueue()
            return true
        } catch APIError.unauthorized {
            signOut()
            return false
        } catch APIError.forbidden {
            // Entitlement, not a dead session — never sign the user out here.
            imapError = L("error.needsPro")
            return false
        } catch let APIError.http(status, message) {
            // 400 carries the server's real reason (bad app password, host
            // mismatch); 429 is the 5-per-15-minutes connect limit.
            imapError = status == 429 ? L("account.imap.rateLimited") : (message ?? L("account.imap.failed"))
            return false
        } catch {
            imapError = L("account.imap.failed")
            return false
        }
    }

    /// Disconnect ONE Naver mailbox (never the bodyless all-accounts form).
    func disconnectNaverInbox(email: String) async {
        imapError = nil
        do {
            try await api.disconnectNaver(email: email)
            await refreshImapAccounts()
            await refreshInboxes()
        } catch APIError.unauthorized {
            signOut()
        } catch {
            imapError = L("account.imap.disconnectFailed")
        }
    }

    /// "Add Google account": open the Pro-gated link-inbox consent in the
    /// browser, then watch the inbox list so the new account appears quickly.
    func addAccount() async {
        guard !isLinkingAccount else { return }
        isLinkingAccount = true
        defer { isLinkingAccount = false }
        linkAccountError = nil
        switch await LinkInboxFlow.start(api: api) {
        case .success:
            startLinkWatch()
        case .failure(.needsPro):
            linkAccountError = L("error.needsPro")
        case .failure(.unauthorized):
            signOut()
        case .failure(.network):
            linkAccountError = L("account.add.failed")
        }
    }

    /// Reconnect the PRIMARY Google account (full-scope /google/start consent
    /// in the browser) — distinct from addAccount, which links a Pro-gated
    /// SECOND account and cannot revive the primary token.
    func reconnectPrimary() async {
        guard !isLinkingAccount else { return }
        isLinkingAccount = true
        defer { isLinkingAccount = false }
        linkAccountError = nil
        switch await GoogleConnectFlow.start(api: api) {
        case .success:
            startReconnectWatch()
        case .failure(.unauthorized):
            signOut()
        case .failure(.network):
            linkAccountError = L("account.reconnect.failed")
        }
    }

    /// Poll (5 s cadence, 3 min cap) until the PRIMARY row's needsReconnect
    /// clears — a reconnect flips a flag, it never adds an inbox row, so
    /// startLinkWatch's count-grew condition can never fire for it.
    private func startReconnectWatch() {
        linkWatchTask?.cancel()
        linkWatchTask = Task { [weak self] in
            for _ in 0..<36 {
                try? await Task.sleep(for: .seconds(5))
                guard let self, !Task.isCancelled else { return }
                await self.refreshInboxes()
                let primaryDead = self.inboxes.contains {
                    $0.kind == "primary" && $0.needsReconnect
                }
                if !primaryDead {
                    await self.loadQueue()
                    return
                }
            }
        }
    }

    /// Poll the inbox list (5 s cadence, 3 min cap) until the link lands —
    /// then pull the merged queue right away. Cancelled on sign-out.
    private func startLinkWatch() {
        linkWatchTask?.cancel()
        let baseline = inboxes.count
        linkWatchTask = Task { [weak self] in
            for _ in 0..<36 {
                try? await Task.sleep(for: .seconds(5))
                guard let self, !Task.isCancelled else { return }
                await self.refreshInboxes()
                if self.inboxes.count > baseline {
                    await self.loadQueue()
                    return
                }
            }
        }
    }

    /// Populate the model from fixture JSON for the offscreen preview renderer
    /// (`--render-previews`). Lives here because the state it fills is
    /// `private(set)`; nothing in the running app calls it, and it performs no
    /// network or disk I/O.
    func seedForPreview(
        firewallJSON: String, emailJSON: String, selectedItemId: String?,
        briefingJSON: String? = nil
    ) {
        phase = .signedIn
        queue = try? JSONDecoder().decode(FirewallResponse.self, from: Data(firewallJSON.utf8))
        openedEmail = try? JSONDecoder().decode(EmailDetail.self, from: Data(emailJSON.utf8))
        self.selectedItemId = selectedItemId
        if let briefingJSON {
            briefingStructure = try? JSONDecoder().decode(
                BriefingStructure.self, from: Data(briefingJSON.utf8))
        }
    }

    /// Kick off the headless lifecycle at app launch. With no window driving it,
    /// this is what starts the background poll loop when we already hold a token.
    /// `loadQueue()` -> `ensureActive()` establishes the silent PUSH baseline and
    /// starts polling; idempotent, so calling it once on launch is enough.
    func start() {
        // Which sign-in buttons to offer — server-driven, fetched once at
        // launch (unauthed; harmless if it fails: Google stays the default).
        Task { await refreshLoginProviders() }
        guard phase == .signedIn else { return }
        Task { await loadQueue() }
        // Team mode availability probe (403 while dark) — decides whether the
        // 팀 sidebar row and screen render at all.
        Task { await refreshTeams() }
    }

    /// The in-flight sign-in, so a re-click SUPERSEDES it instead of racing it.
    private var signInTask: Task<Void, Never>?

    /// Start (or restart) the browser-bounce sign-in.
    ///
    /// Re-clicking is normal: the browser leg can leave the user looking at a
    /// tab that seems stuck. Without superseding, the first attempt keeps
    /// polling a nonce the server has already burned, fails a few seconds
    /// later, and stomps the SECOND attempt's state back to signed-out — the
    /// bar flickering between "Log in" and "Signing in…" (dogfood 2026-08-10).
    func signIn(provider: String = "google") async {
        signInTask?.cancel()
        let task = Task { [weak self] in
            guard let self else { return }
            await self.runSignIn(provider: provider)
        }
        signInTask = task
        await task.value
    }

    private func runSignIn(provider: String = "google") async {
        phase = .signingIn
        signInError = nil
        let result = await GoogleSignIn.run(api: api, provider: provider)
        // A superseded attempt owns none of this state any more.
        guard !Task.isCancelled else { return }
        switch result {
        case .success(let token):
            if !KeychainStore.save(token) {
                Log.app.warning("Keychain save denied (unsigned dev build?) — token kept in memory for this session only")
            }
            // A live socket opened under the PREVIOUS token would 4001-loop
            // forever (RealtimeClient captures its token once), silently
            // degrading realtime to the 60s poll. Re-arm it with the fresh
            // credential; start() tears the old loop down first.
            realtime?.start(token: token)
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
                "/api/email/\(emailDbId)", as: EmailDetail.self)
            // Reading is a side-effect-free GET; marking read is an explicit
            // write. Fire-and-forget: a failed mark-read must not blank the
            // reading pane the user already has.
            Task { try? await api.patch("/api/email/\(emailDbId)/read", json: [:]) }
            loadMeetingContext(for: emailDbId, guardId: item.id)
            loadSenderDossier(for: emailDbId, guardId: item.id)
            loadThreadBrief(for: emailDbId, guardId: item.id)
        } catch APIError.unauthorized {
            signOut()
        } catch {
            emailError = Self.describe(error)
        }
    }

    /// Bytes + MIME type for an inline (cid:) image in the given email, via
    /// the authed API. nil on any failure — the webview shows a transparent
    /// placeholder instead of a broken icon.
    func inlineImage(emailId: String, cid: String) async -> (Data, String)? {
        // The cid is a sender-controlled Content-ID landing in a single path
        // SEGMENT, so `.urlPathAllowed` (which leaves "/" raw) would let a
        // crafted cid rewrite the request path. Alphanumerics-only: every
        // other byte gets percent-encoded and decodes identically server-side.
        guard let encoded = cid.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
              let (data, mime) = try? await api.rawGet("/api/email/\(emailId)/inline/\(encoded)")
        else { return nil }
        return (data, mime ?? "image/png")
    }

    /// Meeting mail only: fetch the calendar cross-reference (proposed slot,
    /// conflict verdict, nearby events) without blocking the pane. The guard
    /// keeps a slow response from painting over a different, newer selection.
    private func loadSenderDossier(for emailDbId: String, guardId: String) {
        senderDossier = nil
        Task {
            let lang = L10n.resolvedCode(override: L10n.override)
            let dossier = try? await api.get(
                "/api/email/\(emailDbId)/sender-dossier?lang=\(lang)", as: SenderDossierWire.self)
            // Empty history answers with an empty summary — nothing to show.
            if selectedItemId == guardId, let dossier, !dossier.summary.isEmpty {
                senderDossier = dossier
            }
        }
    }

    /// Why this person wrote NOW — a whole-thread read (both directions).
    /// Fetching it here is also what warms the server cache the reply drafter
    /// reads, so "AI 답장" on an opened mail costs no extra thread read.
    private func loadThreadBrief(for emailDbId: String, guardId: String) {
        threadBrief = nil
        Task {
            let lang = L10n.resolvedCode(override: L10n.override)
            let response = try? await api.get(
                "/api/email/\(emailDbId)/thread-brief?lang=\(lang)", as: ThreadBriefResponse.self)
            if selectedItemId == guardId, let brief = response?.brief, !brief.whyNow.isEmpty {
                threadBrief = brief
            }
        }
    }

    private func loadMeetingContext(for emailDbId: String, guardId: String) {
        meetingContext = nil
        guard openedEmail?.category == "meeting" else { return }
        Task {
            let context = try? await api.get(
                "/api/email/\(emailDbId)/meeting-context", as: MeetingContextWire.self)
            if selectedItemId == guardId { meetingContext = context }
        }
    }

    func clearSelection() {
        selectedItemId = nil
        threadBrief = nil
        openedEmail = nil
        meetingContext = nil
        senderDossier = nil
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
            replyError = L("error.needsPro")
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
            return .failed(L("reply.emailOnly"))
        }
        do {
            let options: ReplyOptionsResponse = try await api.post(
                "/api/email/\(emailDbId)/reply-options", json: [:], as: ReplyOptionsResponse.self)
            return .ready(options)
        } catch APIError.unauthorized {
            signOut()
            return .failed(L("error.sessionExpired"))
        } catch APIError.forbidden {
            return .needsPro
        } catch {
            return .failed(Self.describe(error))
        }
    }

    /// On-demand deep re-summary of the opened email (reading pane "AI 정리").
    /// The server persists the richer summary/keyPoints/actionItems, so a
    /// re-fetch of the detail is the merge — no client-side struct surgery.
    /// Output language follows the app UI (UI text is en/ko-fixed; only
    /// replies mirror the mail's language).
    func summarizeOpenedEmail() async {
        guard let email = openedEmail, !isSummarizing else { return }
        isSummarizing = true
        summarizeFailed = false
        defer { isSummarizing = false }
        do {
            let lang = L10n.resolvedCode(override: L10n.override)
            try await api.post("/api/email/\(email.id)/summarize", json: ["lang": lang])
        } catch {
            Log.app.error("on-demand summarize failed: \(String(describing: error), privacy: .private)")
            if openedEmail?.id == email.id { summarizeFailed = true }
            return
        }
        // The POST persisted server-side; a refresh failure here must not
        // report "summarize failed" — the pane just keeps the old band until
        // the next open re-fetches it.
        if let updated = try? await api.get("/api/email/\(email.id)", as: EmailDetail.self),
           openedEmail?.id == email.id {
            openedEmail = updated
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

    /// Compose overlay visibility (full view). Preferences wins if both are up.
    var showCompose = false
    /// Draft lives on the MODEL, not the panel: SwiftUI drops a conditionally
    /// mounted view's @State (e.g. when Preferences overlays the composer via
    /// the menu bar), and a draft must survive that. There is exactly one
    /// composer identity, so an orphaned send can never race a "new" session.
    var composeTo = ""
    var composeSubject = ""
    var composeBody = ""
    var composeError: String?
    private(set) var composeSending = false

    /// Send the current draft. Success clears the draft and closes the panel;
    /// failure surfaces composeError and keeps everything for retry.
    func submitCompose() async {
        guard !composeSending else { return }
        composeSending = true
        composeError = nil
        defer { composeSending = false }
        let error = await sendNewEmail(to: composeTo, subject: composeSubject, body: composeBody)
        if let error {
            composeError = error
        } else {
            discardComposeDraft()
            showCompose = false
        }
    }

    /// Explicit discard (the Cancel button). Hiding the panel via ✕/scrim/Esc
    /// deliberately KEEPS the draft — ⌘N reopens where the user left off.
    func discardComposeDraft() {
        composeTo = ""
        composeSubject = ""
        composeBody = ""
        composeError = nil
    }

    /// Send a BRAND-NEW email (POST /api/email/send — Pro-gated server-side).
    /// Returns nil on success or a user-facing error message. Same error
    /// taxonomy as sendReply; a 403 is "needs Pro", never a sign-out.
    func sendNewEmail(to: String, subject: String, body: String) async -> String? {
        let toTrimmed = to.trimmingCharacters(in: .whitespacesAndNewlines)
        let subjectTrimmed = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !toTrimmed.isEmpty, !subjectTrimmed.isEmpty,
              !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return L("compose.missingFields") }
        do {
            try await api.post(
                "/api/email/send",
                json: ["to": toTrimmed, "subject": subjectTrimmed, "body": body])
            return nil
        } catch APIError.unauthorized {
            signOut()
            return L("error.sessionExpired")
        } catch APIError.forbidden {
            return L("compose.needsPro")
        } catch {
            return Self.describe(error)
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
        else { return L("reply.nothingToSend") }
        do {
            try await api.post("/api/email/\(emailDbId)/reply", json: ["body": body])
            return nil
        } catch APIError.unauthorized {
            signOut()
            return L("error.sessionExpired")
        } catch APIError.forbidden {
            return L("reply.needsPro")
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

    /// Confirm an agent-drafted event: POST to the calendar (syncs to Google
    /// server-side), clear the card, and confirm in-thread. Failure keeps the
    /// card so the user can retry, plus a visible failure bubble.
    func createEvent(from draft: EventDraft, messageId: UUID) async {
        struct Body: Encodable {
            let title: String
            let startTime: String
            let endTime: String
            let location: String?
            let attendees: [String]?
        }
        let body = Body(
            title: draft.title, startTime: draft.startTime, endTime: draft.endTime,
            location: draft.location, attendees: draft.attendees)
        do {
            try await api.post("/api/calendar", encodable: body)
            clearEventDraft(messageId)
            chatMessages.append(ChatMessage(
                role: .assistant, text: L("calendar.addedConfirm", eventDraftLabel(draft))))
            Task { await refreshToday() }  // the TODAY column should show it now
        } catch APIError.unauthorized {
            signOut()
        } catch {
            chatMessages.append(ChatMessage(
                role: .failure, text: "Couldn't create the event — \(Self.describe(error))"))
        }
    }

    /// Ignore a drafted event — removes the card, writes nothing.
    func clearEventDraft(_ messageId: UUID) {
        chatMessages = chatMessages.map { message in
            guard message.id == messageId else { return message }
            var cleared = message
            cleared.eventDraft = nil
            return cleared
        }
    }

    // MARK: Agent activity

    /// Today's autonomous-agent receipt (nil until first load). Best-effort.
    private(set) var agentToday: TodayActions?

    func refreshAgentToday() async {
        do {
            agentToday = try await api.get(
                "/api/automations/today-actions", as: TodayActions.self)
        } catch {
            Log.app.debug("agent today fetch failed: \(String(describing: error), privacy: .private)")
        }
    }

    // MARK: Assistant (chat)

    /// In-memory thread for this app session (one conversation, lazily created
    /// server-side on the first send so an unopened Assistant costs nothing).
    /// Floating assistant dock (full view). Session-scoped on purpose: the
    /// dock is a glance surface, not a mode to get stuck in.
    var showAssistantDock = false
    private(set) var chatMessages: [ChatMessage] = []
    private(set) var isChatting = false
    private var chatConversationId: String?

    /// One synchronous agent turn: optimistic user bubble → POST → assistant
    /// bubble. A failed turn becomes a visible failure bubble — never silent.
    func sendChat(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSendChat(trimmed, busy: isChatting) else { return }
        chatMessages.append(ChatMessage(role: .user, text: trimmed))
        isChatting = true
        defer { isChatting = false }
        do {
            if chatConversationId == nil {
                let conv: ChatConversation = try await api.post(
                    "/api/chat/conversations", json: [:], as: ChatConversation.self)
                chatConversationId = conv.id
            }
            guard let convId = chatConversationId else { return }
            // Tell the server what the user is looking at, so "이 메일 어떻게
            // 답장하지" resolves to the open mail instead of a tool guess.
            let turn: ChatTurnResponse = try await api.post(
                "/api/chat/conversations/\(convId)/messages",
                encodable: ChatTurnRequest(
                    text: trimmed,
                    context: openedEmail.map { ChatTurnRequest.Context(emailId: $0.id) }),
                as: ChatTurnResponse.self)
            chatMessages.append(
                ChatMessage(role: .assistant, text: turn.reply, eventDraft: turn.eventDraft))
            if let error = turn.error {
                chatMessages.append(ChatMessage(role: .failure, text: error))
            }
        } catch APIError.unauthorized {
            signOut()
        } catch {
            chatMessages.append(ChatMessage(
                role: .failure, text: "Couldn't reach Klorn — \(Self.describe(error))"))
        }
    }

    // MARK: Commitments

    /// OPEN commitments (nil until first load). Best-effort like today/usage.
    private(set) var commitments: [CommitmentItem]?
    /// True when the last fetch failed AND nothing has ever loaded — the view
    /// shows an honest error instead of an infinite spinner.
    private(set) var commitmentsFailed = false

    private func refreshCommitments() async {
        do {
            let resp: CommitmentsResponse = try await api.get(
                "/api/commitments?status=OPEN&limit=50", as: CommitmentsResponse.self)
            commitments = resp.commitments
            commitmentsFailed = false
        } catch {
            commitmentsFailed = true
            Log.app.warning("commitments fetch failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Resolve a commitment (DONE) or dismiss it. Optimistic removal from the
    /// list; rollback on failure (next refresh reconciles regardless).
    func resolveCommitment(_ item: CommitmentItem, as status: String) async {
        let before = commitments
        commitments = commitments?.filter { $0.id != item.id }
        do {
            try await api.patch("/api/commitments/\(item.id)", json: ["status": status])
        } catch APIError.unauthorized {
            signOut()
        } catch {
            commitments = before
            Log.app.warning("commitment update failed: \(String(describing: error), privacy: .private)")
        }
    }

    // MARK: Mailbox search

    /// Search results (nil = search inactive, the tier list shows). Best-effort.
    private(set) var searchResults: [EmailSearchItem]?
    private(set) var searchTotal = 0
    private(set) var isSearching = false

    /// Search the whole mailbox (server-side, same endpoint the web inbox
    /// uses). An inactive query clears results; failures keep the previous
    /// results and log — search must never break the triage surface.
    func search(_ query: String) async {
        guard isSearchActive(query) else {
            searchResults = nil
            searchTotal = 0
            return
        }
        isSearching = true
        defer { isSearching = false }
        do {
            // Scoped to the selected inbox ("all" adds nothing) — the desktop
            // list must honor the same per-inbox scope as the web inbox.
            let resp: EmailSearchResponse = try await api.get(
                emailSearchPath(query: query, selectedInbox: selectedInbox),
                as: EmailSearchResponse.self)
            searchResults = resp.emails
            searchTotal = resp.total
        } catch APIError.unauthorized {
            signOut()
        } catch {
            Log.app.debug("search failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Open a search hit in the reading pane. Reuses the email-detail fetch;
    /// the row is not a FirewallItem, so firewall actions simply don't show.
    func selectSearchResult(_ hit: EmailSearchItem) async {
        selectedItemId = hit.id
        emailError = nil
        openedEmail = nil
        isLoadingEmail = true
        defer { isLoadingEmail = false }
        do {
            openedEmail = try await api.get(
                "/api/email/\(hit.id)", as: EmailDetail.self)
            // Same contract as openItem: explicit PATCH write, never a GET
            // side effect; failures degrade to leaving the mail unread.
            Task { try? await api.patch("/api/email/\(hit.id)/read", json: [:]) }
        } catch APIError.unauthorized {
            signOut()
        } catch {
            emailError = Self.describe(error)
        }
    }

    /// Tier correction — teach the firewall. Optimistically moves the item in
    /// the visible queue, then persists via the override endpoint (which stamps
    /// the decision ledger; ≥2 identical overrides for a sender become a judge
    /// prior, so corrections here are how the user trains future triage).
    func setTier(_ item: FirewallItem, to tier: Tier) async {
        guard item.tier != tier else { return }
        let before = queue
        queue = queue?.movingItem(id: item.id, to: tier)
        do {
            try await api.post("/api/inbox/firewall/\(item.id)", json: ["tier": tier.rawValue])
        } catch APIError.unauthorized {
            signOut()
        } catch {
            // Roll back the optimistic move; next poll reconciles regardless.
            queue = before
            Log.app.warning("tier override failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Sender pin — "this sender is ALWAYS this lane". Persists a PIN_TIER rule
    /// the judge obeys before any prediction (rank 0), and moves the current
    /// item via the normal correction path so the change is visible instantly.
    func pinSender(_ item: FirewallItem, to tier: Tier) async {
        guard let emailId = item.email?.emailDbId else { return }
        await setTier(item, to: tier)
        do {
            try await api.post("/api/email/\(emailId)/pin-tier", json: ["tier": tier.rawValue])
        } catch APIError.unauthorized {
            signOut()
        } catch {
            loadError = Self.describe(error)
            Log.app.warning("pin sender failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Remove the sender's pin. Idempotent server-side; no local state to roll
    /// back — future mails simply go back to predicted tiers.
    func unpinSender(_ item: FirewallItem) async {
        guard let emailId = item.email?.emailDbId else { return }
        do {
            try await api.delete("/api/email/\(emailId)/pin-tier")
        } catch APIError.unauthorized {
            signOut()
        } catch {
            loadError = Self.describe(error)
            Log.app.warning("unpin sender failed: \(String(describing: error), privacy: .private)")
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
        linkWatchTask?.cancel()
        linkWatchTask = nil
        linkAccountError = nil
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
        // Cross-account hygiene: every per-account surface must reset, or the
        // next sign-in briefly shows the previous account's data.
        today = nil
        weekAhead = nil
        usage = nil
        briefing = nil
        briefingStructure = nil
        inboxes = []
        selectedInbox = "all"
        UserDefaults.standard.removeObject(forKey: Self.selectedInboxKey)
        shownMeetingIds = []
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

    /// Today's daily-briefing preview (TODAY column). Best-effort like the rest.
    private(set) var briefing: String?
    private(set) var briefingStructure: BriefingStructure?

    /// Newer release version ("0.3.5") when GitHub has one; nil otherwise.
    /// Surfaced as a quiet ACCOUNT-column button — never a popup
    /// (never-steal-focus). Refreshed on the queue cadence, at most every 6h.
    private(set) var updateAvailable: String?
    private var lastUpdateCheck: Date?
    nonisolated static let updateCheckIntervalHours: Double = 6
    /// Opening the panel re-checks on a much shorter leash than the 6h
    /// background cadence: a release published while the app sat idle used to
    /// stay invisible until relaunch or the next 6h tick (founder-reported,
    /// 2026-07-23). 15 min keeps us far under GitHub's 60 req/h anonymous cap
    /// even with obsessive panel toggling.
    nonisolated static let updateCheckPanelIntervalMinutes: Double = 15

    /// Whether an update check should run now, given the caller's interval.
    /// Pure for testing.
    nonisolated static func updateCheckDue(
        now: Date, last: Date?, intervalSeconds: Double = updateCheckIntervalHours * 3600
    ) -> Bool {
        guard let last else { return true }
        return now.timeIntervalSince(last) >= intervalSeconds
    }

    private func checkForUpdateIfDue(intervalSeconds: Double = updateCheckIntervalHours * 3600)
        async
    {
        guard Self.updateCheckDue(now: Date(), last: lastUpdateCheck, intervalSeconds: intervalSeconds)
        else { return }
        lastUpdateCheck = Date()
        if case .updateAvailable(let version) = await UpdateCheck.run() {
            updateAvailable = version
        } else {
            updateAvailable = nil  // up to date, dev build, or network hiccup
        }
    }

    /// True while a user-initiated update check is in flight, and the result
    /// of the last one ("up to date" / failure) — the background check is
    /// silent by design, but a button the user pressed must answer.
    private(set) var updateCheckInFlight = false
    private(set) var updateCheckResult: String?

    /// Explicit "check for updates" — ignores the interval leash entirely,
    /// because the user asked. The full window only ever showed an update row
    /// when one happened to be known already; there was no way to ASK
    /// (founder, 2026-08-10).
    func checkForUpdateNow() async {
        guard !updateCheckInFlight else { return }
        updateCheckInFlight = true
        updateCheckResult = nil
        defer { updateCheckInFlight = false }
        lastUpdateCheck = Date()
        if case .updateAvailable(let version) = await UpdateCheck.run() {
            updateAvailable = version
            updateCheckResult = nil  // the update row itself is the answer
        } else {
            updateAvailable = nil
            updateCheckResult = L("update.upToDate")
        }
    }

    /// Per-account readiness, on demand. "왜 메일이 안 와" was answered by
    /// guesswork three times running; this makes the app state the facts.
    private(set) var diagnostics: [ReadinessCheck] = []
    private(set) var diagnosticsInFlight = false
    private(set) var diagnosticsError: String?

    func runDiagnostics() async {
        guard !diagnosticsInFlight else { return }
        diagnosticsInFlight = true
        defer { diagnosticsInFlight = false }
        diagnosticsError = nil
        do {
            let res = try await api.get("/api/ops/readiness", as: ReadinessResponse.self)
            diagnostics = diagnosticHighlights(res.checks)
        } catch APIError.unauthorized {
            signOut()
        } catch {
            diagnostics = []
            diagnosticsError = Self.describe(error)
        }
    }

    /// Called when the expanded panel opens — the moment the user is actually
    /// looking at the ACCOUNT column where the update row lives.
    func checkForUpdateOnPanelOpen() {
        Task {
            await checkForUpdateIfDue(
                intervalSeconds: Self.updateCheckPanelIntervalMinutes * 60)
        }
    }

    private func refreshBriefing() async {
        do {
            let today = try await api.get("/api/briefing/today", as: TodayBriefing.self)
            briefing = briefingPreview(today.briefing?.content)
            briefingStructure = today.structured
        } catch {
            Log.app.debug("briefing fetch failed: \(String(describing: error), privacy: .private)")
        }
    }

    private func refreshToday() async {
        do {
            today = try await api.get("/api/calendar/today/summary", as: TodaySummary.self)
        } catch {
            Log.app.debug("today summary fetch failed: \(String(describing: error), privacy: .private)")
        }
        // Replan on every refresh tick (poll + WS wake — the same cadence that
        // keeps the TODAY column fresh keeps the lead window honest).
        // Gated on the user's "Meetings" category: this card is an interrupt,
        // and turning the category off used to change nothing here.
        if automation.allowsInterrupt(for: .meeting),
           let upcoming = today?.upcoming,
           let due = meetingCardPlan(
               now: Date(), events: upcoming,
               leadMinutes: Self.meetingLeadMinutes, shown: shownMeetingIds),
           onMeetingSoon?(due) == true
        {
            shownMeetingIds.insert(due.id)
        }
    }

    /// The raw 7-day-ahead event window (tomorrow onward) behind the UPCOMING
    /// section. nil until first load; best-effort like the TODAY summary.
    private(set) var weekAhead: [CalendarEventWire]?

    /// GET /api/calendar?days=8 — the same list endpoint (and params) the web
    /// calendar page uses. days=8 from today 00:00 covers tomorrow → +7 days;
    /// today's rows are filtered out by the pure grouping.
    private func refreshWeekAhead() async {
        do {
            let resp: CalendarListResponse = try await api.get(
                "/api/calendar?days=8", as: CalendarListResponse.self)
            weekAhead = resp.events
        } catch {
            Log.app.debug("week-ahead fetch failed: \(String(describing: error), privacy: .private)")
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

    // MARK: Automation settings (server-owned behaviour)

    /// Server-side behaviour settings shown in Preferences. Seeded with the
    /// server's own defaults so the panel opens on the right shape; the first
    /// fetch replaces it. `nil`-free by design — an unreachable server should
    /// show the defaults with a save error, not an empty panel.
    private(set) var automation = AutomationSettings()
    private(set) var automationLoaded = false
    private(set) var automationSaving = false
    private(set) var automationError: String?

    /// Refreshed on the queue cadence: System Settings is not the only writer —
    /// the web settings screen can change these behind the desktop app's back.
    private func refreshAutomation() async {
        do {
            automation = try await api.fetchAutomationSettings()
            automationLoaded = true
            automationError = nil
        } catch {
            Log.app.debug("automation fetch failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Apply a settings change: paint it immediately, persist, then settle on
    /// what the server stored. A failed write reverts to the last known-good
    /// value rather than leaving the UI asserting a setting that isn't saved.
    func updateAutomation(_ change: (inout AutomationSettings) -> Void) {
        let previous = automation
        var next = automation
        change(&next)
        guard next != previous else { return }
        automation = next
        automationSaving = true
        automationError = nil
        Task {
            do {
                automation = try await api.updateAutomationSettings(next)
                automationLoaded = true
            } catch {
                automation = previous
                automationError = Self.automationErrorText(error)
                Log.app.debug("automation save failed: \(String(describing: error), privacy: .private)")
            }
            automationSaving = false
        }
    }

    private static func automationErrorText(_ error: Error) -> String {
        switch error {
        case APIError.unauthorized: return L("auto.error.unauthorized")
        case APIError.forbidden: return L("auto.error.forbidden")
        case APIError.transport: return L("auto.error.offline")
        default: return L("auto.error.generic")
        }
    }

    // MARK: Agent proposals

    /// Actions Klorn is waiting on approval for. Until now these could only be
    /// approved on the web, which is why the agent's daily receipt linked out.
    private(set) var pendingActions: [PendingActionsResponse.Action] = []
    private(set) var pendingActionError: String?
    /// Ids currently being approved/rejected — the row disables so a double
    /// click can't fire the action twice.
    private(set) var resolvingActions: Set<String> = []

    private func refreshPendingActions() async {
        do {
            let resp: PendingActionsResponse = try await api.get(
                "/api/chat/pending-actions", as: PendingActionsResponse.self)
            pendingActions = resp.actions
            pendingActionError = nil
        } catch {
            Log.app.debug("pending actions fetch failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Approve or reject a proposal. The row is removed optimistically — the
    /// user has decided, and leaving it on screen invites a second click — and
    /// restored if the server refuses.
    func resolvePendingAction(_ action: PendingActionsResponse.Action, approve: Bool) {
        guard !resolvingActions.contains(action.id) else { return }
        let previous = pendingActions
        resolvingActions.insert(action.id)
        pendingActions.removeAll { $0.id == action.id }
        pendingActionError = nil
        Task {
            do {
                try await api.post(
                    "/api/chat/pending-actions/\(action.id)/\(approve ? "approve" : "reject")")
                // The agent receipt counts this action too, so refresh both.
                await refreshAgentToday()
                await refreshPendingActions()
            } catch {
                pendingActions = previous
                pendingActionError = Self.automationErrorText(error)
                Log.app.debug("pending action resolve failed: \(String(describing: error), privacy: .private)")
            }
            resolvingActions.remove(action.id)
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
        Task { await refreshWeekAhead() }
        Task { await refreshInboxes() }
        Task { await refreshUsage() }
        Task { await refreshBriefing() }
        Task { await refreshCommitments() }
        Task { await refreshAgentToday() }
        Task { await refreshAutomation() }
        Task { await refreshPendingActions() }
        Task { await checkForUpdateIfDue() }
        do {
            let selectionAtFetch = selectedInbox
            let fetched = try await api.get(
                firewallPath(selected: selectionAtFetch), as: FirewallResponse.self)
            queueCache[selectionAtFetch] = fetched
            // A slow response for a selection the user has already left must
            // not clobber the queue they're looking at now.
            guard selectionAtFetch == selectedInbox else { return }
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
        // Respect the user's "Urgent mail" category. Seen-tracking still runs on
        // the muted path so re-enabling the category doesn't dump a backlog of
        // interrupts for mail that arrived while it was off.
        if !plan.toNotify.isEmpty, automation.allowsInterrupt(for: .emailUrgent) {
            onNewPush?(plan.toNotify)
        }
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
        case APIError.decoding: return L("error.badResponse")
        case APIError.unauthorized: return L("error.sessionExpired")
        case APIError.forbidden: return L("error.needsPro")
        default: return L("error.generic")
        }
    }
}
