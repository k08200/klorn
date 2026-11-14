import Foundation

// The bell's rows (NC2-A, founder decision 2026-11-13): GET
// /api/notifications decoded leniently. The contract fields another session
// is adding server-side (`lane`, `reason`, `held`, `group`, `deliveredTo`)
// are optional, and a shape this build cannot read drops that field, never
// the row or the list. Pure, pinned by the self-check.

/// Why a row rang, as the server words it. `verified`: `quote` is a literal
/// span of the mail (`quoteIn` says which part); otherwise `text` is
/// Klorn's own judgment.
struct NotificationReason: Decodable, Sendable, Equatable {
    let text: String?
    let verified: Bool
    let quote: String?
    let quoteIn: String?

    init(text: String?, verified: Bool, quote: String?, quoteIn: String?) {
        self.text = text
        self.verified = verified
        self.quote = quote
        self.quoteIn = quoteIn
    }

    private enum Keys: String, CodingKey { case text, verified, quote, quoteIn }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? nil
        verified = ((try? c.decodeIfPresent(Bool.self, forKey: .verified)) ?? nil) ?? false
        quote = (try? c.decodeIfPresent(String.self, forKey: .quote)) ?? nil
        quoteIn = (try? c.decodeIfPresent(String.self, forKey: .quoteIn)) ?? nil
    }
}

/// The panel's five groups, in display order (the web's NC1-A grouping).
enum NotificationGroup: String, CaseIterable, Sendable {
    case now, today, reply, later, done

    var titleKey: String { "nc.group.\(rawValue)" }
}

/// One bell row.
struct NotificationWire: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let type: String
    let title: String
    let message: String
    let isRead: Bool
    let link: String?
    let sourceEmailId: String?
    let pendingActionId: String?
    let pendingActionStatus: String?
    let createdAt: String
    // The optional contract (absent on today's server).
    let lane: Tier?
    let reason: NotificationReason?
    let held: Bool
    let group: NotificationGroup?
    let deliveredTo: [String]

    private enum Keys: String, CodingKey {
        case id, type, title, message, isRead, link, sourceEmailId, pendingActionId
        case pendingActionStatus, createdAt, lane, reason, held, group, deliveredTo
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        func string(_ key: Keys) -> String? { (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil }
        // A row without an id cannot be marked read: that one row fails.
        id = try c.decode(String.self, forKey: .id)
        type = string(.type) ?? ""
        title = string(.title) ?? ""
        message = string(.message) ?? ""
        isRead = ((try? c.decodeIfPresent(Bool.self, forKey: .isRead)) ?? nil) ?? false
        link = string(.link)
        sourceEmailId = string(.sourceEmailId)
        pendingActionId = string(.pendingActionId)
        pendingActionStatus = string(.pendingActionStatus)
        createdAt = string(.createdAt) ?? ""
        // An unknown lane is no lane (Tier's own decoder would say QUEUE).
        lane = string(.lane).flatMap { Tier(rawValue: $0.uppercased()) }
        reason = (try? c.decodeIfPresent(NotificationReason.self, forKey: .reason)) ?? nil
        held = ((try? c.decodeIfPresent(Bool.self, forKey: .held)) ?? nil) ?? false
        group = string(.group).flatMap { NotificationGroup(rawValue: $0.lowercased()) }
        if let list = (try? c.decodeIfPresent([LossyString].self, forKey: .deliveredTo)) ?? nil {
            deliveredTo = list.compactMap(\.value)
        } else {
            deliveredTo = string(.deliveredTo).map { [$0] } ?? []
        }
    }

    /// A copy marked read (optimistic mark-read).
    func markedRead() -> NotificationWire {
        NotificationWire(copying: self, isRead: true)
    }

    private init(copying o: NotificationWire, isRead: Bool) {
        id = o.id; type = o.type; title = o.title; message = o.message
        self.isRead = isRead
        link = o.link; sourceEmailId = o.sourceEmailId; pendingActionId = o.pendingActionId
        pendingActionStatus = o.pendingActionStatus; createdAt = o.createdAt
        lane = o.lane; reason = o.reason; held = o.held; group = o.group; deliveredTo = o.deliveredTo
    }
}

