import SwiftUI

/// Per-inbox scope selector (web parity: email/page.tsx InboxSelector) —
/// rendered only when the account actually has 2+ mailboxes. Values: "all",
/// "primary", or a linked inbox id; addresses come straight from the API,
/// never hardcoded. Selecting re-scopes the mail list end-to-end.
struct InboxSelectorMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.inboxes.count < 2,
           model.inboxes.contains(where: { $0.kind == "primary" && $0.needsReconnect }) {
            // Solo-account case: no selector renders, but a dead PRIMARY
            // token still needs a way back — this is the most common trigger
            // (2026-08-10 review). Same flow as the menu's primary button.
            Button(L("account.reconnectPrimary")) { Task { await model.reconnectPrimary() } }
                .buttonStyle(.plain)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.accentDeep)
                .help(L("account.reconnectPrimary"))
        }
        if model.inboxes.count >= 2 {
            let current = inboxSelectorLabel(selected: model.selectedInbox, inboxes: model.inboxes)
            Menu {
                row(value: "all", label: L("mail.allInboxes"), needsReconnect: false)
                ForEach(model.inboxes) { inbox in
                    row(value: inbox.selectionValue,
                        label: inboxDisplayLabel(email: inbox.email, kind: inbox.kind),
                        needsReconnect: inbox.needsReconnect)
                }
                if model.inboxes.contains(where: \.needsReconnect) {
                    Divider()
                    // The PRIMARY account reconnects through the full-scope
                    // /google/start consent — the link-inbox flow would add a
                    // Pro-gated SECOND account instead of fixing the first
                    // (2026-08-10 diagnosis). Linked rows keep link-inbox.
                    if model.inboxes.contains(where: { $0.needsReconnect && $0.kind == "primary" }) {
                        Button(L("account.reconnectPrimary")) {
                            Task { await model.reconnectPrimary() }
                        }
                    }
                    if model.inboxes.contains(where: { $0.needsReconnect && $0.kind != "primary" }) {
                        Button(L("account.reconnect")) { Task { await model.addAccount() } }
                    }
                }
            } label: {
                // Chevron lives INSIDE the one Text (concatenation) — a
                // separate Image in a menu label is reordered to the leading
                // edge by the label styling (screen-verified 0.4.80007).
                (Text(current + " ")
                    + Text(Image(systemName: "chevron.down"))
                    .font(.caption2.weight(.semibold)))
                    .font(.caption)
                    .foregroundStyle(Theme.textDim)
                    .lineLimit(1)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .help(L("mail.filterByInbox"))
            .accessibilityLabel(L("mail.filterByInbox.a11y", current))
        }
    }

    private func row(value: String, label: String, needsReconnect: Bool) -> some View {
        Button {
            model.selectInbox(value)
        } label: {
            HStack {
                // Text suffix, not the web's sky dot: the AppKit borderless
                // menu drops SwiftUI shapes and renders symbols colorless
                // (see the tier-dot note on FullRow) — words keep the
                // reconnect signal perceivable, and color-independent.
                Text(needsReconnect ? L("mail.needsReconnect", label) : label)
                if value == model.selectedInbox { Image(systemName: "checkmark") }
            }
        }
    }
}

struct MailboxList: View {
    @Environment(AppModel.self) private var model
    let box: MailboxKind

