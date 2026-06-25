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
