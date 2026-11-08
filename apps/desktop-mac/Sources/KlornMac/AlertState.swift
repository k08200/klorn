import Foundation

/// GET /api/notifications/alert-state — the server's own answer to "may Klorn
/// interrupt right now?" for each desktop banner kind (packages/api
/// notify/desktop-alert.ts `desktopAlertState`). It is the gate Web Push and
/// the Windows shell already follow: category opt-outs, quiet hours in the
/// user's time zone, and the focus-window rule. The Mac reads it right before
/// posting a banner instead of re-deriving any of that locally.
///
/// Every field is optional so an older server (no endpoint, or a body without
/// `alerts`) decodes to "no verdict", which `ServerAlertGate` treats as allowed.
struct AlertStateWire: Decodable, Sendable, Equatable {
    struct Gate: Decodable, Sendable, Equatable {
        let allowed: Bool
        /// Why a banner is held: "user_preferences", "quiet_hours" or
        /// "focus_window". For the log only; the Mac never branches on it.
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
/// - Held (`allowed: false`): the banner is not posted and is dropped — the
///   ledger records it as seen, so it is not posted later when quiet hours
///   end. That matches Web Push, which skips the ring and keeps the bell row;
///   the mail stays in its lane in the main window.
/// - No verdict (`state == nil` after a network or server error, or an older
///   server): the banner posts. Fail-open on purpose: a missed urgent mail is
///   worse than a banner during quiet hours.
enum ServerAlertGate {
    static func allows(_ kind: InterruptKind, state: AlertStateWire?) -> Bool {
        gate(kind, state: state)?.allowed ?? true
    }

    /// The held reason, for the log. nil when allowed or unknown.
    static func heldReason(_ kind: InterruptKind, state: AlertStateWire?) -> String? {
        guard let gate = gate(kind, state: state), !gate.allowed else { return nil }
        return gate.reason ?? "unspecified"
    }

    private static func gate(_ kind: InterruptKind, state: AlertStateWire?) -> AlertStateWire.Gate? {
        switch kind {
        case .emailUrgent: state?.alerts?.push
        case .meeting: state?.alerts?.meeting
        }
    }
}
