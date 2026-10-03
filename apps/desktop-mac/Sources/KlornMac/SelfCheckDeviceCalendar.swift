import Foundation
import os

// Self-check for step C6 (device calendars), run by `KlornMac --self-check`.
// Pure checks of the snapshot builder and the opt-in bookkeeping, then scenarios
// that drive the real DeviceCalendarBridge against a fake calendar store and a
// stubbed network (URLProtocol), recording every request it makes.

/// Every device-calendar check, as (name, passed).
func deviceCalendarSelfChecks(sourceDir: URL) async -> [(String, Bool)] {
    var results = DeviceCalendarPureChecks.run(sourceDir: sourceDir)
    results += await DeviceCalendarScenarios.run()
    return results.map { ("device cal — \($0.0)", $0.1) }
}

private enum DeviceCalendarPureChecks {
    static func at(_ text: String) -> Date { ISO8601DateFormatter().date(from: text) ?? .distantPast }
    static let seoul = TimeZone(identifier: "Asia/Seoul") ?? .gmt
    static let losAngeles = TimeZone(identifier: "America/Los_Angeles") ?? .gmt

    static func calendar(_ zone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }

    static func event(
        _ identity: String, _ start: String, _ end: String, allDay: Bool = false,
        occurrence: Date? = nil, status: DeviceEventInput.Status = .confirmed,
        declined: Bool = false, title: String = "Standup", location: String? = nil, url: URL? = nil
    ) -> DeviceEventInput {
        DeviceEventInput(
            identity: identity, occurrence: occurrence, title: title, start: at(start), end: at(end),
            isAllDay: allDay, location: location, url: url, status: status, declinedBySelf: declined)
    }

    static func build(
        _ events: [DeviceEventInput], window: DateInterval, zone: TimeZone, now: Date
    ) -> DeviceSnapshotWire? {
        DeviceCalendarSnapshot.build(
            events: events, calendarTitle: "Work", window: window, timeZone: zone, untitled: "Untitled",
            snapshotAt: now)
    }

