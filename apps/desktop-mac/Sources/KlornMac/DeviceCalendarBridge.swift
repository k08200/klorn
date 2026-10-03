import AppKit
import EventKit
import Foundation
import IOKit
import Observation

// Step C6 (docs/providers/unified-platform-plan.md): upload the calendars on this
// Mac that the user turns on, one by one (decision P4), to
// /api/device-calendar. Nothing is read from EventKit, and no permission is asked,
// until the user turns "Upload device calendars" on; every calendar starts OFF.
// Each enabled calendar is uploaded as a full snapshot of a bounded window
// (DeviceCalendarSnapshot) when it is turned on, when the calendar store changes
// (debounced), at launch and every 15 minutes; turning one off deletes it on the
// server. A 404 from the server means the feature is off there: the setting hides.
// EventKit is read, and each snapshot built and encoded, off the main thread
// (DeviceCalendarReader); this file keeps UI state and the order of requests.

/// What macOS lets Klorn do with the calendars.
enum DeviceCalendarAccess: Equatable, Sendable {
    case notDetermined, granted, denied

    /// macOS 14 split full access from write-only; only full access can read events.
    static func from(_ status: EKAuthorizationStatus) -> DeviceCalendarAccess {
        switch status {
        case .fullAccess: return .granted
        case .notDetermined: return .notDetermined
        case .denied, .restricted, .writeOnly: return .denied
        @unknown default: return .denied
        }
    }
}

/// One EventKit calendar as the settings list shows it. `id` is the local
/// EventKit identifier; it never leaves the Mac (the server gets `sourceKey`).
struct DeviceCalendarItem: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let account: String
}

/// A stable id for this Mac, hashed into every source key: the hardware UUID, or a
/// random one kept in the defaults when IOKit has none. Stable across reinstalls
/// and sign-outs, so turning a calendar back on resumes the same source.
enum DeviceIdentity {
    static let fallbackKey = "klorn.deviceCalendars.deviceId"

    static func current(defaults: UserDefaults = .standard) -> String {
        if let uuid = platformUUID(), !uuid.isEmpty { return uuid }
        if let stored = defaults.string(forKey: fallbackKey) { return stored }
        let fresh = UUID().uuidString
        defaults.set(fresh, forKey: fallbackKey)
        return fresh
    }

    private static func platformUUID() -> String? {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        let value = IORegistryEntryCreateCFProperty(service, kIOPlatformUUIDKey as CFString, kCFAllocatorDefault, 0)
        return value?.takeRetainedValue() as? String
    }
}


@MainActor
@Observable
final class DeviceCalendarBridge {
    enum Availability: Equatable { case unknown, available, unavailable }

    /// Every enabled calendar is re-checked this often (an unchanged one is skipped).
    nonisolated static let refreshInterval: Duration = .seconds(15 * 60)
    /// EKEventStoreChanged fires in bursts (a sync touches many events).
    nonisolated static let changeDebounce: Duration = .seconds(5)
    /// A probe that failed for any reason but the server's 404 (offline at launch).
    nonisolated static let probeRetryInterval: Duration = .seconds(5 * 60)
    /// An unchanged snapshot is still re-sent after this long, so a server that
    /// lost it heals without a change on the Mac, and its source never expires
    /// (the server removes a source not refreshed for 14 days).
    nonisolated static let resendUnchangedAfter: TimeInterval = 6 * 3600
    nonisolated static let settingsURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"

    private(set) var availability: Availability = .unknown
    private(set) var access: DeviceCalendarAccess
    private(set) var optIn: DeviceCalendarOptIn
    private(set) var calendars: [DeviceCalendarItem] = []
    private(set) var lastError: String?
    private(set) var isBusy = false

