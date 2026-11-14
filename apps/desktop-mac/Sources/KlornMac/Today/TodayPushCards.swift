import SwiftUI

/// Today's PUSH mail as cards, three to a row, at most six, then one
/// "N more" link to Mail's Push lane. Which mail is listed is
/// `TodayRules.lanes` (LOCKED: PUSH inside the server's 72 h window).
struct TodayPushCards: View {
    @Environment(AppModel.self) private var model
    let lane: TodayLane
    let now: Date
    let actions: ShellActions
    let open: (FirewallItem) -> Void

    var body: some View {
        let cards = TodayBriefRules.cards(lane)
        VStack(alignment: .leading, spacing: Theme.s3) {
            let rows = stride(from: 0, to: cards.shown.count, by: TodayBriefRules.cardsPerRow).map {
                Array(cards.shown[$0..<min($0 + TodayBriefRules.cardsPerRow, cards.shown.count)])
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .top, spacing: Theme.s3) {
                    ForEach(row, id: \.id) { item in
                        TodayPushCard(item: item, now: now, actions: actions, open: { open(item) })
                    }
                    // A short second row keeps the first row's column widths.
                    if rows.count > 1 {
                        ForEach(0..<(TodayBriefRules.cardsPerRow - row.count), id: \.self) { _ in
                            Color.clear.frame(maxWidth: .infinity)
                        }
                    }
                }
                // One height per row: the tallest card's.
                .fixedSize(horizontal: false, vertical: true)
            }
            if cards.more > 0 {
                link(L("today.cards.more", cards.more))
            } else if cards.shown.isEmpty, lane.older > 0 {
                // Nothing inside Today's window: older PUSH stays one click
                // away in Mail, so nothing becomes unreachable.
                link(L("today.lane.push.older", lane.tier.label))
            }
        }
    }

    private func link(_ title: String) -> some View {
        Button { model.go(to: .tier(.push)) } label: {
            Text(title).font(Theme.Typo.label).foregroundStyle(Theme.todayInk2)
                .frame(minHeight: TodayLayout.linkHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// One PUSH card: who (a face ringed in the account's color) and when, the
/// kicker, why it is urgent (the judge's reason), the subject, then Reply
/// and Later. The whole card opens the mail; the two buttons sit above it.
private struct TodayPushCard: View {
    @Environment(AppModel.self) private var model
    let item: FirewallItem
    let now: Date
    let actions: ShellActions
    let open: () -> Void
    @State private var hovering = false

    var body: some View {
        let content = WindowRowRules.content(
            for: item, mixedLanes: false, inboxes: model.inboxes, opened: model.openedEmailIds, now: now)
        let text = TodayBriefRules.cardText(
            reason: content.reason, subject: content.subject, snippet: content.snippet)
        VStack(alignment: .leading, spacing: Theme.s2) {
            header(content)
            Text(text.title).font(Theme.Typo.cardTitle).foregroundStyle(Theme.todayInk1)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            if let body = text.body {
                Text(body).font(Theme.Typo.body).foregroundStyle(Theme.todayInk2)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Theme.s3)
            footer
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, minHeight: TodayLayout.cardMinHeight, alignment: .topLeading)
        .background { cardButton(content: content, text: text) }
    }

    private func header(_ content: WindowRowContent) -> some View {
        HStack(spacing: Theme.s2) {
            TodayFace(
                name: content.sender, key: item.email?.from ?? content.sender,
                ring: AccountIdentity.color(of: item, among: model.inboxes),
                diameter: TodayLayout.cardFace)
            VStack(alignment: .leading, spacing: 0) {
                Text(content.sender).font(Theme.Typo.cardSender).foregroundStyle(Theme.todayInk1)
                    .lineLimit(1)
                Text(content.time).font(Theme.Typo.cardTime).foregroundStyle(Theme.todayInk3)
                    .lineLimit(1)
            }
            Spacer(minLength: Theme.s2)
            Text(Tier.push.label.uppercased())
                .font(Theme.Typo.cardKicker).tracking(TodayTracking.kicker)
                .foregroundStyle(Theme.todayPushInk)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var footer: some View {
        HStack(spacing: Theme.s1) {
            Button {
                open()
                model.requestReply(to: item)
            } label: {
                Text(L("today.cards.reply")).font(Theme.Typo.label).foregroundStyle(Theme.todayInk1)
                    .padding(.horizontal, Theme.s3)
                    .frame(height: TodayLayout.buttonHeight)
                    .background(Theme.todayButtonFill, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(L("today.cards.reply.help"))
            later
        }
    }

    /// Later is the existing snooze: the same four times as the reader.
    @ViewBuilder
    private var later: some View {
        let label = Text(L("today.cards.later")).font(Theme.Typo.label).foregroundStyle(Theme.todayInk2)
            .padding(.horizontal, Theme.s3)
            .frame(height: TodayLayout.buttonHeight)
            .contentShape(Rectangle())
        if Theme.isRenderingOffscreen {
            // ImageRenderer paints an AppKit menu as a placeholder.
            label
        } else {
            SnoozeMenu(item: item, onSnooze: actions.onSnooze) { label }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help(L("today.cards.later.help"))
                .accessibilityLabel(L("today.cards.later"))
        }
    }

    /// The card's surface is the button that opens the mail, so the whole
    /// card is one click target with the system focus ring.
    private func cardButton(content: WindowRowContent, text: TodayBriefRules.CardText) -> some View {
        Button(action: open) {
            RoundedRectangle(cornerRadius: Theme.Radius.briefCard)
                .fill(Theme.todayRaised)
                .overlay(alignment: .top) {
                    // The inner top highlight (white 5%, dark only).
                    RoundedRectangle(cornerRadius: Theme.Radius.briefCard)
                        .strokeBorder(
                            LinearGradient(
                                colors: [Theme.todayHighlight, .clear], startPoint: .top,
                                endPoint: .center),
                            lineWidth: Theme.hairline)
                }
                .overlay {
                    if hovering {
                        RoundedRectangle(cornerRadius: Theme.Radius.briefCard).fill(Theme.todayChip)
                    }
                }
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(L("today.card.a11y", text.title, content.sender, content.time))
        .accessibilityHint(content.subject)
    }
}

/// A sender's face: a photo when Klorn has one (the server sends none yet),
/// else initials on a muted hue hashed from the sender, ringed in the color
/// of the account the mail is on.
struct TodayFace: View {
    let name: String
    /// What the hue is hashed from (the raw sender, address included).
    let key: String
    let ring: Theme.RGBA?
    let diameter: CGFloat

    var body: some View {
        Circle()
            .fill(Theme.color(Theme.avatarFillComponents(hue: TodayBriefRules.hue(for: key))))
            .overlay {
                Text(TodayBriefRules.monogram(name))
                    .font(Theme.Typo.avatarMonogram(diameter)).foregroundStyle(Theme.onAvatar)
            }
            .overlay {
                Circle().strokeBorder(ring.map(Theme.color) ?? Theme.todayLine, lineWidth: TodayLayout.ringWidth)
            }
            .frame(width: diameter, height: diameter)
            .accessibilityHidden(true)
    }
}
