import Foundation

/// The locked 4-tier firewall model — PUSH / QUEUE / SILENT / AUTO.
/// Never a 5th tier or "Call" (CLAUDE.md: the model is fixed at four).
enum Tier: String, Codable, CaseIterable, Sendable, Identifiable {
    case push = "PUSH"
    case queue = "QUEUE"
    case silent = "SILENT"
    case auto = "AUTO"

    var id: String { rawValue }

    /// Display order: loudest first (what interrupts you), quietest last.
    static let displayOrder: [Tier] = [.push, .queue, .silent, .auto]

    var label: String {
        switch self {
        case .push: "Push"
        case .queue: "Queue"
        case .silent: "Silent"
        case .auto: "Auto"
        }
    }
}

/// Email enrichment for a firewall row (best-effort; fields may be nil).
struct EmailContext: Codable, Sendable, Hashable {
    let emailDbId: String
    let subject: String?
    let from: String?
    let snippet: String?
}

/// One classified item in the decision queue. Mirrors the API's FirewallItem
/// (routes/firewall.ts); toolName/toolArgs/trust are intentionally omitted —
/// JSONDecoder ignores unknown keys, and the queue UI doesn't need them yet.
struct FirewallItem: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let source: String
    let sourceId: String
    let type: String
    let title: String
    let tier: Tier
    let tierReason: String?
    let priority: Int
    let surfacedAt: String
    let email: EmailContext?
    let href: String?
    let hashStale: Bool?
}

/// Per-tier open counts (the daily receipt header).
struct FirewallSummary: Codable, Sendable, Hashable {
    let silent: Int
    let queue: Int
    let push: Int
    let auto: Int
    let total: Int

    enum CodingKeys: String, CodingKey {
        case silent = "SILENT"
        case queue = "QUEUE"
        case push = "PUSH"
        case auto = "AUTO"
        case total
    }

    func count(for tier: Tier) -> Int {
        switch tier {
        case .push: push
        case .queue: queue
        case .silent: silent
        case .auto: auto
        }
    }
}

/// GET /api/inbox/firewall — open AttentionItems grouped by tier.
struct FirewallResponse: Codable, Sendable {
    let tiers: [String: [FirewallItem]]
    let summary: FirewallSummary

    func items(for tier: Tier) -> [FirewallItem] {
        tiers[tier.rawValue] ?? []
    }

    var allItemIDs: Set<String> {
        Set(tiers.values.flatMap { $0 }.map(\.id))
    }

    /// Find an item by its AttentionItem id across all tiers (reading-pane lookup).
    func item(id: String) -> FirewallItem? {
        tiers.values.flatMap { $0 }.first { $0.id == id }
    }

    /// A copy with one item moved to a different tier (optimistic tier
    /// correction — teach-the-firewall). The item is restamped with the new
    /// tier and prepended to its list; summary shifts one count over, total
    /// unchanged. Unknown id or same tier returns self.
    func movingItem(id: String, to tier: Tier) -> FirewallResponse {
        guard let item = item(id: id), item.tier != tier else { return self }
        let moved = FirewallItem(
            id: item.id, source: item.source, sourceId: item.sourceId, type: item.type,
            title: item.title, tier: tier, tierReason: item.tierReason,
            priority: item.priority, surfacedAt: item.surfacedAt, email: item.email,
            href: item.href, hashStale: item.hashStale)
        var newTiers = tiers
        newTiers[item.tier.rawValue] = (tiers[item.tier.rawValue] ?? []).filter { $0.id != id }
        newTiers[tier.rawValue] = [moved] + (tiers[tier.rawValue] ?? [])
        func shifted(_ t: Tier, _ count: Int) -> Int {
            if t == item.tier { return max(0, count - 1) }
            if t == tier { return count + 1 }
            return count
        }
        let summary = FirewallSummary(
            silent: shifted(.silent, self.summary.silent),
            queue: shifted(.queue, self.summary.queue),
            push: shifted(.push, self.summary.push),
            auto: shifted(.auto, self.summary.auto),
            total: self.summary.total)
        return FirewallResponse(tiers: newTiers, summary: summary)
    }

