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

// MARK: - Auth (desktop nonce-poll flow)

struct DesktopNonce: Codable, Sendable {
    let nonce: String
}

/// GET /api/auth/desktop-token/:nonce → 200 {status:"ok",token} | 202 {status:"pending"}.
struct DesktopTokenResponse: Codable, Sendable {
    let status: String
    let token: String?
}
