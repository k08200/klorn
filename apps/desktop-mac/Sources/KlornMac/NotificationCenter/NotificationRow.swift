import AppKit
import SwiftUI

/// One bell row (gen_nc.py `row`): a face or an outline symbol; who and
/// when; the subject on one line; why it rang (a verified quote in
/// quotation marks, else "Klorn's judgment · …", else nothing); the lane
/// and where it was delivered; then the row's actions. The whole row opens
/// its target and marks it read. Every server string is shown as plain text.
struct NotificationRow: View {
    @Environment(AppModel.self) private var model
    let row: NotificationWire
    let group: NotificationGroup
    let now: Date
    let actions: ShellActions
    @State private var hovering = false

    private var store: NotificationCenterStore { model.notificationCenter }

    var body: some View {
        let mail = NotificationFeedRules.mail(for: row, in: model.queue)
        let display = NotificationFeedRules.display(row, mail: mail)
        let reason = NotificationFeedRules.reasonLine(row.reason, fallback: rowTierReason(mail?.tierReason))
        HStack(alignment: .top, spacing: Theme.s3) {
            leading(display, mail: mail)
            VStack(alignment: .leading, spacing: Theme.s1) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.s2) {
                    Text(display.who).font(Theme.Typo.cardSender).foregroundStyle(Theme.todayInk1)
                        .lineLimit(1)
                    if !row.isRead {
                        Circle().fill(Theme.accent).frame(width: NotificationRowMetrics.unreadDot,
                                                           height: NotificationRowMetrics.unreadDot)
                            .accessibilityHidden(true)
                    }
                    Spacer(minLength: Theme.s2)
                    Text(NotificationFeedRules.timeLabel(row.createdAt, now: now))
                        .font(Theme.Typo.cardTime).foregroundStyle(Theme.todayInk3).lineLimit(1).fixedSize()
                }
                Text(display.subject).font(Theme.Typo.body).foregroundStyle(Theme.todayInk1).lineLimit(1)
                if let reason {
                    Text(NotificationFeedRules.reasonText(reason)).font(Theme.Typo.meta)
                        .foregroundStyle(Theme.todayInk2).lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                footer(mail: mail)
            }
        }
        .padding(.horizontal, Theme.s4)
        .padding(.vertical, Theme.s3)
        .background { rowButton(display: display) }
        .task(id: row.id) {
            guard !Theme.isRenderingOffscreen else { return }
            await store.loadDelivery(row.id)
        }
    }

    @ViewBuilder
    private func leading(_ display: NotificationFeedRules.Display, mail: FirewallItem?) -> some View {
        if let key = display.faceKey {
            TodayFace(
                name: display.who, key: key,
                ring: mail.flatMap { AccountIdentity.color(of: $0, among: model.inboxes) },
                diameter: NotificationRowMetrics.face)
        } else {
            Image(systemName: NotificationFeedRules.symbol(row, group: group))
                .font(Theme.Typo.icon).foregroundStyle(Theme.todayInk2)
                .frame(width: NotificationRowMetrics.face, height: NotificationRowMetrics.face)
                .background(Theme.todayChip, in: Circle())
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private func footer(mail: FirewallItem?) -> some View {
        let lane = row.lane ?? mail?.tier
        let delivered = NotificationFeedRules.deliveredText(store.deliveredTo(row))
        let rowActions = NotificationFeedRules.actions(row, mail: mail, group: group)
        if lane != nil || delivered != nil || row.held || !rowActions.isEmpty {
            HStack(spacing: Theme.s2) {
                HStack(spacing: Theme.s1) {
                    if let lane {
                        Circle().fill(Theme.tint(lane))
                            .frame(width: NotificationRowMetrics.laneDot, height: NotificationRowMetrics.laneDot)
                            .accessibilityHidden(true)
                        Text(lane.label)
                    }
                    if let text = metaText(lane: lane, delivered: delivered) { Text(text) }
                }
                .font(Theme.Typo.cardTime).foregroundStyle(Theme.todayInk3).lineLimit(1)
                Spacer(minLength: Theme.s2)
                ForEach(Array(rowActions.enumerated()), id: \.offset) { index, action in
                    button(action, filled: index == 0)
                }
            }
            .padding(.top, Theme.s1)
        }
    }

    /// " · Received on Mac · Chrome", " · Held for quiet hours".
    private func metaText(lane: Tier?, delivered: String?) -> String? {
        let parts = [row.held ? L("nc.meta.held") : nil, delivered].compactMap { $0 }
        guard !parts.isEmpty else { return nil }
        let joined = parts.joined(separator: " · ")
        return lane == nil ? joined : "· " + joined
    }

    @ViewBuilder
    private func button(_ action: NotificationFeedRules.RowAction, filled: Bool) -> some View {
        switch action {
        case .reply(let item):
            pill(L("nc.action.reply"), filled: filled) {
                finish()
                model.revealInMail(item)
                actions.onSelect(item)
                model.requestReply(to: item)
            }
            .help(L("today.cards.reply.help"))
        case .later(let item):
            let label = pillLabel(L("nc.action.later"), filled: filled)
            if Theme.isRenderingOffscreen {
                label
            } else {
                SnoozeMenu(item: item, onSnooze: { snoozed, option in
                    Task { await store.markRead(row.id) }
                    actions.onSnooze(snoozed, option)
                }) { label }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .help(L("today.cards.later.help"))
                    .accessibilityLabel(L("nc.action.later"))
            }
        case .join(let url):
            pill(L("nc.action.join"), filled: filled) {
                Task { await store.markRead(row.id) }
                NSWorkspace.shared.open(url)
            }
        case .open:
            pill(L("nc.action.open"), filled: filled) {
                finish()
                actions.onOpenProposals()
            }
        }
    }

    private func pill(_ title: String, filled: Bool, _ perform: @escaping () -> Void) -> some View {
        Button(action: perform) { pillLabel(title, filled: filled) }.buttonStyle(.plain)
    }

    private func pillLabel(_ title: String, filled: Bool) -> some View {
        Text(title).font(Theme.Typo.label)
            .foregroundStyle(filled ? Theme.todayInk1 : Theme.todayInk2)
            .padding(.horizontal, Theme.s3)
            .frame(height: NotificationRowMetrics.buttonHeight)
            .background(filled ? Theme.todayButtonFill : Color.clear,
                        in: RoundedRectangle(cornerRadius: Theme.Radius.control))
            .contentShape(Rectangle())
    }

    /// Mark read and put the panel away: the user went somewhere.
    private func finish() {
        Task { await store.markRead(row.id) }
        store.panelOpen = false
    }

    /// The row's surface opens its target, so the whole row is one target.
    private func rowButton(display: NotificationFeedRules.Display) -> some View {
        Button(action: openTarget) {
            Rectangle().fill(hovering ? Theme.todayChip : Color.clear)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(L("nc.row.a11y", display.who, display.subject))
    }

    private func openTarget() {
        let mail = NotificationFeedRules.mail(for: row, in: model.queue)
        switch NotificationFeedRules.target(row, mail: mail) {
        case .mail(let item):
            finish()
            model.revealInMail(item)
            actions.onSelect(item)
        case .mailbox:
            finish()
            model.navigate(to: .mail)
        case .proposals:
            finish()
            actions.onOpenProposals()
        case .calendar:
            finish()
            model.navigate(to: .calendar)
        case .none:
            Task { await store.markRead(row.id) }
        }
    }
}

enum NotificationRowMetrics {
    static let face: CGFloat = 30
    static let laneDot: CGFloat = 6
    static let unreadDot: CGFloat = 6
    static let buttonHeight: CGFloat = 26
}
