import Foundation

// Step C6: the device-calendar opt-in this Mac keeps, and whose it is.

/// The signed-in user's id, read from the session token's payload. Not verified
/// here: it only keys this Mac's own bookkeeping (which removals it owes to whom);
/// the server checks the token on every request.
enum SessionIdentity {
    static func userId(fromToken token: String?) -> String? {
        let parts = token?.split(separator: ".") ?? []
        guard parts.count == 3 else { return nil }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload += "=" }
        guard let data = Data(base64Encoded: payload),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = json["userId"] as? String, !id.isEmpty
        else { return nil }
        return id
    }
}

/// The opt-in on this Mac (decision P4), as persisted. Device-wide: the master
/// switch and the calendars switched on (all off by default; reset at sign-out).
/// Per user, kept across sign-out: the sources this Mac owes a DELETE (dropped only
/// when the server confirms) and the sources it has uploaded (to find its own
/// leftovers on the server; another Mac's sources are never touched). Every change
/// returns a new value.
struct DeviceCalendarOptIn: Equatable, Sendable {
    static let uploadEnabledKey = "klorn.deviceCalendars.uploadEnabled"
    static let calendarIdsKey = "klorn.deviceCalendars.calendarIds"
    static let pendingRemovalKey = "klorn.deviceCalendars.pendingRemovalByUser"
    static let uploadedKey = "klorn.deviceCalendars.uploadedByUser"

    var uploadEnabled = false
    var calendarIds: Set<String> = []
    var pendingRemoval: [String: Set<String>] = [:]
    var uploaded: [String: Set<String>] = [:]

    static func load(from defaults: UserDefaults) -> DeviceCalendarOptIn {
        DeviceCalendarOptIn(
            uploadEnabled: defaults.bool(forKey: uploadEnabledKey),
            calendarIds: Set(defaults.stringArray(forKey: calendarIdsKey) ?? []),
            pendingRemoval: perUser(defaults.dictionary(forKey: pendingRemovalKey)),
            uploaded: perUser(defaults.dictionary(forKey: uploadedKey)))
    }

    func save(to defaults: UserDefaults) {
        defaults.set(uploadEnabled, forKey: Self.uploadEnabledKey)
        defaults.set(calendarIds.sorted(), forKey: Self.calendarIdsKey)
        defaults.set(pendingRemoval.mapValues { $0.sorted() }, forKey: Self.pendingRemovalKey)
        defaults.set(uploaded.mapValues { $0.sorted() }, forKey: Self.uploadedKey)
    }

    private static func perUser(_ stored: [String: Any]?) -> [String: Set<String>] {
        (stored ?? [:]).compactMapValues { ($0 as? [String]).map(Set.init) }.filter { !$0.value.isEmpty }
    }

    func pending(for user: String) -> Set<String> { pendingRemoval[user] ?? [] }

    /// The user turned one calendar on (`key` its source): its owed removal is void.
    func enabling(_ id: String, key: String, user: String?) -> DeviceCalendarOptIn {
        var next = self
        next.calendarIds.insert(id)
        if let user { next.pendingRemoval = Self.removing(key, user, from: pendingRemoval) }
        return next
    }

    /// The user turned one calendar off: its source is owed a DELETE.
    func disabling(_ id: String, key: String, user: String?) -> DeviceCalendarOptIn {
        var next = self
        next.calendarIds.remove(id)
        if let user { next.pendingRemoval[user, default: []].insert(key) }
        return next
    }

    /// The master switch off, or sign-out: nothing uploads, every calendar is off,
    /// and every source that was on is owed a DELETE for that user.
    func switchedOff(user: String?, enabledKeys: Set<String>) -> DeviceCalendarOptIn {
        var next = self
        next.uploadEnabled = false
        next.calendarIds = []
        if let user, !enabledKeys.isEmpty { next.pendingRemoval[user, default: []].formUnion(enabledKeys) }
        return next
    }

    /// An upload of `key` for `user` succeeded: it is this Mac's, and not owed a DELETE.
    func uploadedSource(_ key: String, user: String) -> DeviceCalendarOptIn {
        var next = self
        next.uploaded[user, default: []].insert(key)
        next.pendingRemoval = Self.removing(key, user, from: pendingRemoval)
        return next
    }

    /// The server confirmed `key` gone for `user`.
    func removedSource(_ key: String, user: String) -> DeviceCalendarOptIn {
        var next = self
        next.pendingRemoval = Self.removing(key, user, from: pendingRemoval)
        next.uploaded = Self.removing(key, user, from: uploaded)
        return next
    }

    /// At launch, against GET /sources: the server's sources this Mac uploaded for
    /// the user but no longer has switched on are owed a DELETE; ones the server no
    /// longer has (expired, removed elsewhere) are forgotten. Sources of other Macs
    /// are not this Mac's to remove: their own Mac, or the server's expiry, does it.
    func reconciled(serverKeys: Set<String>, enabledKeys: Set<String>, user: String) -> DeviceCalendarOptIn {
        var next = self
        let mine = (uploaded[user] ?? []).intersection(serverKeys)
        next.uploaded[user] = mine.isEmpty ? nil : mine
        let orphans = mine.subtracting(enabledKeys)
        if !orphans.isEmpty { next.pendingRemoval[user, default: []].formUnion(orphans) }
        return next
    }

    private static func removing(
        _ key: String, _ user: String, from map: [String: Set<String>]
    ) -> [String: Set<String>] {
        var next = map
        next[user]?.remove(key)
        if next[user]?.isEmpty == true { next[user] = nil }
        return next
    }
}
