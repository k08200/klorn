import Foundation

// MARK: - Urgent mail held during quiet hours

/// PUSH mail that arrived while the server's gate said `quiet_hours`, shown as
/// one catch-up once it allows banners again — what the Windows shell does
/// (decision N6, LOCKED 2026-11-08, PR #1644: packages/web
/// lib/native/desktop-push-catchup.ts):
/// - one held mail comes back as its own banner; two or more as ONE summary,
///   "N urgent emails during quiet hours", naming up to three senders, which
///   opens Today;
/// - only PUSH mail still in the lane, not opened on this Mac, from the last
///   72 hours;
/// - quiet hours hold; any other hold (the category turned off) drops, and so
///   does the local Urgent-email switch; no answer from the server keeps the
///   held mail for a later pass while new mail posts (fail-open).
/// MEETING-lane mail and meeting-soon banners held by quiet hours stay dropped:
/// N6 catches up PUSH mail only (the server's desktop catch-up reads the PUSH
/// lane alone), and a reminder for a meeting that has started is useless.
///
/// The held ids live in the PUSH ledger (`PushLedger.held`), so they persist
/// across relaunches exactly as the ledger does. They are recorded as
/// announced too: no later plan offers them again, so a held mail is posted
/// at most once — by the catch-up — or never.
enum HeldBanners {
    /// Only mail from the last 72 hours is caught up (Windows'
    /// PUSH_CATCHUP_WINDOW_MS).
    static let windowSeconds: TimeInterval = 72 * 60 * 60
    /// Mails held at most, newest kept. The firewall read returns at most 200
    /// open items, so in practice nothing is trimmed and the summary's count
    /// is the real one; the cap only bounds the stored record.
    static let maxHeld = 200
    /// After a quiet-hours answer, held mail alone asks again only after this
    /// long (Windows' HELD_RETRY_MS). New mail still asks right away.
    static let askAgainSeconds: TimeInterval = 5 * 60
    /// Senders named in the summary body before "+k".
    static let summarySendersMax = 3

    /// The PUSH-lane items a catch-up may still show: unread (an explicit
    /// `unread: false` is out), not opened on this Mac (`opened` holds
    /// EmailMessage ids), and received — or surfaced, when there is no mail
    /// time — within `windowSeconds` of `now`, the edge included. An
    /// unparseable time is out. Order kept. Pure.
    static func eligible(_ lane: [FirewallItem], opened: Set<String>, now: Date) -> [FirewallItem] {
        lane.filter { item in
            if item.email?.unread == false { return false }
            if let emailDbId = item.email?.emailDbId, opened.contains(emailDbId) { return false }
            // meetingStart is the app's ISO-8601 reader (fractional seconds or not).
            guard let at = meetingStart(item.email?.receivedAt ?? item.surfacedAt) else { return false }
            return now.timeIntervalSince(at) <= windowSeconds
        }
    }

    /// "A, B, C +2": distinct non-blank senders in order, at most `max` named.
    /// Pure.
    static func formatSenders(_ names: [String], max: Int = summarySendersMax) -> String {
        var seen = Set<String>()
        let distinct = names
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
        let shown = distinct.prefix(max).joined(separator: ", ")
        let rest = distinct.count - max
        return rest > 0 ? "\(shown) +\(rest)" : shown
    }

    /// The summary banner for two or more held mails, `items` newest first:
    /// a count title and the senders — no subject, so one banner never lists
    /// several mails' contents. A tap opens Today
    /// (`NotificationTapAction.openToday`). Pure.
    static func summaryBanner(for items: [FirewallItem], kind: SummaryKind = .quietHours) -> PushBanner {
        let senders = items.map { senderDisplayName($0.email?.from.map(decodeHTMLEntities)) }
        let title = kind == .whileClosed ? "push.closedSummary.title" : "push.heldSummary.title"
        return PushBanner(
            identifier: PushNotifier.summaryIdentifier(for: items.first?.id ?? ""),
            title: L(title, items.count),
            body: formatSenders(senders))
    }

    /// The held items in `eligible`, newest first: by arrival (mail time,
    /// else surfacedAt — ISO-8601 strings with a fixed-width date prefix sort
    /// as strings, see `FirewallResponse`), ties broken by the later hold.
    /// Pure.
    static func due(_ eligible: [FirewallItem], held: [String]) -> [FirewallItem] {
        let rank = Dictionary(held.enumerated().map { ($1, $0) }, uniquingKeysWith: max)
        return eligible.filter { rank[$0.id] != nil }.sorted { a, b in
            let (ta, tb) = (arrivalTime(a), arrivalTime(b))
            return ta != tb ? ta > tb : (rank[a.id] ?? 0) > (rank[b.id] ?? 0)
        }
    }

    /// Newest arrival first, ties in their given order. Pure.
    static func arrival(_ items: [FirewallItem]) -> [FirewallItem] {
        items.enumerated().sorted { a, b in
            let (ta, tb) = (arrivalTime(a.element), arrivalTime(b.element))
            return ta != tb ? ta > tb : a.offset < b.offset
        }.map(\.element)
    }

    private static func arrivalTime(_ item: FirewallItem) -> String {
        item.email?.receivedAt ?? item.surfacedAt
    }

    /// Which summary a catch-up posts: mail held during quiet hours, or
    /// mail that arrived while Klorn was quit (N6, 2026-11-11).
    enum SummaryKind: Equatable, Sendable {
        case quietHours, whileClosed
    }

