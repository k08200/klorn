import Foundation
import os

/// The one time zone every on-screen time and date is drawn in (Today, Mail
/// rows and reader, Calendar, Files, briefing, banners).
///
/// The web owns the setting (PR #1521): `GET /api/auth/me` returns
/// `timezone` and `timezoneMode`. MANUAL pins the user's chosen IANA zone;
/// AUTO, null, an absent field (older server) or a zone this Mac does not
/// know all mean "this Mac's zone" — never a crash, never UTC by accident.
enum DisplayTimeZone {
    private static let pinned = OSAllocatedUnfairLock<TimeZone?>(initialState: nil)

    /// The zone to draw in now: the pinned one, else this Mac's.
    static var current: TimeZone { pinned.withLock { $0 } ?? TimeZone.current }

    /// `Calendar.current` (locale, first weekday) in the display zone.
    static var calendar: Calendar {
        var calendar = Calendar.current
        calendar.timeZone = current
        return calendar
    }

    /// Pin a zone by identifier; nil or an unknown identifier un-pins.
    static func pin(identifier: String?) {
        let zone = identifier.flatMap(TimeZone.init(identifier:))
        pinned.withLock { $0 = zone }
    }

    /// The identifier to pin for a server preference, nil = follow this Mac.
    /// Only MANUAL with a zone Foundation knows pins anything. Pure.
    static func pinnedIdentifier(timezone: String?, mode: String?) -> String? {
        guard mode?.uppercased() == "MANUAL",
              let raw = timezone?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              let zone = TimeZone(identifier: raw)
        else { return nil }
        return zone.identifier
    }
}

/// `timezone` / `timezoneMode` on `GET /api/auth/me`'s user. Every field is
/// optional and a wrong type reads as absent, so an older server (or a
/// malformed value) decodes to "follow this Mac".
struct DisplayZonePreference: Equatable, Sendable, Decodable {
    var timezone: String?
    var timezoneMode: String?

    init(timezone: String? = nil, timezoneMode: String? = nil) {
        self.timezone = timezone
        self.timezoneMode = timezoneMode
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        timezone = (try? c.decodeIfPresent(String.self, forKey: .timezone)) ?? nil
        timezoneMode = (try? c.decodeIfPresent(String.self, forKey: .timezoneMode)) ?? nil
    }

    /// The zone identifier this preference pins, nil = this Mac's zone.
    var pinnedIdentifier: String? {
        DisplayTimeZone.pinnedIdentifier(timezone: timezone, mode: timezoneMode)
    }

    private enum CodingKeys: String, CodingKey { case timezone, timezoneMode }
}
