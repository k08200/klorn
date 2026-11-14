import Foundation

/// The bell's pure rules: which group a row sits in, what it says, why it
/// rang, what it can do and where a click goes. AppKit-free; the self-check
/// pins every branch.
enum NotificationFeedRules {
    // MARK: Groups

    /// The server's `group` when it sends one; otherwise the web's fallback:
    /// read → done; a reminder → later; a meeting → today; unread mail →
    /// now; an agent proposal still PENDING → now. Anything else unread is
    /// today's.
    static func group(_ n: NotificationWire) -> NotificationGroup {
        if let group = n.group { return group }
        if n.isRead { return .done }
        switch n.type {
        case "reminder": return .later
        case "meeting", "calendar": return .today
        case "email": return .now
        case "agent_proposal": return n.pendingActionStatus == "PENDING" ? .now : .today
        default: return .today
        }
    }

    /// The non-empty groups in display order, each keeping the server's
    /// newest-first order.
    static func grouped(_ rows: [NotificationWire]) -> [(group: NotificationGroup, rows: [NotificationWire])] {
        NotificationGroup.allCases.compactMap { group in
            let members = rows.filter { Self.group($0) == group }
            return members.isEmpty ? nil : (group, members)
        }
    }

    /// The bell's badge and the panel's "unread": unread rows in now + today.
    /// The same basis as the Dock badge's "needs you now", widened by today.
    static func badgeCount(_ rows: [NotificationWire]) -> Int {
        rows.filter { !$0.isRead && [.now, .today].contains(group($0)) }.count
    }

    /// The toolbar badge's text: nil at zero, "99+" past 99.
    static func badgeText(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        return count > 99 ? L("nc.badge.overflow") : String(count)
    }

    // MARK: Why it rang

    enum ReasonLine: Equatable {
        /// A verified span of the mail, shown in quotation marks.
        case quote(String)
        /// Klorn's own judgment, labelled as such.
        case judgment(String)
    }

    /// A verified quote first, then the server's reason text, then the
    /// mail's lane reason (`fallback`); nothing when none has words.
    static func reasonLine(_ reason: NotificationReason?, fallback: String? = nil) -> ReasonLine? {
        if let reason, reason.verified, let quote = plain(reason.quote, stripQuotes: true) {
            return .quote(quote)
        }
        if let text = plain(reason?.text) { return .judgment(text) }
        if let text = plain(fallback) { return .judgment(text) }
        return nil
    }

    /// What the row prints for a reason line.
    static func reasonText(_ line: ReasonLine) -> String {
        switch line {
        case .quote(let quote): L("nc.reason.quote", quote)
        case .judgment(let text): L("nc.reason.judgment", text)
        }
    }

    /// Plain text: whitespace runs (newlines included) become one space,
    /// control characters go, and an empty result is nil. `stripQuotes`
    /// drops quotation marks the server already put around a quote.
    static func plain(_ raw: String?, stripQuotes: Bool = false) -> String? {
        guard let raw else { return nil }
        let scalars = raw.unicodeScalars.map { scalar -> Character in
            CharacterSet.controlCharacters.contains(scalar) || CharacterSet.whitespacesAndNewlines.contains(scalar)
                ? " " : Character(scalar)
        }
        var text = String(scalars).split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
        if stripQuotes {
            text = text.trimmingCharacters(in: CharacterSet(charactersIn: "\"'“”‘’「」"))
                .trimmingCharacters(in: .whitespaces)
        }
        return text.isEmpty ? nil : text
    }

    // MARK: Who and what

    struct Display: Equatable {
        let who: String
        let subject: String
        /// The raw sender a face's hue is hashed from; nil = no face (an icon).
        let faceKey: String?
    }

    /// Mail rows name the sender: from the queue's copy of the mail when it
    /// is loaded, else from the bell message ("Sender: Subject [gmailId]",
    /// the server's urgent-mail row). Every other row is title + message.
    static func display(_ n: NotificationWire, mail: FirewallItem?) -> Display {
        if n.type == "email", let email = mail?.email {
            let who = senderDisplayName(email.from.map(decodeHTMLEntities))
            let subject = decodeHTMLEntities(email.subject ?? mail?.title ?? "")
            return Display(
                who: who.isEmpty ? n.title : who, subject: subject.isEmpty ? n.message : subject,
                faceKey: email.from ?? who)
        }
        if n.type == "email" {
            let message = strippingDedupMarker(n.message)
            // Only the urgent-mail row (it carries the marker) is
            // "Sender: Subject"; any other mail row's "Re: …" is a subject.
            if message != n.message, let colon = message.range(of: ": ") {
                let who = String(message[..<colon.lowerBound])
                let subject = String(message[colon.upperBound...])
                if !who.isEmpty, !subject.isEmpty {
                    return Display(who: who, subject: subject, faceKey: who)
                }
            }
            return Display(who: n.title, subject: message, faceKey: nil)
        }
        return Display(who: n.title, subject: n.message, faceKey: nil)
    }