    var uploadEnabled: Bool { optIn.uploadEnabled }
    var enabledIds: Set<String> { optIn.calendarIds }

    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let deviceId: () -> String
    @ObservationIgnored private let currentUser: () -> String?
    @ObservationIgnored private let makeStore: @MainActor () -> any DeviceCalendarStore
    @ObservationIgnored private let authorization: () -> DeviceCalendarAccess
    /// Created only once the user turned the feature on.
    @ObservationIgnored private var store: (any DeviceCalendarStore)?
    @ObservationIgnored private var cachedDeviceId: String?
    @ObservationIgnored private var changeObserver: NSObjectProtocol?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var debounceTask: Task<Void, Never>?
    @ObservationIgnored private var probeRetryTask: Task<Void, Never>?
    /// The last job queued: every network job (upload pass, removal, sign-out
    /// removal, launch reconcile) runs after the previous one finished, so a DELETE
    /// can never be overtaken by a PUT that recreates the source.
    @ObservationIgnored private var tail: Task<Void, Never>?
    @ObservationIgnored private var passQueued = false
    /// Calendar id -> the last content sent and when, to skip an unchanged snapshot.
    @ObservationIgnored private var lastSent: [String: (fingerprint: Data, at: Date)] = [:]

    init(
        api: APIClient = APIClient(),
        defaults: UserDefaults = .standard,
        deviceId: @escaping () -> String = { DeviceIdentity.current() },
        currentUser: @escaping () -> String? = { SessionIdentity.userId(fromToken: KeychainStore.load()) },
        makeStore: @escaping @MainActor () -> any DeviceCalendarStore = { DeviceCalendarReader() },
        authorization: @escaping () -> DeviceCalendarAccess = {
            DeviceCalendarAccess.from(EKEventStore.authorizationStatus(for: .event))
        }
    ) {
        self.api = api
        self.defaults = defaults
        self.deviceId = deviceId
        self.currentUser = currentUser
        self.makeStore = makeStore
        self.authorization = authorization
        self.access = authorization()
        self.optIn = DeviceCalendarOptIn.load(from: defaults)
    }

    /// True once EventKit has been touched (self-check: never before the opt-in).
    var hasEventStore: Bool { store != nil }

    // MARK: Lifecycle

    /// Signed in (launch or sign-in): learn whether the server has the feature,
    /// settle this Mac's leftovers against it, send any removal still owed to this
    /// user, and resume uploading if the user turned it on before.
    func start() {
        enqueue { [weak self] in await self?.launch() }
    }

    /// Re-asked each time Preferences opens, so a server flip shows or hides the
    /// section without a relaunch.
    func refreshAvailability() async {
        await enqueue { [weak self] in await self?.launch() }.value
    }

    /// Wait until every queued job ran (self-check).
    func idle() async {
        while let current = tail {
            await current.value
            if tail == current { return }
        }
    }

    private func launch() async {
        let (answer, serverKeys) = await probe(with: api)
        switch answer {
        case .available:
            availability = .available
            if let user = currentUser() {
                let enabledKeys = Set(optIn.calendarIds.map(sourceKey(for:)))
                commit(optIn.reconciled(serverKeys: serverKeys, enabledKeys: enabledKeys, user: user))
                await processRemovals(for: user, client: api)
            }
            await activateIfReady()
        case .unavailable:
            availability = .unavailable
            deactivate()
        case .unknown:
            scheduleProbeRetry()
        }
    }

    /// GET /sources: 200 = the feature is on (with the user's source keys), the
    /// default 404 = it is off, anything else = unknown (asked again later).
    private func probe(with client: APIClient) async -> (Availability, Set<String>) {
        do {
            let response = try await client.fetchDeviceCalendarSources()
            return (.available, Set(response.sources.map(\.key)))
        } catch {
            Log.net.debug("device calendars probe: \(String(describing: error), privacy: .private)")
            return (Self.isFeatureOff(error) ? .unavailable : .unknown, [])
        }
    }

    private func scheduleProbeRetry() {
        guard probeRetryTask == nil else { return }
        probeRetryTask = Task { [weak self] in
            try? await Task.sleep(for: Self.probeRetryInterval)
            guard !Task.isCancelled else { return }
            self?.probeRetryTask = nil
            self?.start()
        }
    }

    /// Signing out ends the opt-in on this Mac (another account must opt in itself)
    /// and owes a DELETE for every source that was on, kept for that user until the
    /// server confirms it: sent now with the session's own token (read before the
    /// Keychain is cleared), queued behind any upload in flight, and retried at that
    /// user's next sign-in here if it fails. A Mac that never returns is covered by
    /// the server's expiry (14 days).
    func signOut(token: String?) {
        let user = SessionIdentity.userId(fromToken: token)
        let enabledKeys = Set(optIn.calendarIds.map(sourceKey(for:)))
        commit(optIn.switchedOff(user: user, enabledKeys: enabledKeys))
        deactivate()
        availability = .unknown
        calendars = []
        lastSent = [:]
        lastError = nil
        store = nil
        guard let user, let token, !optIn.pending(for: user).isEmpty else { return }
        var client = api
        client.token = { token }
        enqueue { [weak self] in await self?.processRemovals(for: user, client: client) }
    }

