import Foundation

/// GET /api/notifications/alert-state — the server's own answer to "may Klorn
/// interrupt right now?" for each desktop banner kind (packages/api
/// notify/desktop-alert.ts `desktopAlertState`). It is the gate Web Push and
/// the Windows shell already follow: category opt-outs and quiet hours in the
/// user's time zone (the server's focus-window rule never holds these two
/// kinds). The Mac reads it right before posting a banner instead of
/// re-deriving any of that locally.
///
/// Every field is optional so an older server (no endpoint, or a body without
/// `alerts`) decodes to "no verdict", which `ServerAlertGate` treats as allowed.
struct AlertStateWire: Decodable, Sendable, Equatable {
    struct Gate: Decodable, Sendable, Equatable {
        let allowed: Bool
        /// Why a banner is held: "user_preferences", "quiet_hours" or
        /// "focus_window". Logged; "quiet_hours" also decides that held PUSH
        /// mail waits for the catch-up (`ServerAlertGate.verdict`).
        let reason: String?
    }

    struct Alerts: Decodable, Sendable, Equatable {
        /// PUSH- and MEETING-lane mail (the server's "email_urgent" category).
        let push: Gate?
        /// A calendar meeting starting soon (the "meeting" category).
        let meeting: Gate?
    }

    let alerts: Alerts?

    static let path = "/api/notifications/alert-state"
}

/// Whether the server lets a banner of `kind` post now. Pure.
///
/// - Held (`allowed: false`): the banner is not posted. PUSH mail held for
///   quiet hours waits and comes back as one catch-up once banners are
///   allowed again, as on Windows (decision N6; `HeldBanners`). Anything else
///   held — MEETING-lane mail, a meeting-soon banner, or any hold for another
///   reason (the category turned off) — is dropped: the ledger records it as
///   seen, and the mail stays in its lane in the main window.
/// - No verdict (`state == nil` after a network or server error, a timeout,
///   or an older server): the banner posts. Fail-open on purpose: a missed
///   urgent mail is worse than a banner during quiet hours.
enum ServerAlertGate {
    /// How long the Mac waits for the verdict before posting anyway. Short:
    /// the read sits inside the queue refresh, and a hung request must not
    /// hold back the banner it was meant to gate.
    static let timeoutSeconds: TimeInterval = 4

    static func allows(_ kind: InterruptKind, state: AlertStateWire?) -> Bool {
        gate(kind, state: state)?.allowed ?? true
    }

    /// The server's reason for a hold, for the log: one of the known values,
    /// anything else as "other". nil when allowed or unknown.
    static func heldReason(_ kind: InterruptKind, state: AlertStateWire?) -> String? {
        guard let gate = gate(kind, state: state), !gate.allowed else { return nil }
        let known: Set<String> = ["user_preferences", "quiet_hours", "focus_window"]  // wire-value
        return gate.reason.flatMap { known.contains($0) ? $0 : nil } ?? "other"
    }

    /// The verdict for `kind`, as the quiet-hours catch-up (`HeldBanners`)
    /// needs it. Pure.
    static func verdict(_ kind: InterruptKind, state: AlertStateWire?) -> AlertVerdict {
        guard let gate = gate(kind, state: state) else { return .unknown }
        if gate.allowed { return .allowed }
        return gate.reason == "quiet_hours" ? .quietHours : .refused  // wire-value
    }

    private static func gate(_ kind: InterruptKind, state: AlertStateWire?) -> AlertStateWire.Gate? {
        switch kind {
        case .emailUrgent: state?.alerts?.push
        case .meeting: state?.alerts?.meeting
        }
    }
}

/// The server's answer for one banner kind, as the catch-up needs it.
enum AlertVerdict: Equatable, Sendable {
    case allowed
    /// Held for quiet hours: PUSH mail waits for the catch-up.
    case quietHours
    /// Held for any other reason (the category turned off): dropped.
    case refused
    /// No answer (network or server error, a timeout, an older server): new
    /// mail posts (fail-open); held mail waits for a real answer.
    case unknown
}
