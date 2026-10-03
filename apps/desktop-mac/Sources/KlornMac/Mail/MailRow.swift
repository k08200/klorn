import SwiftUI

/// One whole-mailbox search hit: sender, subject, snippet. Click loads the
/// reading pane (read-only surface — firewall actions live on tier rows).
struct SearchHitRow: View {
    @Environment(AppModel.self) private var model
    let hit: EmailSearchItem

    private var selected: Bool { model.selectedItemId == hit.id }
    private var sender: String {
        let name = senderDisplayName(hit.from.map(decodeHTMLEntities))
        return name.isEmpty ? L("mail.unknownSender") : name
    }
    @State private var hovering = false

    var body: some View {
        Button {
            Task { await model.selectSearchResult(hit) }
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(sender).font(.callout.weight(hit.isRead == false ? .semibold : .regular))
                        .foregroundStyle(Theme.text).lineLimit(1)
                    // Which mailbox this message lives on — only when the
                    // account actually has several (single-inbox stays quiet).
                    if let badge = inboxRowBadge(
                        linkedId: hit.linkedInboxAccountId, inboxes: model.inboxes)
                    {
                        Text(badge).font(.caption2).foregroundStyle(Theme.textDim)
                            .lineLimit(1)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Theme.surfaceRaised, in: Capsule())
                            .accessibilityLabel(L("mail.inbox.a11y", badge))
                    }
                    Spacer(minLength: 0)
                    if let date = hit.date {
                        Text(String(date.prefix(10)))
                            .font(.caption2.monospacedDigit()).foregroundStyle(Theme.textDim)
                    }
                }
                Text(hit.subject ?? L("mail.noSubjectParen"))
                    .font(.callout).foregroundStyle(Theme.text.opacity(0.9)).lineLimit(1)
                if let snippet = hit.snippet, !snippet.isEmpty {
                    Text(snippet).font(.caption).foregroundStyle(Theme.textDim).lineLimit(1)
                }
            }
            .padding(.horizontal, 24).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .background(alignment: .leading) {
            if selected { Rectangle().fill(Theme.accent).frame(width: 3) }
        }
        .background(selected ? Theme.surfaceSelected : hovering ? Theme.surfaceHover : .clear)
        .onHover { hovering = $0 }
        .accessibilityLabel(L("mail.searchResult.a11y", sender, hit.subject ?? L("mail.noSubject")))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct FullRow: View {
    @Environment(AppModel.self) private var model
    let item: FirewallItem
    let actions: TopBarActions
    /// True on mixed-lane surfaces (the chronological inbox, search) where
    /// the row must carry its own lane; lane views leave it off — the lane
    /// is the screen title there.
    var showLaneChip = false
    @FocusState private var focused: Bool

    private var selected: Bool { model.selectedItemId == item.id }
    private var sender: String { senderDisplayName(item.email?.from.map(decodeHTMLEntities)) }
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 12) {
            // The select action is a real Button (role + keyboard + focus), not an
            // onTapGesture, so VoiceOver / Full-Keyboard-Access can open the message.
            Button { actions.onSelect(item) } label: {
                HStack(spacing: 12) {
                    // Hierarchy by size contrast, not by three near-equal lines:
                    // the sender is a small label and the subject is the
                    // statement, because the subject is what you actually scan
                    // a list for. The old row set them one point apart, which
                    // reads as one grey block at arm's length.
                    VStack(alignment: .leading, spacing: 2) {
                        // Non-EMAIL items (GitHub notifications) have no
                        // sender — a blank caption line here made them read as
                        // mail that "doesn't exist in Gmail" (2026-08-10).
                        // Web parity: firewall-board's SourceBadge.
                        if !sender.isEmpty {
                            Text(sender).font(Theme.Typo.label)
                                .foregroundStyle(Theme.textDim).lineLimit(1)
                        } else if let badge = sourceBadgeLabel(item.source) {
                            Text(badge).font(Theme.Typo.label)
                                .foregroundStyle(Theme.textDim).lineLimit(1)
                        }
                        Text(decodeHTMLEntities(item.email?.subject ?? item.title))
                            .font(Theme.Typo.head)
                            .foregroundStyle(Theme.text).lineLimit(1)
                        HStack(spacing: 6) {
                            if showLaneChip {
                                LaneChip(tier: item.tier)
                            }
                            SignalChip(
                                signal: item.email?.signal, from: item.email?.from,
                                byUser: item.email?.signalByUser ?? false)
                            if item.email?.signal == nil, hovering || focused,
                               let address = mailAddress(in: item.email?.from)
                            {
                                AddLabelChip(address: address)
                            }
                            ReplyStateChip(
                                state: item.email?.replyState,
                                draftReady: item.email?.draftReady ?? false)
                            if let reason = rowTierReason(item.tierReason) {
                                Text(reason).font(Theme.Typo.caption)
                                    .foregroundStyle(Theme.textDim).lineLimit(1)
                            }
                        }
                    }
                    Spacer(minLength: 8)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focused($focused)
            .accessibilityAddTraits(selected ? .isSelected : [])

            // Row actions surface on hover/selection/focus — at rest the list
            // stays quiet (the tier dot alone carries state). Opacity keeps
            // them clickable-by-position and fully present to VoiceOver.
            HStack(spacing: 12) {
                // Received time, always visible (design pass 2026-08-25): the
                // reference triage clients right-align a time on every row,
                // and a mail list with no time was an information gap. Falls
                // back to when Klorn surfaced the item for non-mail rows.
                let time = mailTimeLabel(
                    iso: item.email?.receivedAt ?? item.surfacedAt, now: Date())
                if !time.isEmpty {
                    Text(time)
                        .font(Theme.Typo.caption.monospacedDigit())
                        .foregroundStyle(Theme.textDim)
                }
                // The tier dot lives OUTSIDE the menu label: the AppKit
                // borderless menu renders SF Symbols as colorless templates
                // (white dot, v0.4.4) and drops SwiftUI Shapes entirely (no
                // dot, v0.4.5). A sibling Circle under a transparent menu hit
                // area is the only variant that keeps the tint AND the menu.
                ZStack {
                    Circle().fill(Theme.tint(item.tier)).frame(width: 8, height: 8)
                    if !Theme.isRenderingOffscreen {
                        TierMenu(
                            item: item, onSetTier: actions.onSetTier,
                            onPinSender: actions.onPinSender, onUnpinSender: actions.onUnpinSender
                        ) {
                            Color.clear.iconTarget()
                        }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    }
                }
                .help(L("mail.changeTier"))
                .accessibilityLabel(L("mail.changeTier.a11y", a11ySenderLabel(item), item.tier.label))
                Group {
                    if Theme.isRenderingOffscreen {
                        Image(systemName: "moon.zzz").iconTarget()
                    } else {
                        SnoozeMenu(item: item, onSnooze: actions.onSnooze) {
                            Image(systemName: "moon.zzz").iconTarget()
                        }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    }
                }
                .foregroundStyle(Theme.textDim).help(L("mail.snooze"))
                .accessibilityLabel(L("mail.snooze.a11y", a11ySenderLabel(item)))
                .opacity(hovering || selected || focused ? 1 : 0)
                Button { actions.onDismiss(item) } label: { Image(systemName: "xmark").iconTarget() }
                    .buttonStyle(.plain).foregroundStyle(Theme.textDim).help(L("mail.dismiss"))
                    .accessibilityLabel(L("mail.dismiss.a11y", a11ySenderLabel(item)))
                    .opacity(hovering || selected || focused ? 1 : 0)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 11)
        // Selection is not color-only: an accent leading bar + a stronger fill (both
        // perceivable), plus the .isSelected trait above. At REST the bar
        // carries the row's TIER instead (design renewal P2): in mixed-lane
        // surfaces (전체 수신함, search) the lane identity used to live in one
        // 8px dot at the far right — now every row wears its lane on the
        // scan edge. Muted so the list stays quiet; selection still wins.
        .background(alignment: .leading) {
            if selected {
                Rectangle().fill(Theme.accent).frame(width: 3)
            } else {
                Rectangle().fill(Theme.tint(item.tier).opacity(0.45)).frame(width: 3)
            }
        }
        .background(selected ? Theme.surfaceSelected : hovering ? Theme.surfaceHover : .clear)
        .onHover { hovering = $0 }
        // Visible keyboard-focus indicator (2.4.7 / 2.4.13): .plain suppresses the
        // system ring, so draw our own — accent on the dark panel is ≈9.5:1 (≥3:1).
        .overlay {
            if focused {
                RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.accent, lineWidth: 2)
            }
        }
    }
}
