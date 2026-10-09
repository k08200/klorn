import SwiftUI

/// How a mail row is drawn. `.legacy` is the bar's row, unchanged; `.window`
/// is the main window's row under the one-badge rule (productization plan §1).
enum MailRowStyle: Sendable {
    case legacy
    case window

    var shell: ShellStyle { self == .window ? .window : .bar }
}

/// What a main-window row may show, and nothing else: who, what, when, the
/// lane (only where lanes are mixed), the account (only when the row knows
/// it) and the unread dot (only when the row knows that). Category, the
/// relationship, the reply state and why-this-lane are in the reader header.
struct WindowRowContent: Equatable {
    var sender: String
    var subject: String
    var snippet: String?
    var time: String
    /// nil = the row's data does not say (firewall items carry no read state).
    var unread: Bool?
    /// nil = no chip: the lane tab above the list already names it.
    var lane: Tier?
    /// The account's provider, when the row carries its account and there is
    /// more than one to tell apart. Firewall items carry none.
    var provider: String?
    var showsAccount = false
}

enum WindowRowRules {
    /// The snippet with the subject's echo and stray whitespace removed; nil
    /// when nothing is left to say.
    static func snippet(_ raw: String?, subject: String) -> String? {
        guard let raw else { return nil }
        let flat = decodeHTMLEntities(raw)
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return flat.isEmpty || flat == subject ? nil : flat
    }

    /// The lane chip shows on mixed-lane lists only (All, a label, search,
    /// silenced is a lane of its own and needs none).
    static func lane(for item: FirewallItem, mixedLanes: Bool) -> Tier? {
        mixedLanes ? item.tier : nil
    }

    static func content(for item: FirewallItem, mixedLanes: Bool, now: Date) -> WindowRowContent {
        let subject = decodeHTMLEntities(item.email?.subject ?? item.title)
        return WindowRowContent(
            sender: a11ySenderLabel(item), subject: subject,
            snippet: snippet(item.email?.snippet, subject: subject),
            time: mailTimeLabel(iso: item.email?.receivedAt ?? item.surfacedAt, now: now),
            unread: nil, lane: lane(for: item, mixedLanes: mixedLanes))
    }

    static func content(
        for hit: EmailSearchItem, inboxes: [InboxOption], now: Date
    ) -> WindowRowContent {
        let name = senderDisplayName(hit.from.map(decodeHTMLEntities))
        let subject = decodeHTMLEntities(hit.subject ?? L("mail.noSubjectParen"))
        let time = mailTimeLabel(iso: hit.date, now: now)
        let account = inboxes.count >= 2
            ? inboxes.first { $0.id == hit.linkedInboxAccountId } : nil
        return WindowRowContent(
            sender: name.isEmpty ? L("mail.unknownSender") : name, subject: subject,
            snippet: snippet(hit.snippet, subject: subject),
            time: time.isEmpty ? String((hit.date ?? "").prefix(10)) : time,
            unread: hit.isRead.map { !$0 }, lane: nil,
            provider: account?.provider, showsAccount: account != nil)
    }
}

/// The two lines of a main-window row.
struct WindowRowBody: View {
    let content: WindowRowContent

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s1) {
            HStack(alignment: .center, spacing: Theme.s2) {
                if let unread = content.unread {
                    Circle().fill(unread ? Theme.accentSolid : .clear)
                        .frame(width: Self.unreadDot, height: Self.unreadDot)
                        .accessibilityHidden(true)
                }
                Text(content.sender)
                    .font(Theme.Typo.body.weight(.semibold))
                    .foregroundStyle(Theme.text).lineLimit(1)
                if content.showsAccount {
                    SourceBadge(provider: content.provider, compact: true)
                }
                Spacer(minLength: Theme.s2)
                if let lane = content.lane {
                    WindowLaneChip(tier: lane)
                }
                if !content.time.isEmpty {
                    Text(content.time)
                        .font(Theme.Typo.caption.monospacedDigit())
                        .foregroundStyle(Theme.textDim).lineLimit(1).fixedSize()
                }
            }
            .frame(height: WindowLaneChip.height)
            subjectLine
                .font(Theme.Typo.label.weight(.regular))
                .lineLimit(1)
                .padding(.leading, content.unread == nil ? 0 : Self.unreadDot + Theme.s2)
        }
    }

    private var subjectLine: Text {
        let subject = Text(content.subject).foregroundStyle(Theme.text)
        guard let snippet = content.snippet else { return subject }
        return subject + Text("  " + snippet).foregroundStyle(Theme.textDim)
    }

    static let unreadDot: CGFloat = 6
}