    // swiftlint:disable:next function_body_length
    static func run(sourceDir: URL) -> [(String, Bool)] {
        var results: [(String, Bool)] = []
        func check(_ name: String, _ ok: Bool) { results.append((name, ok)) }
        let now = at("2026-10-02T03:00:00Z")  // 12:00 in Seoul
        let window = DeviceCalendarSnapshot.window(now: now, calendar: calendar(seoul))
        func seoulBuild(_ events: [DeviceEventInput], zone: TimeZone = seoul) -> DeviceSnapshotWire? {
            build(events, window: window, zone: zone, now: now)
        }

        check("window: local midnight a week back to a month ahead",
              DeviceCalendarSnapshot.instant(window.start) == "2026-09-24T15:00:00Z"
              && DeviceCalendarSnapshot.instant(window.end) == "2026-11-01T15:00:00Z")
        check("the week back matches the server's lag (7 days, plus the local-midnight day)",
              DeviceCalendarSnapshot.windowPastDays == 7)
        let range = DeviceCalendarSnapshot.queryRange(for: window)
        check("EventKit is asked one day wider on each side",
              range.start == window.start.addingTimeInterval(-86_400)
              && range.end == window.end.addingTimeInterval(86_400))

        let calendarId = "5C7B3D2E-1F4A-4B6C-9D8E-0A1B2C3D4E5F"
        let keyA = DeviceCalendarSnapshot.sourceKey(calendarIdentifier: calendarId, deviceId: "mac-A")
        let keyB = DeviceCalendarSnapshot.sourceKey(calendarIdentifier: calendarId, deviceId: "mac-B")
        check("the source key is 64 lowercase hex, never the raw identifier",
              keyA.count == 64 && keyA.allSatisfy { "0123456789abcdef".contains($0) }
              && !keyA.contains(calendarId.lowercased()) && !keyA.contains(calendarId))
        check("the source key is per device and stable",
              keyA != keyB
              && keyA == DeviceCalendarSnapshot.sourceKey(calendarIdentifier: calendarId, deviceId: "mac-A"))

        let timed = seoulBuild([event("A", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z")])?.events.first
        check("a timed event is sent as UTC instants",
              timed?.start == "2026-10-05T01:00:00Z" && timed?.end == "2026-10-05T02:00:00Z" && timed?.allDay == false)
        check("the reporting zone never shifts a timed event",
              seoulBuild([event("A", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z")], zone: losAngeles)?
                  .events.first == timed)

        let allDaySeoul = seoulBuild([event("D", "2026-10-04T15:00:00Z", "2026-10-05T14:59:59Z", allDay: true)])?
            .events.first
        check("an all-day day in Seoul is its date, end exclusive",
              allDaySeoul?.start == "2026-10-05" && allDaySeoul?.end == "2026-10-06")
        let allDayLA = seoulBuild(
            [event("D", "2026-10-05T07:00:00Z", "2026-10-06T06:59:59Z", allDay: true)], zone: losAngeles)?.events.first
        check("the same date west of UTC is the same date",
              allDayLA?.start == "2026-10-05" && allDayLA?.end == "2026-10-06")
        let midnightEnd = seoulBuild([event("D", "2026-10-04T15:00:00Z", "2026-10-05T15:00:00Z", allDay: true)])?
            .events.first
        check("an all-day end at the next midnight reads the same",
              midnightEnd?.start == "2026-10-05" && midnightEnd?.end == "2026-10-06")
        let multiDay = seoulBuild([event("D", "2026-10-04T15:00:00Z", "2026-10-07T14:59:59Z", allDay: true)])?
            .events.first
        check("a three-day all-day event ends the day after its last day",
              multiDay?.start == "2026-10-05" && multiDay?.end == "2026-10-08")
        check("the all-day day before the local window is kept (it overlaps in UTC)",
              seoulBuild([event("E", "2026-09-23T15:00:00Z", "2026-09-24T14:59:59Z", allDay: true)])?
                  .events.map(\.start) == ["2026-09-24"])
        check("a timed event ending at the window start is left out",
              seoulBuild([event("O", "2026-09-24T14:00:00Z", "2026-09-24T15:00:00Z")])?.events.isEmpty == true)

        results += dstChecks()
        results += recurrenceChecks(seoulBuild: { seoulBuild($0) })

        let filtered = seoulBuild([
            event("keep", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z"),
            event("declined", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z", declined: true),
            event("cancelled", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z", status: .canceled),
            event("keep", "2026-10-05T03:00:00Z", "2026-10-05T04:00:00Z"),
        ])?.events
        check("declined, cancelled and repeated events are not sent",
              filtered?.map(\.externalId) == [DeviceCalendarSnapshot.externalId(identity: "keep", occurrence: nil)])
        check("a tentative event says so",
              seoulBuild([event("t", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z", status: .tentative)])?
                  .events.first?.status == "tentative")

        let many = (0..<501).map { hour in
            let start = window.start.addingTimeInterval(Double(hour) * 3600)
            return DeviceEventInput(
                identity: "m\(hour)", occurrence: nil, title: "x", start: start, end: start.addingTimeInterval(1800),
                isAllDay: false, location: nil, url: nil, status: .confirmed, declinedBySelf: false)
        }
        let capped = seoulBuild(many)
        check("over 500 events the window ends at the first one left out",
              capped?.events.count == 500
              && capped?.windowEnd == DeviceCalendarSnapshot.instant(window.start.addingTimeInterval(500 * 3600)))
        let before = (0..<501).map { i in
            DeviceEventInput(
                identity: "b\(i)", occurrence: nil, title: "x", start: window.start.addingTimeInterval(-3600),
                end: window.end, isAllDay: false, location: nil, url: nil, status: .confirmed, declinedBySelf: false)
        }
        check("no snapshot when no complete window can be made", seoulBuild(before) == nil)

        let family = String(repeating: "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", count: 200)
        check("a title is clamped to 500 code points",
              (seoulBuild([event("c", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z", title: family)])?
                  .events.first?.title ?? "").unicodeScalars.count == 500)
        check("an empty calendar title becomes the untitled label",
              DeviceCalendarSnapshot.build(
                  events: [], calendarTitle: "  ", window: window, timeZone: seoul, untitled: "Untitled",
                  snapshotAt: now)?.calendarTitle == "Untitled")

        func link(url: String? = nil, location: String? = nil) -> String? {
            DeviceCalendarSnapshot.meetingLink(event(
                "l", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z", location: location,
                url: url.flatMap(URL.init(string:))))
        }
        check("a https join link is sent",
              link(url: "https://meet.google.com/abc-defg-hij") == "https://meet.google.com/abc-defg-hij")
        check("http, javascript: and credentialed links are not",
              link(url: "http://meet.example.com/x") == nil && link(url: "javascript:alert(1)") == nil
              && link(url: "https://user:pw@meet.example.com/x") == nil)
        check("a location that is a link is used; a room name is not",
              link(location: "https://zoom.us/j/1") == "https://zoom.us/j/1" && link(location: "Room 4") == nil)

        results += wireChecks(seoulBuild: { seoulBuild($0) }, now: now)
        results += optInChecks(keyA: keyA)
        results += sourceChecks(sourceDir: sourceDir)

        check("only full access reads events",
              DeviceCalendarAccess.from(.fullAccess) == .granted && DeviceCalendarAccess.from(.writeOnly) == .denied
              && DeviceCalendarAccess.from(.denied) == .denied && DeviceCalendarAccess.from(.restricted) == .denied
              && DeviceCalendarAccess.from(.notDetermined) == .notDetermined)
        check("the server's default 404 means the feature is off",
              DeviceCalendarBridge.isFeatureOff(APIError.http(404, "Route GET:/api/device-calendar/sources not found"))
              && !DeviceCalendarBridge.isFeatureOff(APIError.http(500, nil))
              && !DeviceCalendarBridge.isFeatureOff(APIError.unauthorized))
        let print = Data("a".utf8)
        check("an unchanged snapshot is not re-sent until it is stale",
              !DeviceCalendarBridge.shouldResend(
                  lastFingerprint: print, lastAt: now, fingerprint: print, now: now.addingTimeInterval(60))
              && DeviceCalendarBridge.shouldResend(
                  lastFingerprint: print, lastAt: now, fingerprint: Data("b".utf8), now: now)
              && DeviceCalendarBridge.shouldResend(
                  lastFingerprint: print, lastAt: now, fingerprint: print,
                  now: now.addingTimeInterval(DeviceCalendarBridge.resendUnchangedAfter)))
        return results
    }

    /// 23- and 25-hour days in Los Angeles: 2027-03-14 springs forward, 2026-11-01 falls back.
    static func dstChecks() -> [(String, Bool)] {
        let la = calendar(losAngeles)
        func local(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int = 0, _ s: Int = 0) -> Date {
            la.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min, second: s)) ?? .distantPast
        }
        let fallNow = local(2026, 11, 1, 12)
        let fallWindow = DeviceCalendarSnapshot.window(now: fallNow, calendar: la)
        let springNow = local(2027, 3, 14, 12)
        let springWindow = DeviceCalendarSnapshot.window(now: springNow, calendar: la)
        func one(_ input: DeviceEventInput, _ window: DateInterval, _ now: Date) -> DeviceEventWire? {
            build([input], window: window, zone: losAngeles, now: now)?.events.first
        }
        func input(_ start: Date, _ end: Date, allDay: Bool = false) -> DeviceEventInput {
            DeviceEventInput(
                identity: "dst", occurrence: nil, title: "x", start: start, end: end, isAllDay: allDay,
                location: nil, url: nil, status: .confirmed, declinedBySelf: false)
        }
        let fallTimed = one(input(local(2026, 11, 1, 9), local(2026, 11, 1, 10)), fallWindow, fallNow)
        // 01:30 PDT to 03:30 PST is three hours, not two.
        let across = one(input(local(2026, 11, 1, 0, 30), local(2026, 11, 1, 3, 30)), fallWindow, fallNow)
        let fallAllDay = one(
            input(local(2026, 11, 1, 0), local(2026, 11, 1, 23, 59, 59), allDay: true), fallWindow, fallNow)
        let fallNextMidnight = one(
            input(local(2026, 11, 1, 0), local(2026, 11, 2, 0), allDay: true), fallWindow, fallNow)
        let springTimed = one(input(local(2027, 3, 14, 9), local(2027, 3, 14, 10)), springWindow, springNow)
        let springAllDay = one(
            input(local(2027, 3, 14, 0), local(2027, 3, 14, 23, 59, 59), allDay: true), springWindow, springNow)
        let springNextMidnight = one(
            input(local(2027, 3, 14, 0), local(2027, 3, 15, 0), allDay: true), springWindow, springNow)
        return [
            ("DST 25-hour day: the window starts at PDT midnight and ends at PST midnight",
             DeviceCalendarSnapshot.instant(fallWindow.start) == "2026-10-25T07:00:00Z"
             && DeviceCalendarSnapshot.instant(fallWindow.end) == "2026-12-02T08:00:00Z"),
            ("DST 25-hour day: 09:00 after the fall-back is 17:00 UTC",
             fallTimed?.start == "2026-11-01T17:00:00Z" && fallTimed?.end == "2026-11-01T18:00:00Z"),
            ("DST 25-hour day: an event across the repeated hour keeps its true length",
             across?.start == "2026-11-01T07:30:00Z" && across?.end == "2026-11-01T11:30:00Z"),
            ("DST 25-hour day: the all-day date is that one date, either end convention",
             fallAllDay?.start == "2026-11-01" && fallAllDay?.end == "2026-11-02"
             && fallNextMidnight?.start == "2026-11-01" && fallNextMidnight?.end == "2026-11-02"),
            ("DST 23-hour day: 09:00 after the spring-forward is 16:00 UTC",
             springTimed?.start == "2027-03-14T16:00:00Z" && springTimed?.end == "2027-03-14T17:00:00Z"),
            ("DST 23-hour day: the all-day date is that one date, either end convention",
             springAllDay?.start == "2027-03-14" && springAllDay?.end == "2027-03-15"
             && springNextMidnight?.start == "2027-03-14" && springNextMidnight?.end == "2027-03-15"),
            ("DST 23-hour day: the window spans the short day",
             DeviceCalendarSnapshot.instant(springWindow.start) == "2027-03-07T08:00:00Z"
             && DeviceCalendarSnapshot.instant(springWindow.end) == "2027-04-14T07:00:00Z"),
        ]
    }

    static func recurrenceChecks(seoulBuild: ([DeviceEventInput]) -> DeviceSnapshotWire?) -> [(String, Bool)] {
        let series = (0..<3).map { week in
            event("UID-1", "2026-10-0\(5 + week)T01:00:00Z", "2026-10-0\(5 + week)T02:00:00Z",
                  occurrence: at("2026-10-0\(5 + week)T01:00:00Z"))
        }
        let moved = event("UID-1", "2026-10-13T01:00:00Z", "2026-10-13T02:00:00Z", occurrence: at("2026-10-12T01:00:00Z"))
        // The same all-day occurrence (2026-10-05) as EventKit reports it in two zones:
        // local midnight is a different instant, the floating date is the same.
        func allDayOccurrence(_ midnight: String, _ end: String, zone: TimeZone) -> String? {
            build([event("HOLIDAY", midnight, end, allDay: true, occurrence: at(midnight))],
                  window: DeviceCalendarSnapshot.window(now: at("2026-10-02T03:00:00Z"), calendar: calendar(zone)),
                  zone: zone, now: at("2026-10-02T03:00:00Z"))?.events.first?.externalId
        }
        let inSeoul = allDayOccurrence("2026-10-04T15:00:00Z", "2026-10-05T14:59:59Z", zone: seoul)
        let inLA = allDayOccurrence("2026-10-05T07:00:00Z", "2026-10-06T06:59:59Z", zone: losAngeles)
        let nextDay = allDayOccurrence("2026-10-05T15:00:00Z", "2026-10-06T14:59:59Z", zone: seoul)
        return [
            ("each occurrence of a series is its own event",
             Set(seriesIds(seoulBuild(series))).count == 3),
            ("a moved occurrence keeps the id of its original start",
             seoulBuild([moved])?.events.first?.externalId
                 == DeviceCalendarSnapshot.externalId(identity: "UID-1", occurrence: at("2026-10-12T01:00:00Z"))),
            ("a one-off event is keyed by its identity alone, hashed",
             seoulBuild([event("UID-2", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z")])?.events.first?.externalId
                 == DeviceCalendarSnapshot.externalId(identity: "UID-2", occurrence: nil)),
            ("an all-day occurrence is keyed by its floating date: a zone change keeps its id",
             inSeoul != nil && inSeoul == inLA && nextDay != nil && nextDay != inSeoul),
        ]
    }

    static func seriesIds(_ wire: DeviceSnapshotWire?) -> [String] { wire?.events.map(\.externalId) ?? [] }

    static func wireChecks(seoulBuild: ([DeviceEventInput]) -> DeviceSnapshotWire?, now: Date) -> [(String, Bool)] {
        guard let snapshot = seoulBuild([event("w", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z", location: "Room 4")]),
              let prepared = DeviceCalendarSnapshot.prepared(snapshot),
              let json = try? JSONSerialization.jsonObject(with: prepared.body) as? [String: Any],
              let first = (json["events"] as? [[String: Any]])?.first
        else { return [("the snapshot encodes", false)] }
        let later = seoulBuild([event("w", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z", location: "Room 4")])
        let laterTime = later.map {
            DeviceSnapshotWire(windowStart: $0.windowStart, windowEnd: $0.windowEnd, snapshotAt: "2026-10-02T04:00:00Z",
                               calendarTitle: $0.calendarTitle, events: $0.events)
        }
        return [
            ("the snapshot's top-level fields, with its time",
             Set(json.keys) == ["windowStart", "windowEnd", "snapshotAt", "calendarTitle", "events"]
             && json["snapshotAt"] as? String == DeviceCalendarSnapshot.instant(now)),
            ("an event carries only the documented fields",
             Set(first.keys).isSubset(of: ["externalId", "title", "start", "end", "allDay", "location", "meetingLink", "status"])
             && first["location"] as? String == "Room 4"),
            ("the same calendar read later is unchanged content (its time is not compared)",
             laterTime.flatMap(DeviceCalendarSnapshot.prepared)?.fingerprint == prepared.fingerprint
             && laterTime.flatMap(DeviceCalendarSnapshot.prepared)?.body != prepared.body),
        ]
    }

    static func optInChecks(keyA: String) -> [(String, Bool)] {
        let fresh = DeviceCalendarOptIn()
        let on = DeviceCalendarOptIn(uploadEnabled: true, calendarIds: ["cal-1"], pendingRemoval: ["u2": ["x"]])
        let signedOut = on.switchedOff(user: "u1", enabledKeys: [keyA])
        let reconciled = DeviceCalendarOptIn(uploaded: ["u1": ["mine-on", "mine-off", "gone"]])
            .reconciled(serverKeys: ["mine-on", "mine-off", "other-mac"], enabledKeys: ["mine-on"], user: "u1")
        var persisted = false
        let suiteName = "ai.klorn.selfcheck.devicecal.\(UUID().uuidString)"
        if let suite = UserDefaults(suiteName: suiteName) {
            let fromEmpty = DeviceCalendarOptIn.load(from: suite)
            signedOut.save(to: suite)
            persisted = fromEmpty == fresh && DeviceCalendarOptIn.load(from: suite) == signedOut
            suite.removePersistentDomain(forName: suiteName)
        }
        return [
            ("a fresh install has every switch off", !fresh.uploadEnabled && fresh.calendarIds.isEmpty),
            ("sign-out turns everything off and owes a DELETE per source that was on, for that user",
             !signedOut.uploadEnabled && signedOut.calendarIds.isEmpty
             && signedOut.pending(for: "u1") == [keyA] && signedOut.pending(for: "u2") == ["x"]),
            ("the opt-in and the owed removals survive a relaunch and a sign-out", persisted),
            ("launch: this Mac's sources no longer on are owed a DELETE; another Mac's are not",
             reconciled.pending(for: "u1") == ["mine-off"] && reconciled.uploaded["u1"] == ["mine-on", "mine-off"]),
            ("a confirmed removal forgets the source; a later upload of it voids an owed removal",
             reconciled.removedSource("mine-off", user: "u1").pending(for: "u1").isEmpty
             && reconciled.uploadedSource("mine-off", user: "u1").pending(for: "u1").isEmpty),
            ("the session's user is read from the token's payload",
             SessionIdentity.userId(fromToken: DeviceCalendarScenarios.token("user-9")) == "user-9"
             && SessionIdentity.userId(fromToken: "not-a-jwt") == nil && SessionIdentity.userId(fromToken: nil) == nil),
        ]
    }

    static func sourceChecks(sourceDir: URL) -> [(String, Bool)] {
        let files = (try? FileManager.default.contentsOfDirectory(at: sourceDir, includingPropertiesForKeys: nil))?
            .filter { $0.pathExtension == "swift" && !$0.lastPathComponent.hasPrefix("SelfCheck") } ?? []
        func containing(_ needle: String) -> [String] {
            files.filter { (try? String(contentsOf: $0, encoding: .utf8))?.contains(needle) == true }
                .map(\.lastPathComponent).sorted()
        }
        func text(_ name: String) -> String {
            (try? String(contentsOf: sourceDir.appendingPathComponent(name), encoding: .utf8)) ?? ""
        }
        let bridge = text("DeviceCalendarBridge.swift")
        let appDir = sourceDir.deletingLastPathComponent().deletingLastPathComponent()
        let makeApp = (try? String(contentsOf: appDir.appendingPathComponent("scripts/make-app.sh"), encoding: .utf8)) ?? ""
        let entitlements = (try? String(contentsOf: appDir.appendingPathComponent("Klorn.entitlements"), encoding: .utf8)) ?? ""
        let localised = L10n.shipped.allSatisfy { code in
            let file = appDir.appendingPathComponent("Resources/InfoPlist/\(code).lproj/InfoPlist.strings")
            let strings = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
            return strings.contains("\"NSCalendarsFullAccessUsageDescription\"")
                && strings.contains("\"NSCalendarsUsageDescription\"")
        }
        let appModel = text("AppModel.swift")
        let tokenRead = appModel.range(of: "let sessionToken = KeychainStore.load()")
        let tokenCleared = appModel.range(of: "KeychainStore.clear()\n        queue = nil")
        return [
            ("only the reader asks macOS for calendar access, and only from the upload switch",
             containing("requestFullAccessToEvents") == ["DeviceCalendarReader.swift"]
             && bridge.components(separatedBy: ".requestAccess()").count == 2
             && bridge.contains("let granted = await reader.requestAccess()")),
            ("EventKit is read, and snapshots built and encoded, off the main thread",
             containing("EKEventStore()") == ["DeviceCalendarReader.swift"]
             && containing("events(matching:") == ["DeviceCalendarReader.swift"]
             && containing("DeviceCalendarSnapshot.prepared(") == ["DeviceCalendarReader.swift"]
             && text("DeviceCalendarReader.swift").contains("actor DeviceCalendarReader")),
            ("the refresh loop holds the bridge weakly and ends with it",
             bridge.contains("guard self?.refreshTick() == true else { return }")),
            ("sign-out reads the session token before the Keychain is cleared",
             tokenRead != nil && tokenCleared != nil
             && tokenRead.map { $0.lowerBound < (tokenCleared?.lowerBound ?? $0.lowerBound) } == true
             && appModel.contains("deviceCalendars.signOut(token: sessionToken)")),
            ("the calendar prompt is localised in every shipped language", localised),
            ("Info.plist declares the usage keys and the build copies their translations",
             makeApp.contains("<key>NSCalendarsFullAccessUsageDescription</key>")
             && makeApp.contains("<key>NSCalendarsUsageDescription</key>")
             && makeApp.contains("Resources/InfoPlist/*.lproj")),
            ("the build does not declare app-wide localisations it does not need",
             !makeApp.contains("CFBundleLocalizations") && !makeApp.contains("CFBundleDevelopmentRegion")),
            ("the hardened runtime may read calendars",
             entitlements.contains("com.apple.security.personal-information.calendars")
             && makeApp.contains("--entitlements Klorn.entitlements")),
        ]
    }
}

// MARK: Scenarios: the real bridge, a fake store, a stubbed network

/// Answers every request of the scenarios' URLSession and records it.
final class DeviceCalendarStubProtocol: URLProtocol, @unchecked Sendable {
    struct Call: Sendable, Equatable {
        let method: String
        let path: String
        let bearer: String?
    }
    struct Reply: Sendable {
        let status: Int
        let body: String
    }

    static let state = OSAllocatedUnfairLock(initialState: (replies: [String: Reply](), calls: [Call]()))

    static func reset(_ replies: [String: Reply]) { state.withLock { $0 = (replies, []) } }
    static func replace(_ replies: [String: Reply]) { state.withLock { $0.replies = replies } }
    static var calls: [Call] { state.withLock { $0.calls } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        let method = request.httpMethod ?? "GET"
        let call = Call(method: method, path: url.path, bearer: request.value(forHTTPHeaderField: "Authorization"))
        let reply: Reply = Self.state.withLock { state in
            state.calls.append(call)
            return state.replies["\(method) \(url.path)"] ?? state.replies[method] ?? Reply(status: 200, body: "{}")
        }
        let response = HTTPURLResponse(
            url: url, statusCode: reply.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])
        if let response { client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed) }
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

actor FakeDeviceCalendarStore: DeviceCalendarStore {
    private let items: [DeviceCalendarItem]
    private let snapshots: [String: PreparedSnapshot]

    init(items: [DeviceCalendarItem], snapshots: [String: PreparedSnapshot]) {
        self.items = items
        self.snapshots = snapshots
    }

    func requestAccess() -> Bool { true }
    func calendars() -> [DeviceCalendarItem] { items }
    func snapshot(calendarId: String, now: Date, untitled: String) -> PreparedSnapshot? { snapshots[calendarId] }
}

@MainActor
enum DeviceCalendarScenarios {
    static let user = "user-1"
    static let sourcesPath = "/api/device-calendar/sources"

    nonisolated static func token(_ user: String) -> String {
        let payload = Data(#"{"userId":"\#(user)"}"#.utf8).base64EncodedString()
            .replacingOccurrences(of: "=", with: "").replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
        return "header.\(payload).signature"
    }

    static func key(_ id: String) -> String {
        DeviceCalendarSnapshot.sourceKey(calendarIdentifier: id, deviceId: "mac-A")
    }

    static func sources(_ keys: [String]) -> DeviceCalendarStubProtocol.Reply {
        let list = keys.map { #"{"key":"\#($0)","title":null,"uploadedAt":"2026-10-02T00:00:00.000Z"}"# }
        return .init(status: 200, body: #"{"sources":[\#(list.joined(separator: ","))]}"#)
    }

    static func api(token: String?) -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeviceCalendarStubProtocol.self]
        return APIClient(base: "http://stub.test", session: URLSession(configuration: configuration), token: { token })
    }

    static func prepared(_ tag: String) -> PreparedSnapshot {
        PreparedSnapshot(body: Data(#"{"tag":"\#(tag)"}"#.utf8), fingerprint: Data(tag.utf8))
    }

    static func bridge(
        _ defaults: UserDefaults, user: String?, items: [String], snapshots: [String]
    ) -> DeviceCalendarBridge {
        let store = FakeDeviceCalendarStore(
            items: items.map { DeviceCalendarItem(id: $0, title: $0, account: "iCloud") },
            snapshots: Dictionary(uniqueKeysWithValues: snapshots.map { ($0, prepared($0)) }))
        return DeviceCalendarBridge(
            api: api(token: user.map(token)), defaults: defaults, deviceId: { "mac-A" }, currentUser: { user },
            makeStore: { store }, authorization: { .granted })
    }

    static func deletes() -> [String] {
        DeviceCalendarStubProtocol.calls.filter { $0.method == "DELETE" }.map(\.path)
    }

    static func path(_ key: String) -> String { "\(sourcesPath)/\(key)" }

    static func run() async -> [(String, Bool)] {
        var results: [(String, Bool)] = []
        let suiteName = "ai.klorn.selfcheck.devicecal.scenarios.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else { return [("a scratch defaults suite", false)] }
        defer { defaults.removePersistentDomain(forName: suiteName) }
        func fresh(_ optIn: DeviceCalendarOptIn) {
            defaults.removePersistentDomain(forName: suiteName)
            optIn.save(to: defaults)
        }

        // 1. A calendar missing from this Mac pauses; it is never deleted for its absence.
        fresh(DeviceCalendarOptIn(uploadEnabled: true, calendarIds: ["present", "gone"]))
        DeviceCalendarStubProtocol.reset(["GET \(sourcesPath)": sources([])])
        let absent = bridge(defaults, user: user, items: ["present"], snapshots: ["present"])
        absent.start()
        await absent.idle()
        results.append(("a calendar missing from this Mac pauses and is never deleted",
                        deletes().isEmpty && absent.optIn.pending(for: user).isEmpty
                        && absent.enabledIds.contains("gone")
                        && DeviceCalendarStubProtocol.calls.contains {
                            $0.method == "PUT" && $0.path == "\(path(key("present")))/window"
                        }))
        await absent.setCalendar("present", enabled: false)
        results.append(("switching a calendar off deletes its source, and the removal is then done",
                        deletes() == [path(key("present"))] && absent.optIn.pending(for: user).isEmpty))

        // 2. Launch: this Mac's leftovers on the server are deleted; another Mac's are not.
        fresh(DeviceCalendarOptIn(
            uploadEnabled: true, calendarIds: ["a"], uploaded: [user: [key("a"), key("old")]]))
        DeviceCalendarStubProtocol.reset(["GET \(sourcesPath)": sources([key("a"), key("old"), key("other-mac")])])
        let launch = bridge(defaults, user: user, items: ["a"], snapshots: ["a"])
        launch.start()
        await launch.idle()
        results.append(("launch deletes this Mac's server sources no longer on, and nothing else",
                        deletes() == [path(key("old"))] && launch.optIn.uploaded[user] == [key("a")]))

        // 3. Sign-out owes a DELETE per source that was on; a failure is kept for that user.
        fresh(DeviceCalendarOptIn(uploadEnabled: true, calendarIds: ["a"]))
        DeviceCalendarStubProtocol.reset(["GET \(sourcesPath)": sources([]), "DELETE": .init(status: 500, body: "{}")])
        let leaving = bridge(defaults, user: user, items: ["a"], snapshots: ["a"])
        leaving.signOut(token: token(user))
        await leaving.idle()
        let sentWithSession = DeviceCalendarStubProtocol.calls.contains {
            $0.method == "DELETE" && $0.path == path(key("a")) && $0.bearer == "Bearer \(token(user))"
        }
        let kept = DeviceCalendarOptIn.load(from: defaults)
        results.append(("sign-out sends the DELETE with the session's token and keeps it when it fails",
                        sentWithSession && !kept.uploadEnabled && kept.calendarIds.isEmpty
                        && kept.pending(for: user) == [key("a")]))

        DeviceCalendarStubProtocol.reset(["GET \(sourcesPath)": sources([key("a")])])
        let someoneElse = bridge(defaults, user: "user-2", items: [], snapshots: [])
        someoneElse.start()
        await someoneElse.idle()
        results.append(("another user signing in here does not send the first user's removals", deletes().isEmpty))
        let back = bridge(defaults, user: user, items: [], snapshots: [])
        back.start()
        await back.idle()
        results.append(("the same user's next sign-in retries the removal until it succeeds",
                        deletes() == [path(key("a"))] && back.optIn.pending(for: user).isEmpty))

        // 4. A sign-out during an upload: the DELETE goes after the PUT, never before it.
        fresh(DeviceCalendarOptIn(uploadEnabled: true, calendarIds: ["a"]))
        DeviceCalendarStubProtocol.reset(["GET \(sourcesPath)": sources([])])
        let racing = bridge(defaults, user: user, items: ["a"], snapshots: ["a"])
        racing.start()
        racing.signOut(token: token(user))
        await racing.idle()
        let calls = DeviceCalendarStubProtocol.calls
        let lastDelete = calls.lastIndex { $0.method == "DELETE" && $0.path == path(key("a")) }
        let lastPut = calls.lastIndex { $0.method == "PUT" }
        results.append(("a sign-out's DELETE is never overtaken by an upload",
                        lastDelete != nil && (lastPut ?? -1) < (lastDelete ?? -1)))

        // 5. The feature off on the server hides it and uploads nothing.
        fresh(DeviceCalendarOptIn(uploadEnabled: true, calendarIds: ["a"]))
        DeviceCalendarStubProtocol.reset(["GET \(sourcesPath)": .init(status: 404, body: "{}")])
        let dark = bridge(defaults, user: user, items: ["a"], snapshots: ["a"])
        dark.start()
        await dark.idle()
        results.append(("a 404 hides the feature and nothing is uploaded",
                        dark.availability == .unavailable
                        && !DeviceCalendarStubProtocol.calls.contains { $0.method == "PUT" }))

        // 6. Nothing touches EventKit before the opt-in.
        fresh(DeviceCalendarOptIn())
        DeviceCalendarStubProtocol.reset(["GET \(sourcesPath)": sources([])])
        let untouched = bridge(defaults, user: user, items: ["a"], snapshots: ["a"])
        untouched.start()
        await untouched.idle()
        results.append(("with uploading off nothing opens the calendar store or uploads",
                        !untouched.hasEventStore && !DeviceCalendarStubProtocol.calls.contains { $0.method == "PUT" }))
        return results
    }
}