    /// A copy with the given item ids removed from every tier and the summary
    /// decremented by however many were actually present (never below zero).
    /// Decrement (not recompute) so a server-side list cap can't corrupt counts.
    func removingIDs(_ ids: Set<String>) -> FirewallResponse {
        guard !ids.isEmpty else { return self }
        var newTiers = tiers
        var removed: [Tier: Int] = [:]
        for tier in Tier.allCases {
            let original = tiers[tier.rawValue] ?? []
            let kept = original.filter { !ids.contains($0.id) }
            if kept.count != original.count {
                removed[tier] = original.count - kept.count
                newTiers[tier.rawValue] = kept
            }
        }
        let summary = FirewallSummary(
            silent: max(0, self.summary.silent - (removed[.silent] ?? 0)),
            queue: max(0, self.summary.queue - (removed[.queue] ?? 0)),
            push: max(0, self.summary.push - (removed[.push] ?? 0)),
            auto: max(0, self.summary.auto - (removed[.auto] ?? 0)),
            total: max(0, self.summary.total - removed.values.reduce(0, +)))
        return FirewallResponse(tiers: newTiers, summary: summary)
    }
}

// MARK: - Email detail (reading pane)

/// GET /api/email/:id — a single email's content. Body is always plain text
/// (the API strips HTML server-side); we decode only what the reading pane needs
/// (JSONDecoder ignores the many other fields the endpoint returns).
struct EmailDetail: Codable, Sendable, Identifiable {
    let id: String
    let from: String?
    let subject: String?
    let body: String?
    let snippet: String?
    let date: String?
    let threadId: String?
    // Klorn's intelligence for this email (all optional/simple — decoding stays
    // resilient; JSONDecoder ignores the endpoint's other, richer fields).
    let summary: String?
    let needsReply: Bool?
    let needsReplyReason: String?
    /// Learned engagement: how often the user has replied to/written this sender.
    /// null (absent) for strangers — only present when there's real engagement.
    let engagement: Engagement?

    /// A measured "you engage with this sender" signal, learned from the user's
    /// own replies/sends. Display-only in the reading pane.
    struct Engagement: Codable, Sendable {
        let outboundCount: Int
        /// 0…1 dismiss-adjusted importance the graph learned. Saturates to 1 after
        /// ~4 net engagements; dismisses pull it back down — so it says "does this
        /// sender still matter" beyond the raw reply count. (interaction-graph.ts)
        let learnedImportance: Double

        /// "You engage with this sender · replied once / N times" — the raw count.
        var replyCountLabel: String {
            let times = outboundCount == 1 ? "once" : "\(outboundCount) times"
            return "You engage with this sender · replied \(times)"
        }

        /// Meter fill fraction (0…1), clamped for display safety.
        var importanceFill: Double { max(0, min(1, learnedImportance)) }

        /// Whether the learned-importance strength is worth surfacing. When dismisses
        /// have fully cancelled the engagement (fill == 0) we show only the count.
        var showsImportance: Bool { importanceFill > 0 }

        /// Qualitative reading of the 0…1 strength — paired with the meter so the
        /// signal is never conveyed by color/graphic alone (WCAG 1.4.1).
        var importanceLabel: String {
            switch importanceFill {
            case let v where v >= 0.99: return "Consistently important to you"
            case let v where v >= 0.5: return "Important to you"
            default: return "Building importance"
            }
        }

        /// One combined string for VoiceOver — count plus, when present, strength.
        var accessibilityLabel: String {
            showsImportance ? "\(replyCountLabel). \(importanceLabel)" : replyCountLabel
        }
    }

    /// Body, falling back to the snippet when the body is empty (as the web does).
    var text: String {
        if let body, !body.isEmpty { return body }
        return snippet ?? ""
    }
}

// MARK: - Commitments (promises made / replies awaited)

/// GET /api/commitments — one tracked promise. `owner == "USER"` is something
/// the user promised ("I owe"); `owner == "COUNTERPARTY"` is something the
/// other side promised ("waiting on"). Subset decode.
struct CommitmentItem: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let title: String
    let owner: String?
    let counterpartyName: String?
    let counterpartyEmail: String?
    let dueText: String?
    let status: String?

    /// "Sarah" / "sarah@co.com" / nil — whoever is on the other side.
    var counterpartyLabel: String? {
        if let name = counterpartyName, !name.isEmpty { return name }
        if let email = counterpartyEmail, !email.isEmpty { return email }
        return nil
    }
}