/// The row's surface: a rounded fill for hover and selection, the accent bar
/// so selection is never color alone, and the keyboard focus ring.
private struct WindowRowChrome: ViewModifier {
    let selected: Bool
    let hovering: Bool
    let focused: Bool

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s2)
            .frame(maxWidth: .infinity, minHeight: Theme.rowHeight, alignment: .leading)
            .background(alignment: .leading) {
                if selected {
                    Capsule().fill(Theme.accent).frame(width: 3).padding(.vertical, Theme.s3)
                }
            }
            .background(
                selected ? Theme.surfaceSelected : hovering ? Theme.surfaceHover : .clear,
                in: RoundedRectangle(cornerRadius: Theme.Radius.md))
            .overlay {
                if focused {
                    RoundedRectangle(cornerRadius: Theme.Radius.md)
                        .strokeBorder(Theme.accent, lineWidth: 2)
                }
            }
            .padding(.horizontal, Theme.s2)
    }
}

/// A firewall item in the main window's list.
struct WindowMailRow: View {
    @Environment(AppModel.self) private var model
    let item: FirewallItem
    let actions: TopBarActions
    var showLaneChip = false
    @FocusState private var focused: Bool
    @State private var hovering = false

    private var selected: Bool { model.selectedItemId == item.id }
    /// Row actions stay out of the way until the pointer or the keyboard is
    /// on the row; the reader header has the same three for the open mail.
    private var showsActions: Bool { hovering || focused }

    var body: some View {
        let content = WindowRowRules.content(for: item, mixedLanes: showLaneChip, now: Date())
        // A real Button (role, keyboard, focus), as in the bar's row.
        Button { actions.onSelect(item) } label: {
            WindowRowBody(content: content)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focused($focused)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .modifier(WindowRowChrome(selected: selected, hovering: hovering, focused: focused))
        .overlay(alignment: .trailing) {
            if !Theme.isRenderingOffscreen {
                rowActions
                    .opacity(showsActions ? 1 : 0)
                    .allowsHitTesting(showsActions)
            }
        }
        .onHover { hovering = $0 }
    }

    /// Move to lane, snooze, dismiss. They cover the time while shown, on an
    /// opaque patch of the row's own surface.
    private var rowActions: some View {
        HStack(spacing: 0) {
            TierMenu(
                item: item, onSetTier: actions.onSetTier,
                onPinSender: actions.onPinSender, onUnpinSender: actions.onUnpinSender
            ) {
                Image(systemName: "arrow.left.arrow.right").iconTarget()
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .help(L("mail.changeTier"))
            .accessibilityLabel(L("mail.changeTier.a11y", a11ySenderLabel(item), item.tier.label))
            SnoozeMenu(item: item, onSnooze: actions.onSnooze) {
                Image(systemName: "moon.zzz").iconTarget()
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .help(L("mail.snooze"))
            .accessibilityLabel(L("mail.snooze.a11y", a11ySenderLabel(item)))
            Button { actions.onDismiss(item) } label: { Image(systemName: "xmark").iconTarget() }
                .buttonStyle(.plain).help(L("mail.dismiss"))
                .accessibilityLabel(L("mail.dismiss.a11y", a11ySenderLabel(item)))
        }
        .font(Theme.Typo.icon)
        .foregroundStyle(Theme.textDim)
        .padding(.horizontal, Theme.s1)
        .background {
            ZStack {
                Theme.bg
                selected ? Theme.surfaceSelected : Theme.surfaceHover
            }
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .padding(.trailing, Theme.s3)
    }
}

/// A whole-mailbox search hit in the main window. Search rows know their
/// read state and their account, so the dot and the monogram show here.
struct WindowSearchHitRow: View {
    @Environment(AppModel.self) private var model
    let hit: EmailSearchItem
    @State private var hovering = false

    private var selected: Bool { model.selectedItemId == hit.id }

    var body: some View {
        let content = WindowRowRules.content(for: hit, inboxes: model.inboxes, now: Date())
        Button { Task { await model.selectSearchResult(hit) } } label: {
            WindowRowBody(content: content)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            (content.unread == true ? L("mail.unread") + ", " : "")
                + L("mail.searchResult.a11y", content.sender, content.subject))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .modifier(WindowRowChrome(selected: selected, hovering: hovering, focused: false))
        .onHover { hovering = $0 }
    }
}
