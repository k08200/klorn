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

/// The opt-in on this Mac (decision P4), as persisted: the master switch, the
/// calendars switched on (all off by default), and the sources turned off that the
/// server has not confirmed removing yet. A value type off the main actor so the
/// self-check can exercise it; the bridge owns the live copy.
struct DeviceCalendarOptIn: Equatable, Sendable {
    static let uploadEnabledKey = "klorn.deviceCalendars.uploadEnabled"
    static let calendarIdsKey = "klorn.deviceCalendars.calendarIds"
    static let pendingRemovalKey = "klorn.deviceCalendars.pendingRemoval"

    var uploadEnabled = false
    var calendarIds: Set<String> = []
    var pendingRemoval: Set<String> = []

    static func load(from defaults: UserDefaults) -> DeviceCalendarOptIn {
        DeviceCalendarOptIn(
            uploadEnabled: defaults.bool(forKey: uploadEnabledKey),
            calendarIds: Set(defaults.stringArray(forKey: calendarIdsKey) ?? []),
            pendingRemoval: Set(defaults.stringArray(forKey: pendingRemovalKey) ?? []))
    }

    func save(to defaults: UserDefaults) {
        defaults.set(uploadEnabled, forKey: Self.uploadEnabledKey)
        defaults.set(calendarIds.sorted(), forKey: Self.calendarIdsKey)
        defaults.set(pendingRemoval.sorted(), forKey: Self.pendingRemovalKey)
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
    /// lost it heals without a change on the Mac.
    nonisolated static let resendUnchangedAfter: TimeInterval = 6 * 3600
    nonisolated static let settingsURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"

    private(set) var availability: Availability = .unknown
    private(set) var access: DeviceCalendarAccess
    private(set) var uploadEnabled: Bool
    private(set) var enabledIds: Set<String>
    private(set) var calendars: [DeviceCalendarItem] = []
    private(set) var lastError: String?
    private(set) var isBusy = false

    private let api: APIClient
    private let defaults: UserDefaults
    private let deviceId: () -> String
    /// Created only once the user turned the feature on (creating it never prompts,
    /// but nothing here has any business with EventKit before that).
    private var store: EKEventStore?
    private var changeObserver: NSObjectProtocol?
    private var refreshTask: Task<Void, Never>?
    private var debounceTask: Task<Void, Never>?
    private var probeRetryTask: Task<Void, Never>?
    private var passRunning = false
    private var passQueued = false
    /// Calendar id -> the last body sent and when, to skip an unchanged snapshot.
    private var lastSent: [String: (body: Data, at: Date)] = [:]
    private var pendingRemoval: Set<String>

    init(
        api: APIClient = APIClient(), defaults: UserDefaults = .standard,
        deviceId: @escaping () -> String = { DeviceIdentity.current() }
    ) {
        self.api = api
        self.defaults = defaults
        self.deviceId = deviceId
        self.access = DeviceCalendarAccess.from(EKEventStore.authorizationStatus(for: .event))
        let saved = DeviceCalendarOptIn.load(from: defaults)
        self.uploadEnabled = saved.uploadEnabled
        self.enabledIds = saved.calendarIds
        self.pendingRemoval = saved.pendingRemoval
    }

    /// True once EventKit has been touched (self-check: never before the opt-in).
    var hasEventStore: Bool { store != nil }

    // MARK: Lifecycle

    /// Signed in (launch or sign-in): learn whether the server has the feature, then
    /// send any removal still owed and, if the user turned uploading on before,
    /// resume it.
    func start() {
        Task { await refreshAvailability() }
    }

    /// GET /sources: 200 = the feature is on, the default 404 = it is off (hide it),
    /// anything else (offline at launch) = ask again after `probeRetryInterval`.
    func refreshAvailability() async {
        switch await probe() {
        case .available:
            availability = .available
            activateIfReady()
            // Owed removals go out even while uploading is off.
            startPass()
        case .unavailable:
            availability = .unavailable
            deactivate()
        case .unknown:
            scheduleProbeRetry()
        }
    }

    private func probe() async -> Availability {
        do {
            _ = try await api.fetchDeviceCalendarSources()
            return .available
        } catch {
            Log.net.debug("device calendars probe: \(String(describing: error), privacy: .private)")
            return Self.isFeatureOff(error) ? .unavailable : .unknown
        }
    }

    private func scheduleProbeRetry() {
        guard probeRetryTask == nil else { return }
        probeRetryTask = Task { [weak self] in
            try? await Task.sleep(for: Self.probeRetryInterval)
            guard !Task.isCancelled else { return }
            self?.probeRetryTask = nil
            await self?.refreshAvailability()
        }
    }

    /// Signing out ends the opt-in on this Mac, so another account signing in here
    /// must turn calendars on itself, and what this Mac uploaded under it is removed:
    /// one best-effort DELETE per source with the session's own token (`token`, read
    /// before the Keychain is cleared). Offline, the sources stay on the server until
    /// turned on and off again from a signed-in Mac or the account is deleted (plan, C6).
    func signOut(token: String?) {
        let owed = Self.removalsOnSignOut(
            DeviceCalendarOptIn(uploadEnabled: uploadEnabled, calendarIds: enabledIds, pendingRemoval: pendingRemoval),
            key: sourceKey(for:))
        if let token, !owed.isEmpty, availability == .available {
            var client = api
            client.token = { token }
            Task {
                for key in owed.sorted() {
                    do { try await client.deleteDeviceCalendarSource(key: key) } catch {
                        Log.net.error("device calendar removal at sign-out failed: \(String(describing: error), privacy: .private)")
                    }
                }
            }
        }
        deactivate()
        availability = .unknown
        let signedOut = DeviceCalendarOptIn()
        uploadEnabled = signedOut.uploadEnabled
        enabledIds = signedOut.calendarIds
        pendingRemoval = signedOut.pendingRemoval
        calendars = []
        lastSent = [:]
        lastError = nil
        store = nil
        persist()
    }

    // MARK: User actions

    /// The master switch. On: ask macOS for access (the only place that asks), then
    /// list the calendars, all off. Off: every uploaded calendar is deleted.
    func setUploadEnabled(_ on: Bool) async {
        lastError = nil
        guard on else {
            uploadEnabled = false
            pendingRemoval.formUnion(enabledIds.map(sourceKey(for:)))
            enabledIds = []
            lastSent = [:]
            persist()
            deactivate()
            // Through the pass queue: a PUT already in flight lands first, then the
            // DELETEs, so a late upload cannot recreate a source just removed.
            await runPass()
            return
        }
        isBusy = true
        defer { isBusy = false }
        let granted = await requestAccess()
        access = granted ? .granted : .denied
        uploadEnabled = granted
        persist()
        if granted { activateIfReady() }
    }

    /// One calendar's toggle. On uploads it now; off deletes it on the server.
    func setCalendar(_ id: String, enabled: Bool) async {
        lastError = nil
        if enabled {
            enabledIds.insert(id)
            pendingRemoval.remove(sourceKey(for: id))
            lastSent[id] = nil
        } else {
            enabledIds.remove(id)
            lastSent[id] = nil
            pendingRemoval.insert(sourceKey(for: id))
        }
        persist()
        await runPass()
    }

    func openPrivacySettings() {
        if let url = URL(string: Self.settingsURL) { NSWorkspace.shared.open(url) }
    }

    // MARK: Uploading

    private func activateIfReady() {
        guard availability == .available, uploadEnabled else { return }
        access = DeviceCalendarAccess.from(EKEventStore.authorizationStatus(for: .event))
        guard access == .granted else { return }
        if store == nil { store = EKEventStore() }
        reloadCalendars()
        if changeObserver == nil {
            changeObserver = NotificationCenter.default.addObserver(
                forName: .EKEventStoreChanged, object: store, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.storeChanged() }
            }
        }
        if refreshTask == nil {
            refreshTask = Task { [weak self] in
                self?.startPass()
                while !Task.isCancelled {
                    try? await Task.sleep(for: Self.refreshInterval)
                    if Task.isCancelled { break }
                    self?.startPass()
                }
            }
        }
    }