/// Split OPEN commitments into the two lists the user thinks in: what THEY
/// are waiting on from others, and what they owe. Unknown/missing owner goes
/// to "I owe" — a promise with no clear counterparty is still the user's to
/// resolve. Pure for testing.
func commitmentGroups(_ items: [CommitmentItem]) -> (waitingOn: [CommitmentItem], iOwe: [CommitmentItem]) {
    var waiting: [CommitmentItem] = []
    var owe: [CommitmentItem] = []
    for item in items {
        if item.owner == "COUNTERPARTY" {
            waiting.append(item)
        } else {
            owe.append(item)
        }
    }
    return (waiting, owe)
}

// MARK: - Mailbox search

/// GET /api/email?search= — one row of the searchable mailbox (decodes the
/// subset the desktop list needs; JSONDecoder ignores the rest).
struct EmailSearchItem: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let from: String?
    let subject: String?
    let snippet: String?
    let date: String?
    let isRead: Bool?
}

/// GET /api/email response envelope (subset).
struct EmailSearchResponse: Codable, Sendable {
    let emails: [EmailSearchItem]
    let total: Int
}

/// Search activates at ≥2 non-whitespace characters — a 1-char query would
/// match half the mailbox and thrash the API on every keystroke. Pure.
func isSearchActive(_ query: String) -> Bool {
    query.trimmingCharacters(in: .whitespaces).count >= 2
}

// MARK: - Daily briefing

/// GET /api/briefing/today → { briefing: { content } | null }.
struct TodayBriefing: Codable, Sendable {
    struct Note: Codable, Sendable { let content: String }
    let briefing: Note?
}

/// One-line preview of the briefing note for the TODAY column: strip markdown
/// bold, collapse whitespace/newlines to single spaces, cap length. nil when
/// there's nothing to show. Pure for testing.
func briefingPreview(_ content: String?) -> String? {
    guard let content else { return nil }
    let stripped = content.replacingOccurrences(of: "*", with: "")
    let collapsed = stripped.split(whereSeparator: { $0.isWhitespace || $0.isNewline })
        .joined(separator: " ")
    let trimmed = collapsed.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { return nil }
    return String(trimmed.prefix(140))
}

// MARK: - Calendar (today column)

/// One calendar event as serialized by /api/calendar (prisma row → ISO dates).
struct CalendarEventWire: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let title: String
    let startTime: String
    let endTime: String
    let location: String?
    let meetingLink: String?
    let allDay: Bool
}

/// GET /api/calendar/today/summary.
struct TodaySummary: Codable, Sendable {
    let total: Int
    let current: CalendarEventWire?
    let upcoming: [CalendarEventWire]
    let nextEvent: CalendarEventWire?
}

/// "05:00–06:30" / "All day" — local-time label for an event row. Malformed
/// ISO degrades to an empty string (row shows just the title), never a crash.
/// Calendar injectable so the harness pins the math in UTC.
func eventTimeLabel(
    startISO: String,
    endISO: String,
    allDay: Bool,
    calendar: Calendar = .current
) -> String {
    if allDay { return "All day" }
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let start = parser.date(from: startISO), let end = parser.date(from: endISO) else {
        return ""
    }
    func hhmm(_ date: Date) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }
    return "\(hhmm(start))–\(hhmm(end))"
}

// MARK: - Billing usage (ACCOUNT gauge)

/// GET /api/billing/models → the slice the desktop renders (daily AI quota).
struct BillingStatusWire: Codable, Sendable {
    struct Usage: Codable, Sendable {
        let rpmUsed: Int
        let rpmCap: Int
        let dailyUsed: Int
        let dailyCap: Int
    }

    let usage: Usage
}

/// Gauge fill 0…1, clamped; a zero/negative cap renders empty, never NaN.
func usageFillFraction(used: Int, cap: Int) -> Double {
    guard cap > 0 else { return 0 }
    return min(1, max(0, Double(used) / Double(cap)))
}

