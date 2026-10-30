import AppKit
import SwiftUI

/// FREE-plan refusals and the one way out of them.
///
/// Every signup starts on FREE; Pro is bought on the web (founder decision
/// 2026-10-24). The Mac app has no billing screen, so a needs-Pro notice
/// without a link is a dead end: each one carries `UpgradeToProLink`, which
/// opens the web billing page in the default browser. This is the only place
/// the app links into the Klorn web app outside sign-in.
enum PlanUpgrade {
    static let billingPath = "/billing"

    static func billingURL(webBase: String = Config.webBaseURL) -> URL? {
        URL(string: webBase + billingPath)
    }

    /// The catalogue keys of every needs-Pro sentence a notice can show. A
    /// notice showing one of them gets the upgrade link beside it.
    static let needsProKeys = [
        "error.needsPro", "reply.needsPro", "compose.needsPro", "proposals.needsPro",
    ]

    /// Those sentences in every shipped language. A notice keeps the text it
    /// was set with, so after an in-app language switch it no longer equals
    /// what L() returns; matching every catalogue keeps its link.
    private static let needsProTexts: Set<String> = Set(
        needsProKeys.flatMap { key in L10n.shipped.compactMap { L10n.value(key, language: $0) } })

    /// Whether a shown notice is a needs-Pro sentence, in any shipped language.
    static func offersUpgrade(for message: String?) -> Bool {
        guard let message else { return false }
        return needsProTexts.contains(message) || needsProKeys.contains { L($0) == message }
    }
}

/// Why a paid action did not run: it failed (worth a retry), or the plan
/// refused it (a retry never works — the way out is the upgrade).
enum ActionFailure: Equatable, Sendable {
    case failed
    case needsPro

    static func classify(_ error: Error) -> ActionFailure {
        if case APIError.forbidden = error { return .needsPro }
        return .failed
    }
}

/// The assistant turn the server's daily AI cost cap stopped. The server says
/// which cap through the turn's `errorCode`; an older server sends none.
enum ChatCapNotice: Equatable, Sendable {
    /// The FREE plan's allowance: Pro raises it.
    case free
    /// A paid plan's allowance: nothing to upgrade to.
    case paid

    init?(errorCode: String?) {
        switch errorCode {
        case "DAILY_COST_CAP_FREE": self = .free
        case "DAILY_COST_CAP": self = .paid
        default: return nil
        }
    }

    var text: String { L(self == .free ? "chat.cap.free" : "chat.cap.daily") }
    var offersUpgrade: Bool { self == .free }
}

/// "Upgrade to Pro": opens the web billing page in the default browser.
struct UpgradeToProLink: View {
    var body: some View {
        if let url = PlanUpgrade.billingURL() {
            Button(L("plan.upgrade")) { NSWorkspace.shared.open(url) }
                .buttonStyle(.bordered).controlSize(.small)
                .help(url.absoluteString)
                .accessibilityHint(L("plan.upgrade.a11yHint"))
        }
    }
}