    /// The urgent-mail row's trailing "[gmailId]" (or "[id,id]") marker.
    static func strippingDedupMarker(_ message: String) -> String {
        guard let range = message.range(of: #"\s*\[[^\[\]]*\]\s*$"#, options: .regularExpression) else {
            return message
        }
        return String(message[..<range.lowerBound])
    }

    /// The mail a row is about, when the queue holds it.
    static func mail(for n: NotificationWire, in queue: FirewallResponse?) -> FirewallItem? {
        guard let id = n.sourceEmailId, let queue else { return nil }
        return queue.tiers.values.lazy.flatMap { $0 }.first { $0.email?.emailDbId == id }
    }

    /// An outline symbol for a row without a face.
    static func symbol(_ n: NotificationWire, group: NotificationGroup) -> String {
        switch n.type {
        case "meeting", "calendar": return "calendar"
        case "reminder": return "clock"
        case "agent_proposal": return "checklist"
        case "briefing": return "doc.text"
        case "task": return "checkmark.circle"
        case "email": return "envelope"
        default: return group == .done ? "checkmark" : "bell"
        }
    }

    // MARK: Meta line

    /// "Received on Mac · Chrome": known channels only, deduplicated, in the
    /// server's order. nil when none is known.
    static func deliveredText(_ channels: [String]) -> String? {
        var seen: [String] = []
        for raw in channels {
            guard let name = channelName(raw), !seen.contains(name) else { continue }
            seen.append(name)
        }
        return seen.isEmpty ? nil : L("nc.meta.delivered", seen.joined(separator: " · "))
    }

    static func channelName(_ raw: String) -> String? {
        switch raw.lowercased() {
        case "mac", "desktop_mac", "macos": "Mac"
        case "windows", "desktop_windows": "Windows"
        case "chrome": "Chrome"
        case "edge": "Edge"
        case "firefox": "Firefox"
        case "safari": "Safari"
        case "web", "browser", "webpush", "web_push": L("nc.channel.browser")
        case "phone", "mobile", "ios", "android", "native": L("nc.channel.phone")
        case "telegram": "Telegram"
        default: nil
        }
    }

    // MARK: Actions and targets

    enum RowAction: Equatable {
        /// Open the mail and start the existing reply composer.
        case reply(FirewallItem)
        /// The existing snooze menu.
        case later(FirewallItem)
        /// A meeting's https join link (`MeetingLink.safeURL`).
        case join(URL)
        /// Open the surface that handles it (the proposals list).
        case open
    }

    /// What a row offers. Mail Klorn has loaded: Reply and Later (not once
    /// done). A meeting with a safe https link: Join. A PENDING proposal:
    /// Open — approving happens in the proposals list, which shows what the
    /// action will do; the bell adds no approve or send path.
    static func actions(_ n: NotificationWire, mail: FirewallItem?, group: NotificationGroup) -> [RowAction] {
        switch n.type {
        case "email":
            guard let mail, group != .done else { return [] }
            return [.reply(mail), .later(mail)]
        case "meeting", "calendar":
            return MeetingLink.safeURL(n.link).map { [.join($0)] } ?? []
        case "agent_proposal":
            return n.pendingActionStatus == "PENDING" ? [.open] : []
        default:
            return []
        }
    }

    enum Target: Equatable {
        /// The mail in the reader.
        case mail(FirewallItem)
        /// Mail, when the mail is not in the loaded queue.
        case mailbox
        case proposals
        case calendar
        /// Nothing to open; the click only marks it read.
        case none
    }

    static func target(_ n: NotificationWire, mail: FirewallItem?) -> Target {
        if let mail { return .mail(mail) }
        switch n.type {
        case "email": return .mailbox
        case "agent_proposal": return .proposals
        case "meeting", "calendar": return .calendar
        default: return .none
        }
    }

    // MARK: Time

    /// "3 min. ago" / "3분 전" in the app language; "" for a malformed time.
    static func timeLabel(_ iso: String, now: Date, locale: Locale = L10n.activeLocale) -> String {
        guard let date = parseISO(iso) else { return "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.unitsStyle = .short
        formatter.dateTimeStyle = .named
        // Under a minute reads "now", never "in 2 sec." from clock skew.
        let seconds = min(0, date.timeIntervalSince(now))
        return formatter.localizedString(fromTimeInterval: seconds > -60 ? 0 : seconds)
    }

    static func parseISO(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}
