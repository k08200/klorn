import Foundation

/// GET /api/notifications/alert-state — the server's own answer to "may Klorn
/// interrupt right now?" for each desktop banner kind (packages/api
/// notify/desktop-alert.ts `desktopAlertState`). It is the gate Web Push and
/// the Windows shell already follow: category opt-outs and quiet hours in the
/// user's time zone (the server's focus-window rule never holds these two
/// kinds). The Mac reads it right before posting a banner instead of
/// re-deriving any of that locally.
///
/// Every field is optional: a server answer without a gate for a kind (an
/// older body without `alerts`) gates nothing, and neither does a server
/// without the endpoint (404, `noGate`). Only a read that got no answer —
/// a network or server error, a timeout — is "no verdict" (`.unknown`).
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
    /// What a server without the endpoint (404: older than 2026-11-08, #1639)
    /// answers in effect: it gates nothing.
    static let noGate = AlertStateWire(alerts: nil)
}

/// Whether the server lets a banner of `kind` post now. Pure.
///
/// - Held (`allowed: false`): the banner is not posted. PUSH mail held for
///   quiet hours waits and comes back as one catch-up once banners are
///   allowed again, as on Windows (decision N6; `HeldBanners`). Anything else
///   held — MEETING-lane mail, a meeting-soon banner, or any hold for another
///   reason (the category turned off) — is dropped: the ledger records it as
///   seen, and the mail stays in its lane in the main window.
/// - No verdict (`state == nil`: a network or server error, a timeout):
///   nothing rings unverified (2026-11-12; it used to post — fail-open — so
///   a slow read could ring through quiet hours). New PUSH mail is held like
///   quiet-hours mail and comes back on the next pass the server answers
///   (`HeldBanners`); new MEETING-lane mail is offered again on the next
///   pass; a meeting reminder is offered again on the next tick until the
///   meeting starts. No banner is lost to a failed read: the mail is in Today
///   and Mail meanwhile, and the server's own Web Push and mobile pushes
///   apply their gate independently.
///   The Windows shell fails closed the same way (packages/api
///   notify/desktop-alert.ts `desktopAlertTag`).
enum ServerAlertGate {
    /// How long the Mac waits for the verdict before treating it as no
    /// answer. Short: the read sits inside the queue refresh, and a hung
    /// request must not stall it.
    static let timeoutSeconds: TimeInterval = 4

    /// The server's reason for a hold, for the log: one of the known values,
    /// anything else as "other". nil when allowed or unknown.
    static func heldReason(_ kind: InterruptKind, state: AlertStateWire?) -> String? {
        guard let gate = gate(kind, state: state), !gate.allowed else { return nil }
        let known: Set<String> = ["user_preferences", "quiet_hours", "focus_window"]  // wire-value
        return gate.reason.flatMap { known.contains($0) ? $0 : nil } ?? "other"
    }

    /// The verdict for `kind`, given macOS's banner permission too: while
    /// macOS has no answer (its prompt may be on screen), a banner posted now
    /// is refused and lost, so an allowed banner waits as for no answer and
    /// comes back once the user allows. Pure.
    static func verdict(
        _ kind: InterruptKind, state: AlertStateWire?, permission: NotificationPermission
    ) -> AlertVerdict {
        waitsForMacOSOnly(kind, state: state, permission: permission) ? .unknown : verdict(kind, state: state)
    }

    /// Whether only macOS holds a banner of `kind` back: the server allows
    /// it and macOS's banner prompt has no answer yet. The banner waits
    /// (`verdict(_:state:permission:)`); VoiceOver does not (2026-11-13) —
    /// macOS's permission is about banners, and a user who denied them hears
    /// every announcement anyway (`PermissionWaitVoiceOver`). Pure.
    static func waitsForMacOSOnly(
        _ kind: InterruptKind, state: AlertStateWire?, permission: NotificationPermission
    ) -> Bool {
        permission == .notDetermined && verdict(kind, state: state) == .allowed
    }

    /// The verdict for `kind`. No answer is `.unknown`; an answer with no
    /// gate for `kind` gates nothing. Pure.
    static func verdict(_ kind: InterruptKind, state: AlertStateWire?) -> AlertVerdict {
        guard let state else { return .unknown }
        guard let gate = gate(kind, state: state) else { return .allowed }
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
    /// No answer (network or server error, a timeout): nothing posts. New
    /// PUSH mail is held and, with mail already held, waits for a real
    /// answer on the next pass.
    case unknown
}

/// VoiceOver while macOS's banner prompt has no answer (2026-11-13).
///
/// Since 2026-11-12 a banner waits while macOS has not answered its prompt
/// (a banner posted then is refused and lost). The VoiceOver announcement
/// rode the same path, so a VoiceOver user heard no new urgent mail until
/// they answered a question about banners, while a user who had denied
/// banners heard all of it. Now, when only macOS holds a banner back
/// (`ServerAlertGate.waitsForMacOSOnly`), VoiceOver hears the mail or meeting
/// at once and the banner keeps waiting. A waiting mail or meeting is offered
/// again on every pass, so each is heard once per wait; it is heard again,
/// once, with its banner when macOS answers.
enum PermissionWaitVoiceOver {
    /// `items` not heard yet in this wait (by `key`, first occurrence kept),
    /// and `heard` with them. Pure.
    static func unheard<T>(_ items: [T], key: (T) -> String, heard: Set<String>)
        -> (items: [T], heard: Set<String>) {
        var next = heard
        let fresh = items.filter { next.insert(key($0)).inserted }
        return (fresh, next)
    }
}