    // MARK: User actions

    /// The master switch. On: ask macOS for access (the only place that asks), then
    /// list the calendars, all off. Off: every uploaded calendar is deleted.
    func setUploadEnabled(_ on: Bool) async {
        lastError = nil
        guard on else {
            let enabledKeys = Set(optIn.calendarIds.map(sourceKey(for:)))
            commit(optIn.switchedOff(user: currentUser(), enabledKeys: enabledKeys))
            lastSent = [:]
            deactivate()
            await runPass()
            return
        }
        isBusy = true
        defer { isBusy = false }
        let reader = store ?? makeStore()
        store = reader
        let granted = await reader.requestAccess()
        access = granted ? .granted : .denied
        var next = optIn
        next.uploadEnabled = granted
        commit(next)
        if granted { await activateIfReady() }
    }

    /// One calendar's toggle. On uploads it now; off deletes it on the server. Only
    /// this deletes a source: a calendar missing from this Mac merely pauses.
    func setCalendar(_ id: String, enabled: Bool) async {
        lastError = nil
        let key = sourceKey(for: id)
        lastSent[id] = nil
        commit(enabled
            ? optIn.enabling(id, key: key, user: currentUser())
            : optIn.disabling(id, key: key, user: currentUser()))
        await runPass()
    }

    func openPrivacySettings() {
        if let url = URL(string: Self.settingsURL) { NSWorkspace.shared.open(url) }
    }

    // MARK: Uploading