    /// A pass in a task of its own: cancelling the loop or the debounce never cancels
    /// a request in flight (a cancelled PUT can still land on the server).
    private func startPass() {
        Task { await runPass() }
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
        reloadCalendars()
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(for: Self.changeDebounce)
            guard !Task.isCancelled else { return }
            self?.startPass()
        }
    }

    private func reloadCalendars() {
        guard let store else { calendars = []; return }
        calendars = store.calendars(for: .event)
            .map { DeviceCalendarItem(id: $0.calendarIdentifier, title: $0.title, account: $0.source?.title ?? "") }
            .sorted { ($0.account, $0.title) < ($1.account, $1.title) }
    }

    /// One pass at a time; a request during a pass runs one more pass after it.
    private func runPass() async {
        guard !passRunning else { passQueued = true; return }
        passRunning = true
        defer { passRunning = false }
        repeat {
            passQueued = false
            await uploadEnabledCalendars()
            await processRemovals()
        } while passQueued
    }

    private func uploadEnabledCalendars() async {
        guard availability == .available, uploadEnabled, access == .granted, let store else { return }
        let present = Dictionary(
            store.calendars(for: .event).map { ($0.calendarIdentifier, $0) }, uniquingKeysWith: { first, _ in first })
        for id in enabledIds.sorted() {
            guard let calendar = present[id] else {
                // Gone from this Mac (account removed): remove its copy too, and send it
                // whole again if it comes back. Nothing is removed while the store
                // lists no calendar at all.
                if !present.isEmpty {
                    pendingRemoval.insert(sourceKey(for: id))
                    lastSent[id] = nil
                    persist()
                }
                continue
            }
            guard await upload(calendar, in: store) else { return }
        }
    }

    /// False when the pass must stop (feature off, signed out, rate limited).
    private func upload(_ calendar: EKCalendar, in store: EKEventStore) async -> Bool {
        let now = Date()
        // Autoupdating: a Mac that travels must read all-day dates in its new zone.
        let window = DeviceCalendarSnapshot.window(now: now, calendar: .autoupdatingCurrent)
        let range = DeviceCalendarSnapshot.queryRange(for: window)
        let predicate = store.predicateForEvents(withStart: range.start, end: range.end, calendars: [calendar])
        let inputs = store.events(matching: predicate).map(Self.input(from:))
        guard let snapshot = DeviceCalendarSnapshot.build(
            events: inputs, calendarTitle: calendar.title, window: window, timeZone: .autoupdatingCurrent,
            untitled: L("deviceCalendars.untitled"))
        else {
            Log.app.warning("device calendar snapshot not complete; skipped this pass")
            return true
        }
        let body = (try? JSONEncoder().encode(snapshot)) ?? Data()
        if let last = lastSent[calendar.calendarIdentifier],
           !Self.shouldResend(lastBody: last.body, lastAt: last.at, body: body, now: now) {
            return true
        }
        do {
            let key = sourceKey(for: calendar.calendarIdentifier)
            try await api.putDeviceCalendarSnapshot(key: key, snapshot)
            lastSent[calendar.calendarIdentifier] = (body, now)
            lastError = nil
            // A calendar that came back must not be removed by an older, failed removal.
            if pendingRemoval.remove(key) != nil { persist() }
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
        case APIError.http(409, _):
            lastError = L("deviceCalendars.error.limit")
            return true
        case APIError.http(429, _):
            return false
        default:
            lastError = L("deviceCalendars.error.generic")
            return true
        }
    }

    /// Delete every source the user turned off (kept until the server confirms, so
    /// a removal made offline or while the feature was off is retried).
    private func processRemovals() async {
        for key in pendingRemoval.sorted() {
            do {
                try await api.deleteDeviceCalendarSource(key: key)
                pendingRemoval.remove(key)
            } catch APIError.http(404, _) {
                // Not found: either the source is already gone (done) or the whole
                // feature is off (keep it, or its rows would return with the flag).
                if await featureIsOn() { pendingRemoval.remove(key) } else { break }
            } catch {
                Log.net.error("device calendar removal failed: \(String(describing: error), privacy: .private)")
                break
            }
        }
        persist()
    }

    /// Asked after a DELETE answered 404: a failed probe is NOT "on", so the removal
    /// is kept rather than dropped on a stale answer.
    private func featureIsOn() async -> Bool {
        let answer = await probe()
        if answer == .unavailable { availability = .unavailable; deactivate() }
        return answer == .available
    }

    // MARK: Pure helpers (self-checked)

    /// What signing out removes: every source switched on and every removal still owed.
    nonisolated static func removalsOnSignOut(
        _ optIn: DeviceCalendarOptIn, key: (String) -> String
    ) -> Set<String> {
        optIn.pendingRemoval.union(optIn.calendarIds.map(key))
    }

    /// The server's dark gate answers Fastify's default 404 on every route.
    nonisolated static func isFeatureOff(_ error: Error) -> Bool {
        if case APIError.http(404, _) = error { return true }
        return false
    }

    nonisolated static func shouldResend(lastBody: Data, lastAt: Date, body: Data, now: Date) -> Bool {
        lastBody != body || now.timeIntervalSince(lastAt) >= resendUnchangedAfter
    }

    /// The EKEvent fields the snapshot needs, and nothing else (no notes, no attendees).
    static func input(from event: EKEvent) -> DeviceEventInput {
        let recurring = event.hasRecurrenceRules || event.isDetached
        let declined = event.attendees?.contains {
            $0.isCurrentUser && $0.participantStatus == .declined
        } ?? false
        let status: DeviceEventInput.Status = switch event.status {
        case .canceled: .canceled
        case .tentative: .tentative
        case .confirmed: .confirmed
        default: .none
        }
        return DeviceEventInput(
            identity: event.calendarItemExternalIdentifier ?? event.calendarItemIdentifier,
            occurrence: recurring ? event.occurrenceDate : nil,
            title: event.title ?? "",
            start: event.startDate,
            end: event.endDate ?? event.startDate,
            isAllDay: event.isAllDay,
            location: event.location,
            url: event.url,
            status: status,
            declinedBySelf: declined)
    }

    // MARK: Private

    private func sourceKey(for calendarId: String) -> String {
        DeviceCalendarSnapshot.sourceKey(calendarIdentifier: calendarId, deviceId: deviceId())
    }

    private func requestAccess() async -> Bool {
        if store == nil { store = EKEventStore() }
        guard let store else { return false }
        return await withCheckedContinuation { continuation in
            store.requestFullAccessToEvents { granted, _ in continuation.resume(returning: granted) }
        }
    }

    private func persist() {
        DeviceCalendarOptIn(uploadEnabled: uploadEnabled, calendarIds: enabledIds, pendingRemoval: pendingRemoval)
            .save(to: defaults)
    }
}