    private var items: [MailboxItem] { model.mailboxItems[box] ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: box.icon).font(.body).foregroundStyle(Theme.textDim)
                    .accessibilityHidden(true)
                Text(box.label).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                Text("\(items.count)").font(.title3.monospacedDigit()).foregroundStyle(Theme.textDim)
                Spacer()
                Button {
                    model.openMailbox(box)
                } label: {
                    Image(systemName: "arrow.clockwise").font(.callout.weight(.medium))
                        .iconTarget(30)
                }
                .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                .help(L("mailbox.refresh"))
                .accessibilityLabel(L("mailbox.refresh"))
            }
            .padding(.horizontal, 24).padding(.vertical, 18)

            Divider().overlay(Theme.line)

            if model.mailboxLoading == box && items.isEmpty {
                FirstSyncState()
                Spacer()
            } else if let error = model.mailboxError, items.isEmpty {
                Spacer()
                EmptyState(icon: "wifi.exclamationmark", title: error)
                Spacer()
            } else if items.isEmpty {
                Spacer()
                EmptyState(icon: box.icon, title: L("mailbox.empty.\(box.rawValue)"))
                Spacer()
            } else if Theme.isRenderingOffscreen {
                VStack(spacing: 0) {
                    ForEach(items.prefix(8)) { item in
                        MailboxRow(box: box, item: item)
                        Divider().overlay(Theme.line).padding(.leading, 20)
                    }
                }
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(items) { item in
                            MailboxRow(box: box, item: item)
                            Divider().overlay(Theme.line).padding(.leading, 20)
                        }
                        if model.mailboxNextToken[box] != nil {
                            Button {
                                Task { await model.loadMoreMailbox(box) }
                            } label: {
                                HStack(spacing: 6) {
                                    if model.mailboxLoading == box {
                                        ProgressView().controlSize(.small)
                                    }
                                    Text(L("mailbox.loadMore"))
                                        .font(Theme.Typo.label)
                                        .foregroundStyle(Theme.textDim)
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(model.mailboxLoading == box)
                            .accessibilityLabel(L("mailbox.loadMore"))
                        }
                    }
                }
            }
        }
        .task(id: box) {
            // Fetch on entry, and refresh a stale listing on re-entry. The
            // cached rows stay on screen while the refresh runs.
            await model.loadMailbox(box)
        }
    }
}

struct MailboxRow: View {
    @Environment(AppModel.self) private var model
    let box: MailboxKind
    let item: MailboxItem
    @State private var hovering = false
    @FocusState private var focused: Bool

    private var selected: Bool { model.selectedMailboxItem?.gmailId == item.gmailId }
    /// Sent/Drafts rows identify by who they're TO — "me, me, me" in the
    /// sender column is what every client avoids for these two folders.
    private var counterparty: String {
        let raw = box == .archived ? item.from : item.to
        let name = senderDisplayName(decodeHTMLEntities(raw))
        return name.isEmpty ? raw : name
    }

    var body: some View {
        Button {
            // A draft opens into the EDITOR, like every mail client; the
            // other folders open into the reading pane.
            if box == .drafts {
                model.openDraftForEditing(item)
            } else {
                model.selectMailboxItem(item)
            }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(counterparty).font(Theme.Typo.label)
                            .foregroundStyle(Theme.textDim).lineLimit(1)
                        // Which account the row came from — only meaningful
                        // with 2+ inboxes (inboxRowBadge stays quiet otherwise).
                        if let badge = inboxRowBadge(
                            linkedId: item.inbox == "primary" ? nil : item.inbox,
                            inboxes: model.inboxes)
                        {
                            Text(badge).font(.caption2).foregroundStyle(Theme.textDim)
                                .lineLimit(1)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Theme.surfaceRaised, in: Capsule())
                                .accessibilityLabel(L("mail.inbox.a11y", badge))
                        }
                    }
                    Text(decodeHTMLEntities(item.subject.isEmpty
                        ? L("mailbox.noSubject") : item.subject))
                        .font(Theme.Typo.head)
                        .foregroundStyle(Theme.text).lineLimit(1)
                    if !item.snippet.isEmpty {
                        Text(decodeHTMLEntities(item.snippet)).font(Theme.Typo.caption)
                            .foregroundStyle(Theme.textDim).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                let time = mailTimeLabel(iso: item.receivedAt, now: Date())
                if !time.isEmpty {
                    Text(time)
                        .font(Theme.Typo.caption.monospacedDigit())
                        .foregroundStyle(Theme.textDim)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focused($focused)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityLabel("\(counterparty). \(item.subject)")
        .padding(.horizontal, 20).padding(.vertical, 11)
        .background(alignment: .leading) {
            if selected { Rectangle().fill(Theme.accent).frame(width: 3) }
        }
        .background(selected ? Theme.surfaceSelected : hovering ? Theme.surfaceHover : .clear)
        .onHover { hovering = $0 }
        .overlay {
            if focused {
                RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.accent, lineWidth: 2)
            }
        }
    }
}