    struct Outcome: Equatable {
        /// Banners to post one per mail: this pass's new mail, plus a lone
        /// held mail (first). The catch-up adds at most one banner on top of
        /// the sync's own `PushLedger.maxBannersPerSync`.
        let post: [FirewallItem]
        /// Held mail for ONE summary banner: empty, or two or more.
        let summary: [FirewallItem]
        let next: PushLedger
        /// What `summary` is about (its title).
        var summaryKind: SummaryKind = .quietHours
    }

    /// What this pass posts once the server's verdict is in. `ledger` is the
    /// one read after the verdict (another pass may have changed it during
    /// the wait); `fresh` is the plan's banners, `unseenPush` every new PUSH
    /// mail of this pass, `eligible` the lane's catch-up candidates.
    /// `missed` is set on the first pass after launch only: the eligible new
    /// PUSH mail that arrived while Klorn was quit (N6). It is caught up like
    /// held mail — one banner, or ONE "while Klorn was closed" summary — and
    /// quiet hours hold it the same way. Pure.
    static func resolve(
        verdict: AlertVerdict, ledger: PushLedger,
        fresh: [FirewallItem], unseenPush: [FirewallItem], eligible: [FirewallItem],
        missed: [FirewallItem] = []
    ) -> Outcome {
        switch verdict {
        case .quietHours:
            // The lane lists newest first; the held list is oldest first.
            let candidates = Set(eligible.map(\.id))
            let holdNow = arrival(unseenPush.filter { candidates.contains($0.id) }).reversed().map(\.id)
            return Outcome(post: [], summary: [], next: ledger.holding(holdNow, whileClosed: !missed.isEmpty))
        case .refused:
            return Outcome(post: [], summary: [], next: ledger.clearingHeld())
        case .unknown:
            // Fail-open for new mail: what was missed while quit is caught up
            // now; mail held for quiet hours waits for an answer.
            let caughtUp = catchUp(missed, fresh: fresh, kind: .whileClosed)
            return Outcome(post: caughtUp.post, summary: caughtUp.summary, next: ledger,
                           summaryKind: caughtUp.summaryKind)
        case .allowed:
            // Only what this pass shows leaves the list: an overlapping pass
            // may have held newer mail during the wait.
            let held = due(eligible, held: ledger.heldIDs)
            let next = ledger.keepingHeld(Set(ledger.heldIDs).subtracting(held.map(\.id)))
            let heldIDs = Set(held.map(\.id))
            let waiting = arrival(held + missed.filter { !heldIDs.contains($0.id) })
            let closed = !missed.isEmpty || ledger.heldWhileClosed == true
            let caughtUp = catchUp(waiting, fresh: fresh, kind: closed ? .whileClosed : .quietHours)
            return Outcome(post: caughtUp.post, summary: caughtUp.summary, next: next,
                           summaryKind: caughtUp.summaryKind)
        }
    }

    /// One catch-up: a lone mail is posted as itself (first), two or more
    /// become ONE summary. Pure.
    private static func catchUp(
        _ waiting: [FirewallItem], fresh: [FirewallItem], kind: SummaryKind
    ) -> (post: [FirewallItem], summary: [FirewallItem], summaryKind: SummaryKind) {
        if waiting.count == 1 { return (waiting + fresh, [], kind) }
        return (fresh, waiting, kind)
    }

    /// The first pass after launch, split (N6): `missed` is the eligible new
    /// PUSH mail, newest first, for the catch-up; `fresh` keeps the plan's
    /// other banners (MEETING mail) only. Pure.
    static func launchSplit(
        plan: PushLedger.Plan, eligible: [FirewallItem]
    ) -> (missed: [FirewallItem], fresh: [FirewallItem]) {
        let candidates = Set(eligible.map(\.id))
        let unseen = Set(plan.unseenPush.map(\.id))
        let missed = arrival(plan.unseenPush.filter { candidates.contains($0.id) })
        return (missed, plan.toNotify.filter { !unseen.contains($0.id) })
    }
}

extension PushLedger {
    /// Held PUSH mail ids, oldest first (none on a ledger saved before them).
    var heldIDs: [String] { held ?? [] }

    /// This ledger with `ids` held too: ids already held keep their place,
    /// at most `HeldBanners.maxHeld`, newest kept. `whileClosed` marks that
    /// some of them arrived while Klorn was quit, so the summary says so.
    /// Pure.
    func holding(_ ids: [String], whileClosed: Bool = false) -> PushLedger {
        let current = heldIDs
        let added = ids.filter { !current.contains($0) }
        guard !added.isEmpty else { return self }
        var next = self
        next.held = Array((current + added).suffix(HeldBanners.maxHeld))
        if whileClosed { next.heldWhileClosed = true }
        return next
    }

    /// This ledger holding only the ids in `keep`. Pure.
    func keepingHeld(_ keep: Set<String>) -> PushLedger {
        let kept = heldIDs.filter(keep.contains)
        guard kept != heldIDs else { return self }
        var next = self
        next.held = kept
        if kept.isEmpty { next.heldWhileClosed = nil }
        return next
    }

    /// This ledger with nothing held. Pure.
    func clearingHeld() -> PushLedger {
        guard !heldIDs.isEmpty else { return self }
        var next = self
        next.held = []
        next.heldWhileClosed = nil
        return next
    }
}