/// "137 / 500 today" — count label paired with the gauge (WCAG 1.4.1: the
/// signal is never conveyed by the bar alone).
func usageLabel(used: Int, cap: Int) -> String {
    "\(used) / \(cap) today"
}

/// Card footer link mirroring the reference video's "Show all N sessions" —
/// nil (hidden) unless more PUSH items wait behind the current card.
func showAllLabel(pendingCount: Int) -> String? {
    pendingCount > 0 ? "Show all \(pendingCount + 1)" : nil
}

// MARK: - Reply options (PushCard quick reply)

/// One of the 3 tone-differentiated drafts from POST /api/email/:id/reply-options.
/// Mirrors packages/contract reply-options.ts — the array order (accept /
/// decline / info) is wire contract: the card binds keys 1/2/3 positionally.
struct ReplyOption: Codable, Sendable, Hashable {
    let tone: String
    let body: String

    /// Display chip for the tone; unknown tones fall back to the capitalized raw
    /// value so a server-side tone addition degrades gracefully.
    var toneLabel: String {
        switch tone {
        case "accept": return "Accept"
        case "decline": return "Decline"
        case "info": return "Ask info"
        default: return tone.capitalized
        }
    }
}

/// POST /api/email/:id/reply-options response.
struct ReplyOptionsResponse: Codable, Sendable {
    let to: String
    let subject: String
    let options: [ReplyOption]
}

/// Email body for the expanded card's inline reader: trimmed, nil when blank
/// (no empty scroll box), and capped so one card can't grow unbounded on a
/// huge message. Pure for testing.
func cardBodyText(_ body: String?) -> String? {
    let trimmed = body?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if trimmed.isEmpty { return nil }
    return String(trimmed.prefix(4000))
}

/// The snooze options the PushCard offers — the full SnoozeOption set, in
/// display order. A single source of truth shared with the reading pane so the
/// two surfaces never drift.
enum PushCardSnooze {
    static let options: [SnoozeOption] = SnoozeOption.allCases
}

// MARK: - Snooze options

/// User-selectable snooze targets for a PUSH item; each resolves to a concrete
/// resurface time the server honours (POST /snooze accepts any ISO `snoozeUntil`).
/// Pure (Date/Calendar in) so the self-check harness can assert the math.
enum SnoozeOption: String, CaseIterable, Identifiable, Sendable {
    case oneHour, thisEvening, tomorrow, nextWeek

    var id: String { rawValue }

    var label: String {
        switch self {
        case .oneHour: return "In 1 hour"
        case .thisEvening: return "This evening"
        case .tomorrow: return "Tomorrow 9am"
        case .nextWeek: return "Next week"
        }
    }

    /// The concrete resurface time — always strictly in the future. An option whose
    /// natural time has already passed today rolls to its next sensible occurrence.
    func resurface(from now: Date = Date(), calendar: Calendar = .current) -> Date {
        switch self {
        case .oneHour:
            return calendar.date(byAdding: .hour, value: 1, to: now) ?? now
        case .thisEvening:
            let sixToday = calendar.date(bySettingHour: 18, minute: 0, second: 0, of: now) ?? now
            if sixToday > now { return sixToday }
            // Already past 6pm → roll to tomorrow evening so it's never in the past.
            let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
            return calendar.date(bySettingHour: 18, minute: 0, second: 0, of: tomorrow) ?? tomorrow
        case .tomorrow:
            let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
            return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
        case .nextWeek:
            // 09:00 the next Monday (weekday 2, Gregorian) strictly after `now`.
            let monday9 = DateComponents(hour: 9, minute: 0, second: 0, weekday: 2)
            return calendar.nextDate(after: now, matching: monday9, matchingPolicy: .nextTime)
                ?? (calendar.date(byAdding: .day, value: 7, to: now) ?? now)
        }
    }
}

// MARK: - Auth (desktop nonce-poll flow)

struct DesktopNonce: Codable, Sendable {
    let nonce: String
}

/// GET /api/auth/desktop-token/:nonce → 200 {status:"ok",token} | 202 {status:"pending"}.
struct DesktopTokenResponse: Codable, Sendable {
    let status: String
    let token: String?
}
