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
    private(set) var loadError: String? {
        didSet { if loadError == nil { loadOffline = false } }
    }
    /// The failure behind `loadError` was the network (no server reached),
    /// not an answer from the server. Decides "offline" vs "couldn't load".
    private(set) var loadOffline = false
    private(set) var isLoadingQueue = false

    /// Called with newly-arrived PUSH items (never the first-load baseline).
    /// The AppDelegate wires this to the HUD; if unset, PUSH surfacing is a no-op.
    var onNewPush: (([FirewallItem]) -> Void)?

    /// User preferences (persisted). Observed by the Preferences panel and read
    /// by the controller before posting an OS banner.
    let settings = AppSettings()

    /// True while the Settings scene's window is on screen. Part of the
    /// activation-policy decision (Cmd+Tab compromise): an open Settings
    /// window keeps the app .regular even with the bar collapsed.
    var settingsWindowOpen = false {
        didSet {
            guard settingsWindowOpen != oldValue else { return }
            onWindowPresenceChanged?()
        }
    }
    /// True while the standard main window (M2, `macMainWindow`) is open.
    /// Same rule as Settings: an open window keeps the app .regular.
    var mainWindowOpen = false {
        didSet {
            guard mainWindowOpen != oldValue else { return }
            onWindowPresenceChanged?()
        }
    }
    /// True while the compose window (M5, `macMainWindow`) is on screen. It
    /// counts like the main window: an open window keeps the app .regular.
    var composeWindowOpen = false {
        didSet {
            guard composeWindowOpen != oldValue else { return }
            onWindowPresenceChanged?()
        }
    }
    /// True while the first-launch onboarding window (M6) is on screen. A
    /// window the user has to act in must be reachable from the Dock.
    var onboardingWindowOpen = false {
        didSet {
            guard onboardingWindowOpen != oldValue else { return }
            onWindowPresenceChanged?()
        }
    }
    /// Wired by the AppDelegate to re-apply the activation policy when a
    /// window (Settings, main, compose, onboarding) opens or closes.
    @ObservationIgnored var onWindowPresenceChanged: (() -> Void)?
    /// Wired by the AppDelegate to the compose window (M5): fires when the
    /// composer is asked for (again) or put away. Unused with the flag off.
    @ObservationIgnored var onComposePresentationChanged: (() -> Void)?

    /// Mirrors whether the top bar is in its full (app window) state.
    /// Written by TopBarController on every render.
    var barFullOpen = false
    /// Whether the full view is up anywhere — the bar's full state or the
    /// main window — so the app menus enable only what the UI can act on.
    var isFullViewOpen: Bool { barFullOpen || mainWindowOpen }
    /// Mirrors the reading pane's inline reply composer being open: Reply in
    /// the Message menu is disabled then, since re-drafting would wipe
    /// what the user has typed.
    var readerReplying = false
    /// Mirrors whether the top bar's panel is the key window. Written by
    /// TopBarController.
    var barPanelIsKey = false
    /// Mirrors whether the main window is the key window. Written by its
    /// window tracker.
    var mainWindowIsKey = false
    /// Message-menu commands act on what the full view shows, so they stay
    /// off while another window (Settings) is key.
    var mailSurfaceIsKey: Bool {
        MenuRules.mailSurfaceIsKey(
            barPanelIsKey: barPanelIsKey, barFullOpen: barFullOpen,
            mainWindowIsKey: mainWindowIsKey, mainWindowOpen: mainWindowOpen)
    }
    /// Set by the Message menu's Reply; the reading pane answers by starting
    /// the same AI-drafted reply as its own button — for this item only.
    private(set) var replyRequest: ReplyRequest?
    /// Set by Find (⌘F); the mail list's search field takes focus and clears it.
    var searchFocusPending = false

    /// Message ▸ Reply: ask the reading pane to start a reply to the item
    /// it shows now. The id rides along so a selection change in between
    /// can never redirect the reply to another message.
    func requestReply() {
        guard let item = menuTargetItem else { return }
        replyRequest = ReplyRequest(token: (replyRequest?.token ?? 0) &+ 1, itemId: item.id)
    }

    /// Go-menu navigation: switch the list column and put the sidebar on the
    /// level that owns the destination (mail family vs root features).
    func go(to mode: ListMode) {
        listMode = mode
        sidebarLevel = mode.isMailFamily ? .mail : .root
        clearSelection()
    }

    /// The firewall item the reading pane is showing, if any — what the
    /// Message menu acts on. nil while a Sent/Drafts/Archived row owns the
    /// pane (those rows are not firewall items).
    var menuTargetItem: FirewallItem? {
        // In the main window the reader exists only in Mail (M4b): a mail
        // that is not on screen is never a menu target.
        guard readerVisible else { return nil }
        if listMode.showsLiveMessages, selectedMailboxItem != nil { return nil }
        guard let id = selectedItemId else { return nil }
        return queue?.item(id: id)
    }

    /// A modal overlay covers the full view (its background is disabled).
    var fullViewModalOpen: Bool {
        MainSheetRules.modalOpen(
            macMainWindow: settings.macMainWindow,
            overlayModal: composeOverlayOpen || showTierGuide || showEventEditor || showPurposePrompt,
            sheetAttached: mainSheetAttached)
    }
    /// A sheet is attached to the open main window (M5). Written by
    /// `MainWindowController`; a sheet flag left set while the window is
    /// closed blocks nothing.
    var mainSheetAttached = false
    /// The composer as an in-window overlay (the bar's full view). With
    /// `macMainWindow` on it is its own window (M5) and covers nothing.
    var composeOverlayOpen: Bool {
        ComposeWindowRules.overlayOpen(
            showCompose: showCompose, macMainWindow: settings.macMainWindow)
    }
    /// Device calendars uploaded from EventKit (step C6): opt-in per calendar.
    let deviceCalendars: DeviceCalendarBridge

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
    /// The mail-first default (shell 2026-08-26): people read a mailbox top
    /// to bottom — the lanes ride on the rows as chips and remain one click
    /// away as categories, but navigation no longer starts lane-first.
    var listMode: ListMode = .inbox {
        // The main window (M4b) follows every write, same value included:
        // a deep link to the list mode already set must still bring its
        // section forward. Unused while `macMainWindow` is off.
        //
        // Every write must therefore be USER INTENT (a click, a menu
        // command, a deep link the user followed). A background writer
        // (poll, realtime, restore) would yank the window to another
        // section; the self-check pins the list of writers.
        didSet {
            mainNav = NavRules.following(listMode, from: mainNav)
            // Leaving Mail takes the reader off screen; drop its selection
            // so nothing invisible stays selected (main window only).
            if NavRules.clearsSelection(
                macMainWindow: settings.macMainWindow, section: mainNav.section)
            {
                clearSelection()
            }
        }
    }
    /// Whether a reading pane is on screen for the Message menu: always in
    /// the bar's full view, only in Mail in the main window.
    var readerVisible: Bool {
        NavRules.readerVisible(macMainWindow: settings.macMainWindow, section: mainNav.section)
    }
    /// Where the main window is (M4b): section, Assistant pane, last mail facet.
    var mainNav = MainNav()
    /// Which sidebar the full view shows: the root feature nav, or the mail
    /// client's own sidebar (folders + categories, with a Back row). The
    /// reference clients swap ONE sidebar between levels — two stacked nav
    /// groups was the founder's first complaint about the previous shell.
    var sidebarLevel: SidebarLevel = .root

    /// Open the full view on `tier`, and clear any reading-pane selection so the
    /// pane doesn't keep showing a message from the tier the user just left.
    func showTier(_ tier: Tier) {
        listMode = .tier(tier)
        sidebarLevel = .mail  // a lane IS the mail level — Back must be there
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
    /// Where the session token lives. Every token read and write in the model
    /// goes through this, so a harness that injects an in-memory store cannot
    /// reach the Keychain.
    private let tokenStore: any TokenStore

    // MARK: Session scope

    /// Counts the sessions this model has held: bumped by `signOut()` and by
    /// every sign-in that lands. Async work reads it before its first `await`
    /// and checks `isCurrent` after each one. A result that arrives after the
    /// account changed belongs to nobody on screen: it writes nothing, raises
    /// no error and signs nobody out.
    @ObservationIgnored private(set) var sessionGeneration = 0

    func isCurrent(_ session: Int) -> Bool { session == sessionGeneration }

    /// Fired when a session ends (sign-out, or a sign-in replacing it). The
    /// AppDelegate wires it to what lives outside the model and still shows
    /// the account that left: the HUD card, the meeting card, OS banners.
    @ObservationIgnored var onSessionEnded: (() -> Void)?

    /// Harness seams. The browser leg of sign-in, the poll cadence, and
    /// whether the wake socket opens: a self-check drives sign-in without a
    /// browser, polls in milliseconds and never opens a socket.
    @ObservationIgnored var signInRunner: @MainActor (APIClient, String) async -> SignInResult = {
        await GoogleSignIn.run(api: $0, provider: $1)
    }
    @ObservationIgnored var pollInterval: Duration = .seconds(AppModel.pollIntervalSeconds)
    @ObservationIgnored var opensRealtime = true

    /// The release check. A seam so the self-check never calls GitHub.
    @ObservationIgnored var updateCheck: @MainActor () async -> UpdateCheck.Outcome = {
        await UpdateCheck.run()
    }

    /// The store the shipped app uses. Named so the self-check can pin the
    /// default without constructing a model (which would read the Keychain).
    nonisolated static func productionTokenStore() -> any TokenStore { KeychainTokenStore() }

    /// `api` defaults to a client that reads its bearer token from `tokenStore`,
    /// as does the device-calendar bridge — one injected store covers them all.
    init(tokenStore: any TokenStore = AppModel.productionTokenStore(), api: APIClient? = nil) {
        let api = api ?? APIClient(token: { tokenStore.load() })
        self.api = api
        self.tokenStore = tokenStore
        self.deviceCalendars = DeviceCalendarBridge(
            api: api,
            currentUser: { SessionIdentity.userId(fromToken: tokenStore.load()) })
        self.phase = tokenStore.load() != nil ? .signedIn : .signedOut
        self.selectedInbox =
            UserDefaults.standard.string(forKey: Self.selectedInboxKey) ?? "all"
    }

    // MARK: Multi-inbox

    /// The user's mailboxes (primary + linked). The selector renders at 2+;
    /// every mail-list fetch is scoped by `selectedInbox` (doctrine: never
    /// assume the primary account).
    private(set) var inboxes: [InboxOption] = []
    /// Mail opened in this session (EmailMessage ids). Opening marks it read
    /// on the server, but the list only learns that on its next poll; rows
    /// drop the unread dot from this set in the meantime.
    private(set) var openedEmailIds: Set<String> = []
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
        let session = sessionGeneration
        do {
            let resp = try await api.get("/api/teams", as: Resp.self)
            guard isCurrent(session) else { return }
            teams = resp.teams
            teamModeAvailable = true
        } catch _ where !isCurrent(session) {
            return
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
        let session = sessionGeneration
        do {
            try await api.post("/api/teams", encodable: Body(name: name, members: members))
            await refreshTeams()
        } catch _ where !isCurrent(session) {
            return
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
        let session = sessionGeneration
        checkingTeamId = teamId
        teamAvailability = nil
        teamBookingResult = nil
        defer { if isCurrent(session) { checkingTeamId = nil } }
        let fmt = ISO8601DateFormatter()
        let start = fmt.string(from: Date())
        let end = fmt.string(from: Date().addingTimeInterval(3 * 24 * 3600))
        let path = "/api/teams/\(teamId)/availability?window_start=\(start)&window_end=\(end)&duration_minutes=\(durationMinutes)"
        let availability = try? await api.get(path, as: TeamAvailabilityWire.self)
        guard isCurrent(session) else { return }
        teamAvailability = availability
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
        let session = sessionGeneration
        do {
            try await api.post(
                "/api/calendar",
                encodable: Body(
                    title: title, startTime: slot.startTime, endTime: slot.endTime,
                    attendees: members))
            guard isCurrent(session) else { return false }
            teamBookingResult = L("teams.booked")
            Task { await refreshToday() }
            return true
        } catch _ where !isCurrent(session) {
            return false
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
    /// Self-check seam.
    var queueCacheIsEmpty: Bool { queueCache.isEmpty }

    func selectInbox(_ value: String) {
        guard value != selectedInbox else { return }
        selectedInbox = value
        UserDefaults.standard.set(value, forKey: Self.selectedInboxKey)
        // The folders are scoped by the same selector (2026-09-04): drop the
        // other account's pages and re-read the open folder, if one is open.
        mailboxItems = [:]
        mailboxNextToken = [:]
        clearMailboxSelection()
        if case .mailbox(let box) = listMode {
            Task { await loadMailbox(box) }
        }
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
        let session = sessionGeneration
        do {
            let resp = try await api.fetchInboxes()
            guard isCurrent(session) else { return }
            inboxes = resp.inboxes
            companyDomains = resp.companyDomains ?? []
            triagePriorities = resp.priorities
            // A purpose chosen on the signed-out screen lands here, the first
            // moment the primary inbox is confirmed to exist.
            applyPendingPurposeIfNeeded()
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
        let session = sessionGeneration
        do {
            let status = try await api.fetchNaverStatus()
            guard isCurrent(session) else { return }
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
        let session = sessionGeneration
        isConnectingImap = true
        defer { if isCurrent(session) { isConnectingImap = false } }
        imapError = nil
        do {
            try await api.connectNaver(email: email, password: password)
            guard isCurrent(session) else { return false }
            await refreshImapAccounts()
            await refreshInboxes()
            await loadQueue()
            return isCurrent(session)
        } catch _ where !isCurrent(session) {
            return false
        } catch APIError.unauthorized {
            sessionRejected()
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
        let session = sessionGeneration
        imapError = nil
        do {
            try await api.disconnectNaver(email: email)
            guard isCurrent(session) else { return }
            await refreshImapAccounts()
            await refreshInboxes()
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
        } catch {
            imapError = L("account.imap.disconnectFailed")
        }
    }

    /// "Add Google account": open the Pro-gated link-inbox consent in the
    /// browser, then watch the inbox list so the new account appears quickly.
    func addAccount() async {
        guard !isLinkingAccount else { return }
        let session = sessionGeneration
        isLinkingAccount = true
        defer { if isCurrent(session) { isLinkingAccount = false } }
        linkAccountError = nil
        let outcome = await LinkInboxFlow.start(api: api)
        guard isCurrent(session) else { return }
        switch outcome {
        case .success:
            startLinkWatch()
        case .failure(.needsPro):
            linkAccountError = L("error.needsPro")
        case .failure(.unauthorized):
            sessionRejected()
        case .failure(.network):
            linkAccountError = L("account.add.failed")
        }
    }

    /// Reconnect the PRIMARY Google account (full-scope /google/start consent
    /// in the browser) — distinct from addAccount, which links a Pro-gated
    /// SECOND account and cannot revive the primary token.
    func reconnectPrimary() async {
        guard !isLinkingAccount else { return }
        let session = sessionGeneration
        isLinkingAccount = true
        defer { if isCurrent(session) { isLinkingAccount = false } }
        linkAccountError = nil
        let outcome = await GoogleConnectFlow.start(api: api)
        guard isCurrent(session) else { return }
        switch outcome {
        case .success:
            startReconnectWatch()
        case .failure(.unauthorized):
            sessionRejected()
        case .failure(.network):
            linkAccountError = L("account.reconnect.failed")
        }
    }

    /// Poll (5 s cadence, 3 min cap) until the PRIMARY row's needsReconnect
    /// clears — a reconnect flips a flag, it never adds an inbox row, so
    /// startLinkWatch's count-grew condition can never fire for it.
    private func startReconnectWatch() {
        linkWatchTask?.cancel()
        let session = sessionGeneration
        linkWatchTask = Task { [weak self] in
            for _ in 0..<36 {
                try? await Task.sleep(for: .seconds(5))
                guard let self, !Task.isCancelled, self.isCurrent(session) else { return }
                await self.refreshInboxes()
                guard self.isCurrent(session) else { return }
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
        let baseline = Set(inboxes.compactMap(\.id))
        let session = sessionGeneration
        linkWatchTask = Task { [weak self] in
            for _ in 0..<36 {
                try? await Task.sleep(for: .seconds(5))
                guard let self, !Task.isCancelled, self.isCurrent(session) else { return }
                await self.refreshInboxes()
                guard self.isCurrent(session) else { return }
                if let linked = Self.newlyLinkedInbox(baseline: baseline, now: self.inboxes) {
                    await self.loadQueue()
                    guard self.isCurrent(session) else { return }
                    // Ask what the NEW mailbox is for, right as it lands —
                    // the same connect-time question the primary gets.
                    self.presentPurposePrompt(forLinked: linked)
                    return
                }
            }
        }
    }

    /// The linked inbox that appeared since the link flow started, if any.
    /// Id-based (not a count): a concurrent unlink + link would leave the
    /// count equal and the new account unnoticed.
    nonisolated static func newlyLinkedInbox(
        baseline: Set<String>, now: [InboxOption]
    ) -> InboxOption? {
        now.first { $0.kind == "linked" && $0.id.map { !baseline.contains($0) } == true }
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
        queueCache[selectedInbox] = queue
        openedEmail = try? JSONDecoder().decode(EmailDetail.self, from: Data(emailJSON.utf8))
        self.selectedItemId = selectedItemId
        if let briefingJSON {
            briefingStructure = try? JSONDecoder().decode(
                BriefingStructure.self, from: Data(briefingJSON.utf8))
        }
    }

    /// Render-probe seam for the main-window shots (M4b): the state the
    /// fixtures cannot reach through `seedForPreview`. No network, no disk.
    func seedMainWindowForRender(
        inboxes: [InboxOption], today: TodaySummary?,
        pendingActions: [PendingActionsResponse.Action], commitments: [CommitmentItem],
        chat: [ChatMessage], loadError: String? = nil
    ) {
        self.loadError = loadError
        self.inboxes = inboxes
        self.today = today
        self.pendingActions = pendingActions
        self.commitments = commitments
        chatMessages = chat
    }

    /// Render-probe seam for the state shots (M6): the states no fixture
    /// reaches. No network, no disk.
    func seedStateForRender(
        phase: Phase, loadError: String? = nil, offline: Bool = false,
        loginProviders: [String]? = nil, signInError: String? = nil
    ) {
        self.phase = phase
        self.loadError = loadError
        loadOffline = offline && loadError != nil
        if let loginProviders { self.loginProviders = loginProviders }
        self.signInError = signInError
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
        // Resumes uploading only calendars the user already turned on; asks nothing.
        deviceCalendars.start()
        // Team mode availability probe (403 while dark) — decides whether the
        // 팀 sidebar row and screen render at all.
        Task { await refreshTeams() }
    }

    /// The provider of the last sign-in attempt, so "Start over" restarts
    /// the one the user chose rather than falling back to Google.
    private(set) var signInProvider = "google"

    func restartSignIn() async {
        await signIn(provider: signInProvider)
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
        signInProvider = provider
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
        let session = sessionGeneration
        let result = await signInRunner(api, provider)
        // A superseded attempt owns none of this state any more; nor does
        // one that a sign-out overtook.
        guard !Task.isCancelled, isCurrent(session) else { return }
        switch result {
        case .success(let token):
            beginSession(token: token)
            deviceCalendars.start()
            await loadQueue()
        case .failure(let reason, let detail):
            Log.app.error("sign-in failed: \(reason.rawValue, privacy: .public) \(detail, privacy: .private)")
            if reason != .cancelled { signInError = Self.message(reason) }
            phase = .signedOut
        }
    }

    /// A sign-in landed: a new session starts here, whoever held the last
    /// one. Whatever the previous session left running stops being current.
    private func beginSession(token: String) {
        if !tokenStore.save(token) {
            Log.app.warning("Keychain save denied (unsigned dev build?) — token kept in memory for this session only")
        }
        sessionGeneration += 1
        // The poll loop and the socket belong to the session that started
        // them. A socket opened under the PREVIOUS token would also 4001-loop
        // forever (RealtimeClient captures its token once). Both stop here.
        stopPolling()
        realtime?.stop()
        realtime = nil
        // Whatever still showed the previous account outside the model.
        onSessionEnded?()
        phase = .signedIn
        // The poll starts with the session, not with its first good load: a
        // sign-in whose first load fails recovers by itself when the network
        // is back. The socket waits for `ensureActive()`.
        startPolling()
    }

    /// A request of the current session was answered 401. Only a live
    /// session can be rejected: a stray 401 while signed out or while a
    /// sign-in is in flight ends nothing, and above all not that sign-in.
    private func sessionRejected() {
        guard phase == .signedIn else { return }
        signOut()
    }

    /// Self-check seam: start a session as a sign-in does, without the
    /// browser leg or the first load.
    func beginSessionForCheck(token: String) { beginSession(token: token) }

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
        let session = sessionGeneration
        isLoadingEmail = true
        defer { if isCurrent(session) { isLoadingEmail = false } }
        do {
            let detail = try await api.get(
                "/api/email/\(emailDbId)", as: EmailDetail.self)
            guard isCurrent(session) else { return }
            openedEmail = detail
            // Reading is a side-effect-free GET; marking read is an explicit
            // write. Fire-and-forget: a failed mark-read must not blank the
            // reading pane the user already has.
            Task { try? await api.patch("/api/email/\(emailDbId)/read", json: [:]) }
            openedEmailIds = openedEmailIds.union([emailDbId])
            loadMeetingContext(for: emailDbId, guardId: item.id)
            loadSenderDossier(for: emailDbId, guardId: item.id)
            loadThreadBrief(for: emailDbId, guardId: item.id)
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
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

    /// The folder-row counterpart of inlineImage: live messages have no DB
    /// row, so the API walks the message's MIME tree — on the account the
    /// row came from. Same alphanumerics-only encoding, same nil-on-failure.
    func liveInlineImage(gmailId: String, inbox: String?, cid: String) async -> (Data, String)? {
        guard let id = gmailId.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
              let encoded = cid.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
              let (data, mime) = try? await api.rawGet(
                "/api/email/live/\(id)/inline/\(encoded)\(mailboxItemQuery(inbox: inbox))")
        else { return nil }
        return (data, mime ?? "image/png")
    }

    /// Meeting mail only: fetch the calendar cross-reference (proposed slot,
    /// conflict verdict, nearby events) without blocking the pane. The guard
    /// keeps a slow response from painting over a different, newer selection.
    private func loadSenderDossier(for emailDbId: String, guardId: String) {
        senderDossier = nil
        let session = sessionGeneration
        Task {
            let lang = L10n.resolvedCode(override: L10n.override)
            let dossier = try? await api.get(
                "/api/email/\(emailDbId)/sender-dossier?lang=\(lang)", as: SenderDossierWire.self)
            // Empty history answers with an empty summary — nothing to show.
            if isCurrent(session), selectedItemId == guardId, let dossier, !dossier.summary.isEmpty {
                senderDossier = dossier
            }
        }
    }

    /// Why this person wrote NOW — a whole-thread read (both directions).
    /// Fetching it here is also what warms the server cache the reply drafter
    /// reads, so "AI 답장" on an opened mail costs no extra thread read.
    private func loadThreadBrief(for emailDbId: String, guardId: String) {
        threadBrief = nil
        let session = sessionGeneration
        Task {
            let lang = L10n.resolvedCode(override: L10n.override)
            let response = try? await api.get(
                "/api/email/\(emailDbId)/thread-brief?lang=\(lang)", as: ThreadBriefResponse.self)
            if isCurrent(session), selectedItemId == guardId, let brief = response?.brief, !brief.whyNow.isEmpty {
                threadBrief = brief
            }
        }
    }

    private func loadMeetingContext(for emailDbId: String, guardId: String) {
        meetingContext = nil
        guard openedEmail?.category == "meeting" else { return }
        let session = sessionGeneration
        Task {
            let context = try? await api.get(
                "/api/email/\(emailDbId)/meeting-context", as: MeetingContextWire.self)
            if isCurrent(session), selectedItemId == guardId { meetingContext = context }
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
        let session = sessionGeneration
        isDrafting = true
        defer { if isCurrent(session) { isDrafting = false } }
        replyError = nil
        do {
            let draft: Draft = try await api.post("/api/email/\(emailDbId)/reply-draft", json: [:], as: Draft.self)
            return isCurrent(session) ? draft.body : nil
        } catch _ where !isCurrent(session) {
            return nil
        } catch APIError.unauthorized {
            sessionRejected()
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
    /// `session`: the session the asking surface belongs to (a HUD card is
    /// stamped when presented). One that has ended sends no request.
    func fetchReplyOptions(_ item: FirewallItem, session: Int? = nil) async -> ReplyOptionsFetch {
        guard let emailDbId = item.email?.emailDbId else {
            return .failed(L("reply.emailOnly"))
        }
        let session = session ?? sessionGeneration
        guard isCurrent(session) else { return .failed(L("error.sessionExpired")) }
        do {
            let options: ReplyOptionsResponse = try await api.post(
                "/api/email/\(emailDbId)/reply-options", json: [:], as: ReplyOptionsResponse.self)
            return isCurrent(session) ? .ready(options) : .failed(L("error.sessionExpired"))
        } catch _ where !isCurrent(session) {
            return .failed(L("error.sessionExpired"))
        } catch APIError.unauthorized {
            sessionRejected()
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
        let session = sessionGeneration
        isSummarizing = true
        summarizeFailed = false
        defer { if isCurrent(session) { isSummarizing = false } }
        do {
            let lang = L10n.resolvedCode(override: L10n.override)
            try await api.post("/api/email/\(email.id)/summarize", json: ["lang": lang])
        } catch {
            Log.app.error("on-demand summarize failed: \(String(describing: error), privacy: .private)")
            if isCurrent(session), openedEmail?.id == email.id { summarizeFailed = true }
            return
        }
        // The POST persisted server-side; a refresh failure here must not
        // report "summarize failed" — the pane just keeps the old band until
        // the next open re-fetches it.
        guard isCurrent(session) else { return }
        if let updated = try? await api.get("/api/email/\(email.id)", as: EmailDetail.self),
           isCurrent(session), openedEmail?.id == email.id {
            openedEmail = updated
        }
    }

    /// Load an email's detail for the card's expanded view — Klorn's AI summary
    /// lives there, not on the firewall wire. Plain GET, never `markRead`: an
    /// unattended card must not silently mark mail as read. Best-effort — the
    /// expanded view falls back to the snippet when this returns nil.
    func fetchEmailDetail(_ item: FirewallItem, session: Int? = nil) async -> EmailDetail? {
        let session = session ?? sessionGeneration
        guard isCurrent(session), let emailDbId = item.email?.emailDbId else { return nil }
        do {
            let detail = try await api.get("/api/email/\(emailDbId)", as: EmailDetail.self)
            return isCurrent(session) ? detail : nil
        } catch {
            Log.app.debug("card detail fetch failed: \(String(describing: error), privacy: .private)")
            return nil
        }
    }

    /// Whether the composer is presented: an overlay on the bar's full view,
    /// its own window while `macMainWindow` is on (M5). Asking again while
    /// it is up still notifies, so the window comes forward.
    var showCompose = false {
        didSet {
            if showCompose || oldValue { onComposePresentationChanged?() }
        }
    }
    /// Draft lives on the MODEL, not the panel: SwiftUI drops a conditionally
    /// mounted view's @State (e.g. when the full view is torn down and rebuilt via
    /// the menu bar), and a draft must survive that. There is exactly one
    /// composer identity, so an orphaned send can never race a "new" session.
    var composeTo = ""
    var composeSubject = ""
    var composeBody = ""
    var composeError: String?
    private(set) var composeSending = false
    /// Set while the composer is editing an existing Gmail draft (opened from
    /// the 임시보관함 folder). A successful send deletes that draft — without
    /// this the sent mail and its stale draft coexist and the folder looks
    /// broken. Cleared on discard: cancelling an edit leaves the draft alone.
    private(set) var editingDraftGmailId: String?
    /// The account that draft lives in ("primary" / linked id / nil = older
    /// server = primary) — the delete after send must hit the same account.
    private(set) var editingDraftInbox: String?

    /// Open a Drafts-folder row for EDITING: fetch the live body and prefill
    /// the composer. Every mail client opens a draft into its editor — the
    /// read-only view was the surprise. This deliberately replaces whatever
    /// un-sent ⌘N text was sitting in the composer: opening a document is an
    /// explicit act, like File→Open over an unsaved scratch buffer.
    func openDraftForEditing(_ item: MailboxItem) {
        Task { await loadDraftForEditing(item) }
    }

    /// The fetch behind `openDraftForEditing`. Internal so the self-check
    /// can await it. A draft that arrives after its account signed out is
    /// dropped: the next account must not find it in the composer.
    func loadDraftForEditing(_ item: MailboxItem) async {
        let session = sessionGeneration
        do {
            let resp: LiveEmailDetail = try await api.get(
                "/api/email/live/\(item.gmailId)\(mailboxItemQuery(inbox: item.inbox))",
                as: LiveEmailDetail.self)
            guard isCurrent(session) else { return }
            composeTo = extractRecipient(resp.data.to)
            composeSubject = resp.data.subject
            composeBody = resp.data.body
            composeError = nil
            editingDraftGmailId = item.gmailId
            editingDraftInbox = item.inbox
            showCompose = true
        } catch _ where !isCurrent(session) {
            return
        } catch {
            mailboxError = L("mailbox.loadFailed")
            Log.app.warning("draft open failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// "Name <addr>" → addr for the To field (the composer sends bare
    /// addresses). A bare address passes through unchanged.
    private func extractRecipient(_ raw: String) -> String {
        if let open = raw.lastIndex(of: "<"), let close = raw.lastIndex(of: ">"),
           open < close
        {
            return String(raw[raw.index(after: open)..<close])
        }
        return raw.trimmingCharacters(in: .whitespaces)
    }

    /// Send the current draft. Success clears the draft and closes the panel;
    /// failure surfaces composeError and keeps everything for retry.
    func submitCompose() async {
        guard !composeSending else { return }
        let session = sessionGeneration
        // The draft this send was started from: the one to delete afterwards.
        let draftId = editingDraftGmailId
        let draftInbox = editingDraftInbox
        composeSending = true
        composeError = nil
        defer { if isCurrent(session) { composeSending = false } }
        let error = await sendNewEmail(to: composeTo, subject: composeSubject, body: composeBody)
        // The composer belongs to the session that started the send. A 401
        // mid-send signed the account out and discarded the draft; a sign-out
        // (and another account's sign-in) while the send was in flight leaves
        // a composer, and a draft id, that this result must not touch.
        guard isCurrent(session) else { return }
        if let error {
            composeError = error
        } else {
            // Draft-based send: remove the original Gmail draft, best-effort
            // (404 = already gone from another client — a legitimate outcome).
            // The mail was SENT either way; cleanup failure must never read
            // as a send failure.
            if let draftId {
                try? await api.delete(
                    "/api/email/draft/by-message/\(draftId)\(mailboxItemQuery(inbox: draftInbox))")
                guard isCurrent(session) else { return }
                await loadMailbox(.drafts)
                guard isCurrent(session) else { return }
            }
            discardComposeDraft()
            showCompose = false
        }
    }

    /// Self-check seam: the state `openDraftForEditing` leaves, without the
    /// network fetch.
    func seedEditingDraftForCheck(gmailId: String, inbox: String?) {
        editingDraftGmailId = gmailId
        editingDraftInbox = inbox
    }

    /// Explicit discard (the Cancel button). Hiding the panel via ✕/scrim/Esc
    /// deliberately KEEPS the draft — ⌘N reopens where the user left off.
    func discardComposeDraft() {
        composeTo = ""
        composeSubject = ""
        composeBody = ""
        composeError = nil
        editingDraftGmailId = nil
        editingDraftInbox = nil
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
        let session = sessionGeneration
        do {
            try await api.post(
                "/api/email/send",
                json: ["to": toTrimmed, "subject": subjectTrimmed, "body": body])
            return nil
        } catch _ where !isCurrent(session) {
            return L("error.sessionExpired")
        } catch APIError.unauthorized {
            sessionRejected()
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
    /// `session`: the session the sending surface belongs to. A reply from a
    /// surface whose session has ended is refused before any request: the
    /// mail on it is another account's, and the token is not.
    func sendReply(_ item: FirewallItem, body: String, session: Int? = nil) async -> String? {
        guard let emailDbId = item.email?.emailDbId,
              !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return L("reply.nothingToSend") }
        let session = session ?? sessionGeneration
        guard isCurrent(session) else { return L("error.sessionExpired") }
        do {
            try await api.post("/api/email/\(emailDbId)/reply", json: ["body": body])
            return nil
        } catch _ where !isCurrent(session) {
            return L("error.sessionExpired")
        } catch APIError.unauthorized {
            sessionRejected()
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
        let session = sessionGeneration
        replyError = nil
        let error = await sendReply(item, body: body)
        guard isCurrent(session) else { return error == nil }
        replyError = error
        return error == nil
    }

    /// Dismiss a PUSH item: clear it from the firewall queue (status DISMISSED,
    /// leaves the source email in Gmail) and hide it immediately (optimistic).
    /// Works for any source. On failure, un-hide and refetch the truth.
    func dismiss(_ item: FirewallItem) async {
        let session = sessionGeneration
        hideLocally(item)
        do {
            try await api.post("/api/inbox/firewall/\(item.id)/dismiss")
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
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
        let session = sessionGeneration
        do {
            try await api.post("/api/calendar", encodable: body)
            guard isCurrent(session) else { return }
            clearEventDraft(messageId)
            chatMessages.append(ChatMessage(
                role: .assistant, text: L("calendar.addedConfirm", eventDraftLabel(draft))))
            Task { await refreshToday() }  // the TODAY column should show it now
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
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
        let session = sessionGeneration
        do {
            let actions = try await api.get(
                "/api/automations/today-actions", as: TodayActions.self)
            guard isCurrent(session) else { return }
            agentToday = actions
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
        let session = sessionGeneration
        chatMessages.append(ChatMessage(role: .user, text: trimmed))
        isChatting = true
        defer { if isCurrent(session) { isChatting = false } }
        do {
            if chatConversationId == nil {
                let conv: ChatConversation = try await api.post(
                    "/api/chat/conversations", json: [:], as: ChatConversation.self)
                guard isCurrent(session) else { return }
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
            guard isCurrent(session) else { return }
            chatMessages.append(
                ChatMessage(role: .assistant, text: turn.reply, eventDraft: turn.eventDraft))
            if let error = turn.error {
                chatMessages.append(ChatMessage(role: .failure, text: error))
            }
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
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

    // MARK: Inbox purpose (2026-09-01)

    /// The connect-time question: what is this mailbox FOR? Shown once after
    /// sign-in while the primary account has no answer; "나중에" dismisses it
    /// permanently (the account section can always set it later).
    var showPurposePrompt = false
    private static let purposePromptDismissedKey = "klorn.purposePromptDismissed"

    /// Chosen on the SIGNED-OUT screen, before OAuth (founder 2026-09-01:
    /// "로그인 하면서 고르게"). Applied to the primary inbox as soon as the
    /// sign-in lands and the inbox list confirms it; then cleared. Selecting
    /// nothing falls back to the post-login prompt card.
    var pendingPurpose: String?

    func applyPendingPurposeIfNeeded() {
        guard let purpose = pendingPurpose, phase == .signedIn,
              inboxes.contains(where: { $0.kind == "primary" })
        else { return }
        pendingPurpose = nil
        let session = sessionGeneration
        Task {
            await setInboxPurpose(inboxId: nil, purpose: purpose)
            guard isCurrent(session) else { return }
            // A work / mixed mailbox has a company — ask which domain right
            // after the purpose lands, exactly as the in-app card does; then
            // (or instead, for a personal mailbox) what matters to them.
            presentCompanyDomainPromptIfNeeded(purpose: purpose)
            if !showPurposePrompt { presentPrioritiesPromptIfNeeded() }
        }
    }

    // MARK: Triage priorities (2026-09-11)

    /// The user's own words about what matters — read by the lane judge and
    /// the analysis preamble (GET /inboxes). Nil until they say.
    private(set) var triagePriorities: String?
    private(set) var prioritiesError: String?
    /// Open the purpose card straight on its priorities step.
    private(set) var purposePromptStartsAtPriorities = false

    /// PATCH the text (nil / blank clears). The server collapses whitespace
    /// and refuses text past its cap; the message shows inline.
    @discardableResult
    func setTriagePriorities(_ text: String?) async -> Bool {
        struct Body: Encodable { let text: String? }
        prioritiesError = nil
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        let session = sessionGeneration
        do {
            try await api.patch(
                "/api/email/inboxes/priorities",
                encodable: Body(text: (trimmed?.isEmpty ?? true) ? nil : trimmed))
            guard isCurrent(session) else { return false }
            await refreshInboxes()
            return true
        } catch _ where !isCurrent(session) {
            return false
        } catch APIError.unauthorized {
            sessionRejected()
        } catch APIError.http(_, let message) {
            prioritiesError = message ?? L("priorities.saveFailed")
        } catch {
            prioritiesError = L("priorities.saveFailed")
            Log.app.warning("priorities update failed: \(String(describing: error), privacy: .private)")
        }
        return false
    }

    /// Ask what matters once, after the purpose (and domain) questions,
    /// while nothing is declared yet.
    func presentPrioritiesPromptIfNeeded() {
        guard !Theme.isRenderingOffscreen, phase == .signedIn, triagePriorities == nil
        else { return }
        purposePromptTarget = nil
        purposePromptStartsAtPriorities = true
        showPurposePrompt = true
    }

    // MARK: Sender labels (2026-09-11)

    /// "This sender is a customer" — the user's correction, PUT to the API,
    /// then the queue re-reads so every row from that sender (or domain)
    /// carries the chip. scope: "sender" (address) | "domain" (hostname).
    func setSenderLabel(scope: String, value: String, category: String) async {
        struct Body: Encodable {
            let scope: String
            let value: String
            let category: String
        }
        let session = sessionGeneration
        do {
            try await api.put(
                "/api/email/sender-labels",
                encodable: Body(scope: scope, value: value, category: category))
            guard isCurrent(session) else { return }
            await loadQueue()
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
        } catch {
            Log.app.warning("sender label update failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Forget one correction (a miss is fine — the row simply falls back to
    /// the evidence below the label).
    func clearSenderLabel(scope: String, value: String) async {
        var query = URLComponents()
        query.queryItems = [
            URLQueryItem(name: "scope", value: scope), URLQueryItem(name: "value", value: value),
        ]
        let session = sessionGeneration
        do {
            try await api.delete("/api/email/sender-labels?\(query.percentEncodedQuery ?? "")")
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
            return
        } catch {
            Log.app.debug("sender label clear: \(String(describing: error), privacy: .private)")
        }
        guard isCurrent(session) else { return }
        await loadQueue()
    }

    // MARK: Company domains (2026-09-10)

    /// The user's declared company email domains (GET /inboxes). A sender on
    /// one is 회사 on the row as a recorded fact; the analysis preamble names
    /// them too. Empty until declared.
    private(set) var companyDomains: [String] = []
    private(set) var companyDomainsError: String?
    /// Open the purpose card straight on its domain step (the purpose is
    /// already known — pre-login pick or account menu).
    private(set) var purposePromptStartsAtDomains = false

    /// PATCH the list; the server validates (hostname shape, public
    /// providers, cap) and echoes the canonical list. False = rejected or
    /// failed — the field keeps the user's text so they can fix it.
    @discardableResult
    func setCompanyDomains(_ domains: [String]) async -> Bool {
        struct Body: Encodable { let domains: [String] }
        companyDomainsError = nil
        let session = sessionGeneration
        do {
            try await api.patch("/api/email/inboxes/company-domains", encodable: Body(domains: domains))
            guard isCurrent(session) else { return false }
            await refreshInboxes()
            return true
        } catch _ where !isCurrent(session) {
            return false
        } catch APIError.unauthorized {
            sessionRejected()
            return false
        } catch {
            companyDomainsError = L("company.saveFailed")
            Log.app.warning("company domains update failed: \(String(describing: error), privacy: .private)")
            return false
        }
    }

    /// Ask for the company domain once the purpose says there is a company
    /// (work / mixed) and none is declared yet. Never for personal.
    func presentCompanyDomainPromptIfNeeded(purpose: String) {
        guard !Theme.isRenderingOffscreen, phase == .signedIn,
              purpose == "work" || purpose == "mixed", companyDomains.isEmpty
        else { return }
        purposePromptTarget = nil
        purposePromptStartsAtDomains = true
        showPurposePrompt = true
    }

    /// Which mailbox the open prompt is asking about. Nil = the primary
    /// account (the first-run question); a linked inbox when "Add account"
    /// just landed one. The card reads the target for its title and PATCH.
    private(set) var purposePromptTarget: InboxOption?

    func presentPurposePromptIfNeeded() {
        guard !Theme.isRenderingOffscreen, phase == .signedIn, !showTierGuide,
              !UserDefaults.standard.bool(forKey: Self.purposePromptDismissedKey),
              let primary = inboxes.first(where: { $0.kind == "primary" }),
              primary.purpose == nil
        else { return }
        purposePromptTarget = nil
        showPurposePrompt = true
    }

    /// A second account just linked: ask what IT is for. Not gated by the
    /// primary's "later" — that dismissal was about a different mailbox.
    func presentPurposePrompt(forLinked inbox: InboxOption) {
        guard !Theme.isRenderingOffscreen, phase == .signedIn, inbox.purpose == nil
        else { return }
        purposePromptTarget = inbox
        showPurposePrompt = true
    }

    /// "Later" on the primary question is permanent (the account section is
    /// the fallback); on a linked account's question it just closes — the
    /// primary's first-run card must not be silenced by it.
    func dismissPurposePrompt() {
        showPurposePrompt = false
        // The domain-only card is a follow-up, not the first-run question:
        // skipping it must not silence the purpose question.
        if purposePromptTarget == nil, !purposePromptStartsAtDomains, !purposePromptStartsAtPriorities {
            UserDefaults.standard.set(true, forKey: Self.purposePromptDismissedKey)
        }
        purposePromptTarget = nil
        purposePromptStartsAtDomains = false
        purposePromptStartsAtPriorities = false
    }

    /// Write one mailbox's purpose ("primary" or a linked id; nil clears).
    /// Optimistic close on the prompt path; the inboxes refresh reconciles.
    func setInboxPurpose(inboxId: String?, purpose: String?) async {
        struct Body: Encodable {
            let inbox: String
            let purpose: String?
        }
        let session = sessionGeneration
        do {
            try await api.patch(
                "/api/email/inboxes/purpose",
                encodable: Body(inbox: inboxId ?? "primary", purpose: purpose))
            guard isCurrent(session) else { return }
            await refreshInboxes()
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
        } catch {
            Log.app.warning("purpose update failed: \(String(describing: error), privacy: .private)")
        }
    }

    // MARK: Calendar range (real calendar views, 2026-08-26)

    /// Events for the calendar screen's visible range, keyed by the ISO range
    /// key so a stale response for a range the user already left is dropped.
    private(set) var calendarRangeEvents: [CalendarEventWire] = []
    private(set) var calendarRangeKey: String?
    private(set) var calendarRangeLoading = false

    /// Fetch events for [start, end]. The month view asks for its visible
    /// grid (±1 week around the month); the year view asks for the year.
    /// Existing GET /api/calendar?start&end — no server change.
    func loadCalendarRange(start: Date, end: Date) async {
        let iso = ISO8601DateFormatter()
        let key = iso.string(from: start) + "|" + iso.string(from: end)
        if calendarRangeKey == key, !calendarRangeEvents.isEmpty { return }
        let session = sessionGeneration
        calendarRangeLoading = true
        defer { if isCurrent(session) { calendarRangeLoading = false } }
        do {
            let resp: CalendarListResponse = try await api.get(
                "/api/calendar?start=\(iso.string(from: start))&end=\(iso.string(from: end))",
                as: CalendarListResponse.self)
            guard isCurrent(session) else { return }
            calendarRangeKey = key
            calendarRangeBounds = (start, end)
            calendarRangeEvents = resp.events
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
        } catch {
            Log.app.warning("calendar range fetch failed: \(String(describing: error), privacy: .private)")
        }
    }

    // MARK: Calendar editing (2026-09-11)

    /// The range the calendar is showing — re-read after a write.
    private(set) var calendarRangeBounds: (start: Date, end: Date)?
    var showEventEditor = false
    private(set) var editingEvent: CalendarEventWire?
    private(set) var eventEditorAnchor = Date()
    private(set) var eventEditorError: String?
    private(set) var eventEditorSaving = false

    func beginNewEvent(at day: Date) {
        editingEvent = nil
        eventEditorAnchor = day
        eventEditorError = nil
        showEventEditor = true
    }

    func beginEditingEvent(_ event: CalendarEventWire) {
        guard calendarEventIsEditable(event) else { return }  // linked calendar: read-only
        editingEvent = event
        eventEditorError = nil
        showEventEditor = true
    }

    func dismissEventEditor() {
        showEventEditor = false
        editingEvent = nil
        eventEditorError = nil
    }

    /// Re-read the visible range after a write (drops the cache key first,
    /// so loadCalendarRange does not short-circuit on the same bounds).
    func refreshCalendarRange() async {
        guard let bounds = calendarRangeBounds else { return }
        calendarRangeKey = nil
        await loadCalendarRange(start: bounds.start, end: bounds.end)
    }

    /// POST (new) or PATCH (edit). The server validates too; its message is
    /// shown as-is (a 400 names what was wrong), a Pro gate reads as
    /// error.needsPro, and the draft is kept on any failure.
    func saveEvent(_ draft: CalendarEventDraft) async -> Bool {
        struct Created: Decodable { let id: String }
        let session = sessionGeneration
        eventEditorSaving = true
        defer { if isCurrent(session) { eventEditorSaving = false } }
        eventEditorError = nil
        let payload = calendarEventPayload(draft)
        do {
            if let editing = editingEvent {
                try await api.patch("/api/calendar/\(editing.id)", encodable: payload)
            } else {
                _ = try await api.post("/api/calendar", encodable: payload, as: Created.self)
            }
            guard isCurrent(session) else { return false }
            await refreshCalendarRange()
            return true
        } catch _ where !isCurrent(session) {
            return false
        } catch APIError.unauthorized {
            sessionRejected()
        } catch APIError.forbidden {
            eventEditorError = L("error.needsPro")
        } catch APIError.http(_, let message) {
            eventEditorError = message ?? L("cal.save.failed")
        } catch {
            eventEditorError = L("cal.save.failed")
            Log.app.warning("calendar save failed: \(String(describing: error), privacy: .private)")
        }
        return false
    }

    /// DELETE — Google copy too, server-side. False = refused / failed; the
    /// caller shows it next to the button.
    func deleteEvent(_ event: CalendarEventWire) async -> Bool {
        guard calendarEventIsEditable(event) else { return false }  // linked calendar: read-only
        let session = sessionGeneration
        do {
            try await api.delete("/api/calendar/\(event.id)")
            guard isCurrent(session) else { return false }
            await refreshCalendarRange()
            return true
        } catch _ where !isCurrent(session) {
            return false
        } catch APIError.unauthorized {
            sessionRejected()
        } catch {
            Log.app.warning("calendar delete failed: \(String(describing: error), privacy: .private)")
        }
        return false
    }

    // MARK: Waiting on (2026-09-18)

    /// Threads where the latest thing I sent is unanswered (server rule:
    /// at least minDays old, nothing from someone else since). Oldest first.
    private(set) var waitingOn: [WaitingOnItem] = []
    private(set) var waitingOnMinDays = 2
    private(set) var waitingOnLoading = false

    func loadWaitingOn() async {
        let session = sessionGeneration
        waitingOnLoading = true
        defer { if isCurrent(session) { waitingOnLoading = false } }
        do {
            let resp: WaitingOnResponse = try await api.get(
                "/api/email/waiting-on", as: WaitingOnResponse.self)
            guard isCurrent(session) else { return }
            waitingOn = resp.items
            waitingOnMinDays = resp.minDays
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
        } catch {
            // An older server has no route: keep whatever we had.
            Log.app.debug("waiting-on fetch failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Open the thread's last message (mine) in the reading pane through
    /// the live folder path — it is not in the local mirror.
    func openWaitingOn(_ item: WaitingOnItem) {
        selectMailboxItem(item.asMailboxItem)
    }

    /// Render-probe seam, like the calendar's.
    func seedWaitingOnForRender(_ items: [WaitingOnItem]) {
        waitingOn = items
    }

    /// Render-probe seam: the offscreen calendar shots need events without a
    /// network. Internal, used only by PreviewRender.
    func seedCalendarForRender(_ events: [CalendarEventWire]) {
        calendarRangeEvents = events
        calendarRangeKey = "render"
    }

    // MARK: Mailbox folders (Sent / Drafts / Archived)

    /// Live folder listings, keyed by box. Fetched on first visit and on
    /// re-visit (a folder is a live Gmail view, not part of the queue poll —
    /// polling three folders every 60s would triple the Gmail read load for
    /// surfaces that are usually closed).
    private(set) var mailboxItems: [MailboxKind: [MailboxItem]] = [:]
    /// Cursor to the folder's next page; nil = no more (or older server).
    private(set) var mailboxNextToken: [MailboxKind: String] = [:]
    private(set) var mailboxLoading: MailboxKind?
    private(set) var mailboxError: String?
    /// The folder row open in the reading pane, with its live detail.
    private(set) var selectedMailboxItem: MailboxItem?
    private(set) var mailboxDetail: LiveEmailDetail.Payload?
    private(set) var mailboxDetailLoading = false

    func openMailbox(_ box: MailboxKind) {
        Task { await loadMailbox(box) }
    }

    func loadMailbox(_ box: MailboxKind) async {
        let session = sessionGeneration
        mailboxLoading = box
        mailboxError = nil
        defer { if isCurrent(session) { mailboxLoading = nil } }
        do {
            let resp: MailboxListResponse = try await api.get(
                mailboxPath(box: box, selectedInbox: selectedInbox), as: MailboxListResponse.self)
            guard isCurrent(session) else { return }
            mailboxItems[box] = resp.data.items
            mailboxNextToken[box] = resp.data.nextPageToken
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
        } catch {
            // Keep the stale listing if we had one; only surface the error
            // when the folder would otherwise be blank.
            if mailboxItems[box] == nil { mailboxError = L("mailbox.loadFailed") }
            Log.app.warning("mailbox \(box.rawValue) fetch failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Append the folder's next page (the "load more" row). The token is
    /// consumed up front so a double-tap can't fetch the same page twice;
    /// failure restores it for retry. De-dup by id: Gmail pages CAN overlap
    /// when mail arrives between requests, and an Identifiable ForEach
    /// crashes on duplicate ids.
    func loadMoreMailbox(_ box: MailboxKind) async {
        guard let token = mailboxNextToken[box], mailboxLoading != box else { return }
        let session = sessionGeneration
        mailboxNextToken[box] = nil
        mailboxLoading = box
        defer { if isCurrent(session) { mailboxLoading = nil } }
        do {
            let resp: MailboxListResponse = try await api.get(
                mailboxPath(box: box, selectedInbox: selectedInbox, pageToken: token),
                as: MailboxListResponse.self)
            guard isCurrent(session) else { return }
            let seen = Set((mailboxItems[box] ?? []).map(\.gmailId))
            mailboxItems[box, default: []]
                .append(contentsOf: resp.data.items.filter { !seen.contains($0.gmailId) })
            mailboxNextToken[box] = resp.data.nextPageToken
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
        } catch {
            mailboxNextToken[box] = token
            Log.app.warning("mailbox page fetch failed: \(String(describing: error), privacy: .private)")
        }
    }

    func selectMailboxItem(_ item: MailboxItem) {
        selectedMailboxItem = item
        mailboxDetail = nil
        mailboxDetailLoading = true
        let session = sessionGeneration
        Task {
            defer { if isCurrent(session) { mailboxDetailLoading = false } }
            do {
                let resp: LiveEmailDetail = try await api.get(
                    "/api/email/live/\(item.gmailId)\(mailboxItemQuery(inbox: item.inbox))",
                    as: LiveEmailDetail.self)
                // Stale-response guard: the user may have clicked another row
                // (or signed out) while this one was in flight.
                if isCurrent(session), selectedMailboxItem?.gmailId == item.gmailId {
                    mailboxDetail = resp.data
                }
            } catch {
                Log.app.warning("live email fetch failed: \(String(describing: error), privacy: .private)")
            }
        }
    }

    func clearMailboxSelection() {
        selectedMailboxItem = nil
        mailboxDetail = nil
    }

    /// Render-probe seam: the offscreen shots need a populated folder without
    /// a network. Internal, used only by PreviewRender.
    func seedMailboxForRender(_ box: MailboxKind, items: [MailboxItem]) {
        mailboxItems[box] = items
    }

    private func refreshCommitments() async {
        let session = sessionGeneration
        do {
            let resp: CommitmentsResponse = try await api.get(
                "/api/commitments?status=OPEN&limit=50", as: CommitmentsResponse.self)
            guard isCurrent(session) else { return }
            commitments = resp.commitments
            commitmentsFailed = false
        } catch _ where !isCurrent(session) {
            return
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
        let session = sessionGeneration
        do {
            try await api.patch("/api/commitments/\(item.id)", json: ["status": status])
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
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
        let session = sessionGeneration
        isSearching = true
        defer { if isCurrent(session) { isSearching = false } }
        do {
            // Scoped to the selected inbox ("all" adds nothing) — the desktop
            // list must honor the same per-inbox scope as the web inbox.
            let resp: EmailSearchResponse = try await api.get(
                emailSearchPath(query: query, selectedInbox: selectedInbox),
                as: EmailSearchResponse.self)
            guard isCurrent(session) else { return }
            searchResults = resp.emails
            searchTotal = resp.total
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
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
        let session = sessionGeneration
        isLoadingEmail = true
        defer { if isCurrent(session) { isLoadingEmail = false } }
        do {
            let detail = try await api.get(
                "/api/email/\(hit.id)", as: EmailDetail.self)
            guard isCurrent(session) else { return }
            openedEmail = detail
            // Same contract as openItem: explicit PATCH write, never a GET
            // side effect; failures degrade to leaving the mail unread.
            Task { try? await api.patch("/api/email/\(hit.id)/read", json: [:]) }
            openedEmailIds = openedEmailIds.union([hit.id])
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
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
        let session = sessionGeneration
        do {
            try await api.post("/api/inbox/firewall/\(item.id)", json: ["tier": tier.rawValue])
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
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
        let session = sessionGeneration
        await setTier(item, to: tier)
        guard isCurrent(session) else { return }
        do {
            try await api.post("/api/email/\(emailId)/pin-tier", json: ["tier": tier.rawValue])
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
        } catch {
            noteActionFailure(error)
            Log.app.warning("pin sender failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Remove the sender's pin. Idempotent server-side; no local state to roll
    /// back — future mails simply go back to predicted tiers.
    func unpinSender(_ item: FirewallItem) async {
        guard let emailId = item.email?.emailDbId else { return }
        let session = sessionGeneration
        do {
            try await api.delete("/api/email/\(emailId)/pin-tier")
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
        } catch {
            noteActionFailure(error)
            Log.app.warning("unpin sender failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Snooze a PUSH item until `until`; it resurfaces server-side when the time
    /// passes. Works for any source (uses the AttentionItem id, not the email id).
    /// Returns the failure message when the snooze did not take and the item
    /// came back, so a surface that already moved on (the HUD card) can say so.
    @discardableResult
    func snooze(
        _ item: FirewallItem, until: Date = AppModel.tomorrow9am(), session: Int? = nil
    ) async -> String? {
        // A surface from a session that has ended snoozes nothing.
        let session = session ?? sessionGeneration
        guard isCurrent(session) else { return nil }
        hideLocally(item)
        do {
            try await api.post(
                "/api/inbox/firewall/\(item.id)/snooze",
                json: ["snoozeUntil": ISO8601DateFormatter().string(from: until)])
            return nil
        } catch _ where !isCurrent(session) {
            return nil
        } catch APIError.unauthorized {
            sessionRejected()
            return nil
        } catch {
            return unhide(item, error)
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
    @discardableResult
    private func unhide(_ item: FirewallItem, _ error: Error) -> String? {
        dismissed.remove(item.id)
        let message = noteActionFailure(error)
        Task { await loadQueue() }
        return message
    }

    /// Default snooze target: 9am local tomorrow. Pure for testing. Delegates to
    /// `SnoozeOption` so the resurface math lives in one place.
    nonisolated static func tomorrow9am(from now: Date = Date(), calendar: Calendar = .current) -> Date {
        SnoozeOption.tomorrow.resurface(from: now, calendar: calendar)
    }

    /// The user's sign-out, or a 401 on a live session (`sessionRejected`).
    /// Signed out already, there is no session to end: nothing happens, and
    /// the generation an in-flight sign-in is waiting on stays put. During
    /// a sign-in this is the user backing out, and it abandons the attempt.
    func signOut() {
        guard phase != .signedOut else { return }
        signInTask?.cancel()
        // First: from here on, nothing the leaving session started is current.
        sessionGeneration += 1
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
        // Read before the Keychain is cleared: the device-calendar removals owed at
        // sign-out are sent with this session's token.
        let sessionToken = tokenStore.load()
        tokenStore.clear()
        queue = nil
        // The per-inbox snapshots are the previous account's mail: an inbox
        // switch after the next sign-in must never paint them.
        queueCache = [:]
        loadError = nil
        dismissActionError()
        // Cross-account hygiene: every per-account surface must reset, or the
        // next sign-in briefly shows the previous account's data.
        today = nil
        weekAhead = nil
        usage = nil
        briefing = nil
        briefingStructure = nil
        inboxes = []
        openedEmailIds = []
        selectedInbox = "all"
        UserDefaults.standard.removeObject(forKey: Self.selectedInboxKey)
        shownMeetingIds = []
        // The device-calendar opt-in belongs to the account that gave it.
        deviceCalendars.signOut(token: sessionToken)
        // A draft belongs to the account that wrote it: the next account
        // must not find it, send it, or delete the Gmail draft it edits.
        // Putting the composer away also closes the compose window (M5).
        discardComposeDraft()
        showCompose = false
        resetAccountState()
        phase = .signedOut
        onSessionEnded?()
    }

    /// The rest of what was fetched for, or typed by, the account that is
    /// leaving, and the in-flight flags of the requests it started: those
    /// requests no longer report back (`isCurrent`), so nothing else would
    /// lower them. Driven by `accountFields()`, which the self-check walks
    /// too, so a field added there is reset and checked in one edit.
    private func resetAccountState() {
        for field in Self.accountFields() { field.reset(self) }
    }

    /// One per-account field: how to reset it, how to tell it is reset, and
    /// (where a value is cheap to make) how to dirty it for the self-check.
    struct AccountField {
        let name: String
        let reset: (AppModel) -> Void
        let isClean: (AppModel) -> Bool
        let dirty: ((AppModel) -> Void)?
    }

    private static func field<V: Equatable>(
        _ name: String, _ path: ReferenceWritableKeyPath<AppModel, V>, _ clean: V, dirty: V
    ) -> AccountField {
        AccountField(
            name: name, reset: { $0[keyPath: path] = clean },
            isClean: { $0[keyPath: path] == clean }, dirty: { $0[keyPath: path] = dirty })
    }

    private static func field<V>(
        _ name: String, _ path: ReferenceWritableKeyPath<AppModel, V>, _ clean: V,
        isClean: @escaping (V) -> Bool, dirty: V? = nil
    ) -> AccountField {
        AccountField(
            name: name, reset: { $0[keyPath: path] = clean },
            isClean: { isClean($0[keyPath: path]) },
            dirty: dirty.map { value in { $0[keyPath: path] = value } })
    }

    private static func flag(_ name: String, _ path: ReferenceWritableKeyPath<AppModel, Bool>) -> AccountField {
        field(name, path, false, dirty: true)
    }

    private static func text(_ name: String, _ path: ReferenceWritableKeyPath<AppModel, String?>) -> AccountField {
        field(name, path, nil, dirty: "x")
    }

    /// Everything `resetAccountState` resets. Internal for the self-check.
    static func accountFields() -> [AccountField] {
        [
            flag("isLoadingQueue", \.isLoadingQueue),
            flag("cancelledLoadRetried", \.cancelledLoadRetried),
            flag("isLoadingEmail", \.isLoadingEmail),
            flag("isDrafting", \.isDrafting),
            flag("isSummarizing", \.isSummarizing),
            flag("summarizeFailed", \.summarizeFailed),
            flag("composeSending", \.composeSending),
            flag("isChatting", \.isChatting),
            field("chatMessages", \.chatMessages, [], dirty: [ChatMessage(role: .user, text: "x")]),
            text("chatConversationId", \.chatConversationId),
            field("commitments", \.commitments, nil, isClean: { $0 == nil }, dirty: .some([])),
            flag("commitmentsFailed", \.commitmentsFailed),
            field("pendingActions", \.pendingActions, [], isClean: { $0.isEmpty }),
            text("pendingActionError", \.pendingActionError),
            field("resolvingActions", \.resolvingActions, [], dirty: ["x"]),
            field("agentToday", \.agentToday, nil, isClean: { $0 == nil }),
            field("automation", \.automation, AutomationSettings(), isClean: { $0 == AutomationSettings() }),
            flag("automationLoaded", \.automationLoaded),
            flag("automationSaving", \.automationSaving),
            text("automationError", \.automationError),
            field("mailboxItems", \.mailboxItems, [:], dirty: [.sent: []]),
            field("mailboxNextToken", \.mailboxNextToken, [:], dirty: [.sent: "x"]),
            field("mailboxLoading", \.mailboxLoading, nil, dirty: .sent),
            text("mailboxError", \.mailboxError),
            flag("mailboxDetailLoading", \.mailboxDetailLoading),
            field("selectedMailboxItem", \.selectedMailboxItem, nil, isClean: { $0 == nil }),
            field("mailboxDetail", \.mailboxDetail, nil, isClean: { $0 == nil }),
            field("searchResults", \.searchResults, nil, isClean: { $0 == nil }, dirty: .some([])),
            field("searchTotal", \.searchTotal, 0, dirty: 3),
            flag("isSearching", \.isSearching),
            field("waitingOn", \.waitingOn, [], isClean: { $0.isEmpty }),
            flag("waitingOnLoading", \.waitingOnLoading),
            field("calendarRangeEvents", \.calendarRangeEvents, [], isClean: { $0.isEmpty }),
            text("calendarRangeKey", \.calendarRangeKey),
            field(
                "calendarRangeBounds", \.calendarRangeBounds, nil, isClean: { $0 == nil },
                dirty: .some((start: Date(timeIntervalSince1970: 0), end: Date(timeIntervalSince1970: 1)))),
            flag("calendarRangeLoading", \.calendarRangeLoading),
            flag("eventEditorSaving", \.eventEditorSaving),
            flag("showEventEditor", \.showEventEditor),
            field("editingEvent", \.editingEvent, nil, isClean: { $0 == nil }),
            text("eventEditorError", \.eventEditorError),
            field("teams", \.teams, [], isClean: { $0.isEmpty }),
            text("teamError", \.teamError),
            flag("teamModeAvailable", \.teamModeAvailable),
            field("teamAvailability", \.teamAvailability, nil, isClean: { $0 == nil }),
            text("checkingTeamId", \.checkingTeamId),
            text("teamBookingResult", \.teamBookingResult),
            field("imapAccounts", \.imapAccounts, [], isClean: { $0.isEmpty }),
            text("imapError", \.imapError),
            flag("isConnectingImap", \.isConnectingImap),
            flag("isLinkingAccount", \.isLinkingAccount),
            field("companyDomains", \.companyDomains, [], dirty: ["x.example"]),
            text("companyDomainsError", \.companyDomainsError),
            text("triagePriorities", \.triagePriorities),
            text("prioritiesError", \.prioritiesError),
            field("diagnostics", \.diagnostics, [], isClean: { $0.isEmpty }),
            flag("diagnosticsInFlight", \.diagnosticsInFlight),
            text("diagnosticsError", \.diagnosticsError),
            flag("showPurposePrompt", \.showPurposePrompt),
            field("purposePromptTarget", \.purposePromptTarget, nil, isClean: { $0 == nil }),
            flag("purposePromptStartsAtDomains", \.purposePromptStartsAtDomains),
            flag("purposePromptStartsAtPriorities", \.purposePromptStartsAtPriorities),
        ]
    }

    /// Self-check seam: put every field that has a cheap non-default value
    /// into it, so the reset is checked against state that was really there.
    func dirtyAccountStateForCheck() {
        for field in Self.accountFields() { field.dirty?(self) }
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
        if case .updateAvailable(let version) = await updateCheck() {
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
        if case .updateAvailable(let version) = await updateCheck() {
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
        let session = sessionGeneration
        diagnosticsInFlight = true
        defer { if isCurrent(session) { diagnosticsInFlight = false } }
        diagnosticsError = nil
        do {
            let res = try await api.get("/api/ops/readiness", as: ReadinessResponse.self)
            guard isCurrent(session) else { return }
            diagnostics = diagnosticHighlights(res.checks)
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()
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
        let session = sessionGeneration
        do {
            let today = try await api.get("/api/briefing/today", as: TodayBriefing.self)
            guard isCurrent(session) else { return }
            briefing = briefingPreview(today.briefing?.content)
            briefingStructure = today.structured
        } catch {
            Log.app.debug("briefing fetch failed: \(String(describing: error), privacy: .private)")
        }
    }

    private func refreshToday() async {
        let session = sessionGeneration
        do {
            let summary = try await api.get("/api/calendar/today/summary", as: TodaySummary.self)
            guard isCurrent(session) else { return }
            today = summary
        } catch {
            Log.app.debug("today summary fetch failed: \(String(describing: error), privacy: .private)")
        }
        // The meeting card below is planned from this session's calendar only.
        guard isCurrent(session) else { return }
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
        let session = sessionGeneration
        do {
            let resp: CalendarListResponse = try await api.get(
                "/api/calendar?days=8", as: CalendarListResponse.self)
            guard isCurrent(session) else { return }
            weekAhead = resp.events
        } catch {
            Log.app.debug("week-ahead fetch failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Daily AI quota for the ACCOUNT gauge. Best-effort on the same tick.
    private(set) var usage: BillingStatusWire.Usage?

    private func refreshUsage() async {
        let session = sessionGeneration
        do {
            let status: BillingStatusWire = try await api.get("/api/billing/models", as: BillingStatusWire.self)
            guard isCurrent(session) else { return }
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
        let session = sessionGeneration
        do {
            let fetched = try await api.fetchAutomationSettings()
            guard isCurrent(session) else { return }
            automation = fetched
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
        let session = sessionGeneration
        Task {
            do {
                let stored = try await api.updateAutomationSettings(next)
                guard isCurrent(session) else { return }
                automation = stored
                automationLoaded = true
            } catch {
                guard isCurrent(session) else { return }
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
        let session = sessionGeneration
        do {
            let resp: PendingActionsResponse = try await api.get(
                "/api/chat/pending-actions", as: PendingActionsResponse.self)
            guard isCurrent(session) else { return }
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
        let session = sessionGeneration
        Task {
            do {
                try await api.post(
                    "/api/chat/pending-actions/\(action.id)/\(approve ? "approve" : "reject")")
                guard isCurrent(session) else { return }
                // The agent receipt counts this action too, so refresh both.
                await refreshAgentToday()
                await refreshPendingActions()
            } catch {
                guard isCurrent(session) else { return }
                pendingActions = previous
                pendingActionError = Self.automationErrorText(error)
                Log.app.debug("pending action resolve failed: \(String(describing: error), privacy: .private)")
            }
            guard isCurrent(session) else { return }
            resolvingActions.remove(action.id)
        }
    }

    /// GET /api/calendar/:id/prep-pack for the meeting card. Best-effort.
    func fetchPrepPack(eventId: String, session: Int? = nil) async -> MeetingPrepPack? {
        let session = session ?? sessionGeneration
        guard isCurrent(session) else { return nil }
        do {
            let pack = try await api.get("/api/calendar/\(eventId)/prep-pack", as: MeetingPrepPack.self)
            return isCurrent(session) ? pack : nil
        } catch {
            Log.app.debug("prep pack fetch failed: \(String(describing: error), privacy: .private)")
            return nil
        }
    }

    func loadQueue() async {
        let session = sessionGeneration
        isLoadingQueue = true
        defer { if isCurrent(session) { isLoadingQueue = false } }
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
            // A response that outlived its session is the previous account's
            // mail: it reaches neither the cache nor the screen.
            guard isCurrent(session) else { return }
            queueCache[selectionAtFetch] = fetched
            // A slow response for a selection the user has already left must
            // not clobber the queue they're looking at now.
            guard selectionAtFetch == selectedInbox else { return }
            // Drop dismissed ids the server has since resolved; hide the rest.
            dismissed.formIntersection(fetched.allItemIDs)
            queue = fetched.removingIDs(dismissed)
            // The reply axis's other half rides the same poll — one DB-only GET.
            await loadWaitingOn()
            guard isCurrent(session) else { return }
            loadError = nil
            cancelledLoadRetried = false
            reconcilePush()
            ensureActive()
        } catch _ where !isCurrent(session) {
            return
        } catch APIError.unauthorized {
            sessionRejected()  // token expired/invalid — drop to sign-in
        } catch {
            noteLoadFailure(error)
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
        guard opensRealtime, realtime == nil, let token = tokenStore.load() else { return }
        let session = sessionGeneration
        let client = RealtimeClient(onWake: { [weak self] in
            self?.realtimeDidWake(session: session)
        })
        client.start(token: token)
        realtime = client
    }

    /// A server push on the wake channel that `session` opened. The socket
    /// is stopped at sign-out, but a message it had already received can
    /// still be delivered: a wake that outlived its session refetches
    /// nothing. Internal, and returning whether a refetch started, for the
    /// self-check.
    @discardableResult
    func realtimeDidWake(session: Int) -> Bool {
        // Skip if a load is already in flight — avoids overlapping refetches
        // if the server bursts events.
        guard isCurrent(session), !isLoadingQueue else { return false }
        Task { await loadQueue() }
        return true
    }

    private func startPolling() {
        let session = sessionGeneration
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: self?.pollInterval ?? .seconds(AppModel.pollIntervalSeconds))
                // Cancelled at sign-out; the session check covers a tick
                // that was already past the sleep.
                guard !Task.isCancelled, let self, self.isCurrent(session) else { break }
                await self.loadQueue()
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
    /// Record a failed load: the message, and whether it was the network.
    /// Refresh failures only: this is what raises the offline / "couldn't
    /// refresh" states. A cancelled request is not a failure.
    private func noteLoadFailure(_ error: Error) {
        let kind = SurfaceStateRules.failureKind(error)
        guard kind != .ignored else { return recoverCancelledLoad() }
        cancelledLoadRetried = false
        loadError = Self.describe(error)
        loadOffline = kind == .offline
    }

    /// One retry has been spent on a cancelled first load.
    private var cancelledLoadRetried = false

    /// A cancelled load is not an error, but with nothing loaded and nothing
    /// wrong the surface would sit on "loading" until the next poll tick
    /// (which may not exist yet: polling starts after the first load). Load
    /// once more, in a task of its own since the caller's is the one that
    /// was cancelled; if that is cancelled too, show the failed state, whose
    /// Retry is the way out.
    private func recoverCancelledLoad() {
        guard phase == .signedIn else { return }
        switch SurfaceStateRules.cancelledLoadRecovery(
            hasQueue: queue != nil, hasError: loadError != nil, retried: cancelledLoadRetried)
        {
        case .none:
            return
        case .retry:
            cancelledLoadRetried = true
            Task { await loadQueue() }
        case .fail:
            cancelledLoadRetried = false
            loadError = L("error.unreachable")
            loadOffline = false
        }
    }

    /// A failed action on one mail (pin, unpin, dismiss, snooze). Shown as
    /// a transient notice; it says nothing about whether the list is fresh.
    private(set) var actionError: String?
    private var actionErrorTask: Task<Void, Never>?
    static let actionErrorSeconds = 6

    /// Returns the message it showed, nil for a cancelled request.
    @discardableResult
    private func noteActionFailure(_ error: Error) -> String? {
        guard SurfaceStateRules.failureKind(error) != .ignored else { return nil }
        let message = Self.describe(error)
        showActionError(message)
        return message
    }

    /// Internal so the render and self-check harnesses can raise one.
    func showActionError(_ message: String) {
        actionError = message
        actionErrorTask?.cancel()
        actionErrorTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.actionErrorSeconds))
            guard !Task.isCancelled else { return }
            self?.actionError = nil
        }
    }

    func dismissActionError() {
        actionErrorTask?.cancel()
        actionError = nil
    }

    /// Try again, from a state view, the banner or the pill's chip. One
    /// retry at a time: clicks while a load is in flight do nothing.
    func retryLoad() async {
        guard SurfaceStateRules.mayRetry(isLoading: isLoadingQueue) else { return }
        await loadQueue()
    }

    private static func describe(_ error: Error) -> String {
        Log.app.error("queue load failed: \(String(describing: error), privacy: .private)")
        switch error {
        case APIError.http(let code, let msg): return msg ?? L("error.server", code)
        case APIError.transport:
            return SurfaceStateRules.failureKind(error) == .offline
                ? L("error.network") : L("error.unreachable")
        case APIError.decoding: return L("error.badResponse")
        case APIError.unauthorized: return L("error.sessionExpired")
        case APIError.forbidden: return L("error.needsPro")
        default: return L("error.generic")
        }
    }
}