    private func activateIfReady() async {
        guard availability == .available, uploadEnabled else { return }
        access = authorization()
        guard access == .granted else { return }
        let reader = store ?? makeStore()
        store = reader
        calendars = await reader.calendars()
        if changeObserver == nil {
            // object nil: the reader's store is the only one in the process, and it
            // lives on the reader's actor.
            changeObserver = NotificationCenter.default.addObserver(
                forName: .EKEventStoreChanged, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.storeChanged() }
            }
        }
        if refreshTask == nil {
            // Holds the bridge weakly, also across the sleep: once the bridge is
            // gone the loop ends instead of ticking forever.
            refreshTask = Task { [weak self] in
                while !Task.isCancelled {
                    guard self?.refreshTick() == true else { return }
                    try? await Task.sleep(for: Self.refreshInterval)
                }
            }
        }
    }

    private func refreshTick() -> Bool {
        startPass()
        return true
    }

    private func deactivate() {
        refreshTask?.cancel()
        refreshTask = nil
        debounceTask?.cancel()
        debounceTask = nil
        probeRetryTask?.cancel()
        probeRetryTask = nil
        if let changeObserver { NotificationCenter.default.removeObserver(changeObserver) }
        changeObserver = nil
    }

    private func storeChanged() {
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(for: Self.changeDebounce)
            guard !Task.isCancelled, let self else { return }
            if let reader = self.store { self.calendars = await reader.calendars() }
            self.startPass()
        }
    }

    /// Queue a job after the last one. A job runs in a task of its own, so
    /// cancelling a loop or a debounce never cancels a request in flight.
    @discardableResult
    private func enqueue(_ job: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        let previous = tail
        let task = Task { @MainActor in
            await previous?.value
            await job()
        }
        tail = task
        return task
    }

    /// One upload pass and the removals owed, queued; at most one waits at a time.
    private func startPass() {
        guard !passQueued else { return }
        passQueued = true
        enqueue { [weak self] in
            guard let self else { return }
            self.passQueued = false
            await self.uploadEnabledCalendars()
            if let user = self.currentUser() { await self.processRemovals(for: user, client: self.api) }
        }
    }

    /// One pass now, awaited (a switch in Settings; the self-check).
    func runPass() async {
        startPass()
        await idle()
    }

    private func uploadEnabledCalendars() async {
        guard availability == .available, uploadEnabled, access == .granted,
              let reader = store, let user = currentUser() else { return }
        let untitled = L("deviceCalendars.untitled")
        for id in optIn.calendarIds.sorted() {
            // Absent from this Mac right now (an account briefly unavailable): skip,
            // never delete. Only a switch-off deletes; the server expires a source
            // that is never refreshed again.
            guard let prepared = await reader.snapshot(calendarId: id, now: Date(), untitled: untitled)
            else { continue }
            // Switched off (or signed out) while the snapshot was read: do not send.
            guard uploadEnabled, optIn.calendarIds.contains(id) else { continue }
            if let last = lastSent[id], !Self.shouldResend(
                lastFingerprint: last.fingerprint, lastAt: last.at, fingerprint: prepared.fingerprint, now: Date()) {
                continue
            }
            guard await upload(prepared, calendarId: id, user: user) else { return }
        }
    }

    /// False when the pass must stop (feature off, signed out, rate limited).
    private func upload(_ prepared: PreparedSnapshot, calendarId: String, user: String) async -> Bool {
        let key = sourceKey(for: calendarId)
        do {
            let reply = try await api.putDeviceCalendarSnapshot(key: key, body: prepared.body)
            // Ignored as older than what the server holds: not a send. Nothing is
            // recorded, so the next pass reads the calendar again and retries.
            guard reply == .applied else { return true }
            lastSent[calendarId] = (prepared.fingerprint, Date())
            lastError = nil
            commit(optIn.uploadedSource(key, user: user))
            return true
        } catch {
            return handleUploadError(error)
        }
    }

    private func handleUploadError(_ error: Error) -> Bool {
        if Task.isCancelled { return false }
        Log.net.error("device calendar upload failed: \(String(describing: error), privacy: .private)")
        switch error {
        case _ where Self.isFeatureOff(error):
            availability = .unavailable
            deactivate()
            return false
        case APIError.unauthorized:
            return false
        case APIError.forbidden:
            lastError = L("error.needsPro")
            return false
        case APIError.http(409, let code):
            lastError = L(Self.conflictErrorKey(serverCode: code))
            return true
        case APIError.http(429, _):
            return false
        default:
            lastError = L("deviceCalendars.error.generic")
            return true
        }
    }

    /// DELETE every source owed for `user`, with `client` (the session's token).
    /// A key is dropped only when the server confirms: 200, or a 404 while the
    /// feature answers (already gone). A 404 while it does not answer, or any other
    /// failure, keeps the key for the next pass or the user's next sign-in.
    private func processRemovals(for user: String, client: APIClient) async {
        for key in optIn.pending(for: user).sorted() {
            do {
                try await client.deleteDeviceCalendarSource(key: key)
                commit(optIn.removedSource(key, user: user))
            } catch APIError.http(404, _) {
                guard await probe(with: client).0 == .available else { return }
                commit(optIn.removedSource(key, user: user))
            } catch {
                Log.net.error("device calendar removal failed: \(String(describing: error), privacy: .private)")
                return
            }
        }
    }

    // MARK: Pure helpers (self-checked)

    /// The server's dark gate answers Fastify's default 404 on every route.
    nonisolated static func isFeatureOff(_ error: Error) -> Bool {
        if case APIError.http(404, _) = error { return true }
        return false
    }

    /// The server's code for a row-cap 409 (DEVICE_ROW_CAP_CODE in
    /// packages/api/src/routes/device-calendar.ts; the self-check pins the pair).
    nonisolated static let rowCapCode = "device_row_cap"

    /// Which text a 409 gets: too many events stored, or (any other code, or none)
    /// too many calendars switched on.
    nonisolated static func conflictErrorKey(serverCode: String?) -> String {
        serverCode == rowCapCode ? "deviceCalendars.error.rows" : "deviceCalendars.error.limit"
    }

    nonisolated static func shouldResend(lastFingerprint: Data, lastAt: Date, fingerprint: Data, now: Date) -> Bool {
        lastFingerprint != fingerprint || now.timeIntervalSince(lastAt) >= resendUnchangedAfter
    }

    // MARK: Private

    private func sourceKey(for calendarId: String) -> String {
        let id = cachedDeviceId ?? deviceId()
        cachedDeviceId = id
        return DeviceCalendarSnapshot.sourceKey(calendarIdentifier: calendarId, deviceId: id)
    }

    private func commit(_ next: DeviceCalendarOptIn) {
        optIn = next
        next.save(to: defaults)
    }
}