/// A string element that never fails its array.
private struct LossyString: Decodable {
    let value: String?
    init(from decoder: Decoder) throws {
        value = try? decoder.singleValueContainer().decode(String.self)
    }
}

/// An element that never fails its array: a row this build cannot read is
/// dropped, the rest of the list stays.
private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}

/// GET /api/notifications → `{ notifications, count, unread }`.
struct NotificationsResponse: Decodable, Sendable {
    let notifications: [NotificationWire]

    private enum Keys: String, CodingKey { case notifications }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let rows = try c.decode([Lossy<NotificationWire>].self, forKey: .notifications)
        notifications = rows.compactMap(\.value)
    }
}

/// GET /api/notifications/:id/delivery → where a row was delivered, read
/// lazily per row. Accepts `{ deliveredTo: [...] }`, `{ channels: [...] }`
/// or a bare array; each element a channel string or an object naming one
/// (`channel`, `name`, `kind` or `app`). Anything else is "unknown".
struct NotificationDelivery: Decodable, Sendable, Equatable {
    let channels: [String]

    init(channels: [String]) { self.channels = channels }

    private enum Keys: String, CodingKey { case deliveredTo, channels }

    private struct Element: Decodable {
        let value: String?
        private enum Keys: String, CodingKey { case channel, name, kind, app }
        init(from decoder: Decoder) throws {
            if let text = try? decoder.singleValueContainer().decode(String.self) {
                value = text
                return
            }
            let c = try? decoder.container(keyedBy: Keys.self)
            value = [Keys.channel, .name, .kind, .app].lazy
                .compactMap { key in (try? c?.decodeIfPresent(String.self, forKey: key)) ?? nil }.first
        }
    }

    init(from decoder: Decoder) throws {
        if let list = try? decoder.singleValueContainer().decode([Element].self) {
            channels = list.compactMap(\.value)
            return
        }
        let c = try decoder.container(keyedBy: Keys.self)
        let list = ((try? c.decodeIfPresent([Element].self, forKey: .deliveredTo)) ?? nil)
            ?? ((try? c.decodeIfPresent([Element].self, forKey: .channels)) ?? nil) ?? []
        channels = list.compactMap(\.value)
    }
}

/// GET /api/notifications/alert-endpoints/health, the parts the footer shows.
struct AlertChannelHealth: Decodable, Sendable, Equatable {
    struct Desktop: Decodable, Sendable, Equatable {
        let app: String
        let running: Bool
    }

    let webPushState: String?
    let desktop: [Desktop]
    let telegramLinked: Bool
    let mobileRegistered: Bool

    init(webPushState: String?, desktop: [Desktop], telegramLinked: Bool, mobileRegistered: Bool) {
        self.webPushState = webPushState
        self.desktop = desktop
        self.telegramLinked = telegramLinked
        self.mobileRegistered = mobileRegistered
    }

    private enum Keys: String, CodingKey { case webPush, desktop, telegram, mobile }
    private struct WebPush: Decodable { let state: String? }
    private struct Telegram: Decodable { let linked: Bool? }
    private struct Mobile: Decodable { let registered: Bool? }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        webPushState = ((try? c.decodeIfPresent(WebPush.self, forKey: .webPush)) ?? nil)?.state
        desktop = ((try? c.decodeIfPresent([Lossy<Desktop>].self, forKey: .desktop)) ?? nil)?
            .compactMap(\.value) ?? []
        telegramLinked = ((try? c.decodeIfPresent(Telegram.self, forKey: .telegram)) ?? nil)?.linked ?? false
        mobileRegistered = ((try? c.decodeIfPresent(Mobile.self, forKey: .mobile)) ?? nil)?.registered ?? false
    }
}
