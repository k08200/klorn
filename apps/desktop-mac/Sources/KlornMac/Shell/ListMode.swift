import SwiftUI

// MARK: - List column modes

/// Modes whose selected row is a LIVE Gmail message (not in the local
/// mirror) — the reading pane must take the folder path for them.
extension ListMode {
    var showsLiveMessages: Bool {
        if case .mailbox = self { return true }
        return self == .waitingOn
    }
}

/// What the main window's mail list column shows: a firewall tier, a mail
/// folder, commitments, proposals, the calendar or teams. Lived beside the
/// bar's full view until M8 deleted it.
enum ListMode: Equatable, Hashable {
    /// The whole inbox as one chronological list — the default view. Lanes
    /// ride on the rows as chips and remain reachable behind the 레인 group.
    case inbox
    /// The inbox narrowed to one label category (what the mail IS — the
    /// sidebar's 카테고리 since 2026-08-27).
    case label(LabelFilter)
    case tier(Tier)
    /// A standard mail folder — Sent / Drafts / Archived (shell restructure
    /// 2026-08-26: every client in the reference set has these; a triage app
    /// without them doesn't read as "my mail, organized").
    case mailbox(MailboxKind)
    /// Mail I sent that nobody answered (2026-09-18) — the other half of
    /// the reply axis. Rows open through the live folder path.
    case waitingOn
    case commitments
    /// Actions Klorn wants approved. Approving these used to require the web
    /// app, which is what kept the agent receipt linking out of Klorn.
    case proposals
    /// The week as a first-class screen. The sidebar's TODAY/UPCOMING crumbs
    /// stay, but "what does my week look like" deserves the list column
    /// (founder, 2026-08-13: the calendar existed, it just wasn't visible).
    case calendar
    /// Team mode's dedicated screen (founder 2026-08-20: a paid mode must
    /// not live in a settings corner) — teams, whole-team availability, and
    /// booking. Rendered only while the server grants team mode.
    case teams

    /// Whether the destination lives on the sidebar's mail level (folders,
    /// lanes, categories) rather than the root feature nav.
    var isMailFamily: Bool {
        switch self {
        case .inbox, .label, .tier, .mailbox, .waitingOn: true
        case .commitments, .proposals, .calendar, .teams: false
        }
    }

    /// The list column modes that carry the whole-mailbox search field
    /// (FullList.tierList) — where Find (⌘F) can land.
    var hasSearchField: Bool {
        switch self {
        case .inbox, .tier, .label: true
        default: false
        }
    }
}
