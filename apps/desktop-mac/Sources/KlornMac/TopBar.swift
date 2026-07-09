import SwiftUI

/// The three sizes the bar can take: a glanceable pill, the compact 3-column
/// panel, and a full "real app" window.
enum BarState { case collapsed, expanded, full }

/// Actions the top bar delegates back to the controller / model.
struct TopBarActions {
    let onExpand: () -> Void        // collapsed → expanded
    let onExpandFull: () -> Void    // expanded → full
    let onRestore: () -> Void       // full → expanded
    let onCollapse: () -> Void      // → collapsed
    let onSignIn: () -> Void
    let onSignOut: () -> Void
    /// Open an item on the web inbox; nil opens the inbox root.
    let onOpenWeb: (FirewallItem?) -> Void
    /// Open an item IN-APP: jump to the full view and show it in the reading pane.
    let onOpenInApp: (FirewallItem) -> Void
    /// Dismiss (archive) an item out of the queue.
    let onDismiss: (FirewallItem) -> Void
    /// Snooze an item to resurface tomorrow morning.
    let onSnooze: (FirewallItem) -> Void
    /// Select a row in the full view — loads its email into the reading pane.
    let onSelect: (FirewallItem) -> Void
    let onQuit: () -> Void
}

enum TopBarMetrics {
    static let collapsed = NSSize(width: 400, height: 52)
    static let expanded = NSSize(width: 900, height: 380)
    static let full = NSSize(width: 1400, height: 860)
    static let corner: CGFloat = 16

    static func size(for state: BarState) -> NSSize {
        switch state {
        case .collapsed: collapsed
        case .expanded: expanded
        case .full: full
        }
    }
}

/// Root that switches between the three states. The controller animates the
/// window frame; this just renders the right content.
struct TopBarRoot: View {
    let state: BarState
    let actions: TopBarActions

    var body: some View {
        Group {
            switch state {
            case .collapsed: CollapsedBar(actions: actions)
            case .expanded: ExpandedPanel(actions: actions)
            case .full: FullView(actions: actions)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: TopBarMetrics.corner)
                .fill(Theme.panel)
                .overlay(RoundedRectangle(cornerRadius: TopBarMetrics.corner).strokeBorder(Theme.line))
        )
        .clipShape(RoundedRectangle(cornerRadius: TopBarMetrics.corner))
    }
}

/// Klorn wordmark ring — the small circular logo from the reference bar.
private struct LogoRing: View {
    var size: CGFloat = 16
    var body: some View {
        Circle().strokeBorder(Theme.accent, lineWidth: 2).frame(width: size, height: size)
    }
}

private struct ColumnHeader: View {
    let title: String
    var body: some View {
        Text(title).font(.caption2.weight(.semibold))
            .foregroundStyle(Theme.textDim).tracking(0.6)
    }
}

// MARK: - Collapsed

/// Collapsed pill: always visible at the top, glanceable state.
struct CollapsedBar: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    private var pushCount: Int { model.queue?.summary.push ?? 0 }

    var body: some View {
        HStack(spacing: 12) {
            Button(action: actions.onExpand) {
                Image(systemName: "line.3.horizontal").font(.body.weight(.medium))
            }
            .buttonStyle(.plain).foregroundStyle(Theme.text)
            .help("Expand")

            LogoRing()
            Text("Klorn").font(.callout.weight(.semibold)).foregroundStyle(Theme.text)

            Spacer()

            switch model.phase {
            case .signedIn:
                if pushCount > 0 {
                    HStack(spacing: 5) {
                        Circle().fill(Theme.tint(.push)).frame(width: 7, height: 7)
                        Text("\(pushCount) PUSH")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(Theme.text)
                    }
                } else if model.loadError != nil {
                    Text("offline").font(.caption).foregroundStyle(Theme.textDim)
                } else {
                    Text("All clear").font(.caption).foregroundStyle(Theme.textDim)
                }
            case .signingIn:
                Text("Signing in…").font(.caption).foregroundStyle(Theme.textDim)
            case .signedOut:
                Button("Log In", action: actions.onSignIn)
                    .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
            }
        }
        .padding(.horizontal, 16)
        .frame(width: TopBarMetrics.collapsed.width, height: TopBarMetrics.collapsed.height)
    }
}

// MARK: - Expanded (3 columns)

/// Expanded panel: header + 3 columns (INBOX / RECENT PUSH / ACCOUNT).
struct ExpandedPanel: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Theme.line)
            HStack(alignment: .top, spacing: 0) {
                InboxColumn(actions: actions)
                columnDivider
                RecentPushColumn(actions: actions)
                columnDivider
                AccountColumn(actions: actions)
            }
        }
        .frame(width: TopBarMetrics.expanded.width, height: TopBarMetrics.expanded.height)
    }

    private var header: some View {
        HStack {
            Button(action: actions.onCollapse) {
                HStack(spacing: 6) {
                    Image(systemName: "minus").font(.caption.weight(.bold))
                    Text("Close").font(.callout)
                }
            }
            .buttonStyle(.plain).foregroundStyle(Theme.textDim)

            Spacer()
            HStack(spacing: 8) { LogoRing(); Text("Klorn").font(.callout.weight(.semibold)).foregroundStyle(Theme.text) }
            Spacer()

            HStack(spacing: 14) {
                Button(action: actions.onExpandFull) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right").font(.callout)
                }
                .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                .help("Full view")

                if model.phase == .signedIn {
                    Button("Sign Out", action: actions.onSignOut)
                        .buttonStyle(.bordered).controlSize(.small)
                } else if model.phase == .signedOut {
                    Button("Log In", action: actions.onSignIn)
                        .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
                }
            }
        }
        .padding(.horizontal, 18).frame(height: 56)
    }

    private var columnDivider: some View {
        Rectangle().fill(Theme.line).frame(width: 1).padding(.vertical, 14)
    }
}

/// Column 1 — per-tier open counts; click opens the web inbox.
private struct InboxColumn: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ColumnHeader(title: "INBOX")
            ForEach(Tier.displayOrder) { tier in
                Button { actions.onOpenWeb(nil) } label: {
                    HStack(spacing: 8) {
                        Circle().fill(Theme.tint(tier)).frame(width: 7, height: 7)
                        Text(tier.label).font(.body).foregroundStyle(Theme.text)
                        Spacer()
                        Text("\(model.queue?.summary.count(for: tier) ?? 0)")
                            .font(.body.monospacedDigit().weight(.medium))
                            .foregroundStyle(Theme.textDim)
                    }
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Column 2 — the recent PUSH items; click opens that item.
private struct RecentPushColumn: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    private var items: [FirewallItem] { model.queue?.items(for: .push) ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ColumnHeader(title: "RECENT PUSH")
            if items.isEmpty {
                Text("Nothing needs you right now.")
                    .font(.callout).foregroundStyle(Theme.textDim)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(items) { item in
                            HStack(spacing: 10) {
                                Button { actions.onOpenInApp(item) } label: { pushRow(item) }
                                    .buttonStyle(.plain)
                                Button { actions.onSnooze(item) } label: {
                                    Image(systemName: "moon.zzz").font(.caption2)
                                }
                                .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                                .help("Snooze to tomorrow 9am")
                                Button { actions.onDismiss(item) } label: {
                                    Image(systemName: "xmark").font(.caption2)
                                }
                                .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                                .help("Dismiss")
                            }
                        }
                    }
                }
            }
            Spacer()
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func pushRow(_ item: FirewallItem) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.email?.from ?? item.title).font(.callout.weight(.semibold))
                .foregroundStyle(Theme.text).lineLimit(1)
            Text(item.email?.subject ?? item.title).font(.caption)
                .foregroundStyle(Theme.textDim).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Column 3 — account + resources.
private struct AccountColumn: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ColumnHeader(title: "ACCOUNT")
            if model.phase == .signedIn {
                Button { actions.onOpenWeb(nil) } label: {
                    Text("Open web inbox").font(.body).foregroundStyle(Theme.text)
                }.buttonStyle(.plain)
                Button(action: actions.onSignOut) {
                    Text("Sign out").font(.body).foregroundStyle(Theme.text)
                }.buttonStyle(.plain)
            } else {
                Button(action: actions.onSignIn) {
                    Text("Sign in with Google").font(.body).foregroundStyle(Theme.text)
                }.buttonStyle(.plain)
            }
            Button(action: actions.onQuit) {
                Text("Quit Klorn").font(.body).foregroundStyle(Theme.textDim)
            }.buttonStyle(.plain)
            Spacer()
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Full ("real app" window)

/// The largest state: a tier sidebar + a big scrollable list of the selected
/// tier — a real desktop-app view of the whole firewall.
struct FullView: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions
    @State private var tier: Tier = .push

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Theme.line)
            HStack(spacing: 0) {
                FullSidebar(selected: $tier, actions: actions).frame(width: 220)
                Rectangle().fill(Theme.line).frame(width: 1)
                FullList(tier: tier, actions: actions).frame(width: 420)
                Rectangle().fill(Theme.line).frame(width: 1)
                ReadingPane(actions: actions).frame(maxWidth: .infinity)
            }
        }
        .frame(width: TopBarMetrics.full.width, height: TopBarMetrics.full.height)
    }

    private var header: some View {
        HStack(spacing: 14) {
            Button(action: actions.onRestore) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.down.right.and.arrow.up.left").font(.callout)
                    Text("Smaller").font(.callout)
                }
            }
            .buttonStyle(.plain).foregroundStyle(Theme.textDim)
            .help("Back to the compact panel")

            Button(action: actions.onCollapse) {
                Image(systemName: "minus").font(.callout.weight(.bold))
            }
            .buttonStyle(.plain).foregroundStyle(Theme.textDim)
            .help("Collapse to the pill")

            Spacer()
            HStack(spacing: 8) {
                LogoRing(size: 20)
                Text("Klorn").font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
            }
            Spacer()

            if model.phase == .signedIn {
                Button("Sign Out", action: actions.onSignOut).buttonStyle(.bordered).controlSize(.small)
            } else if model.phase == .signedOut {
                Button("Log In", action: actions.onSignIn)
                    .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
            }
        }
        .padding(.horizontal, 22).frame(height: 64)
    }
}

private struct FullSidebar: View {
    @Environment(AppModel.self) private var model
    @Binding var selected: Tier
    let actions: TopBarActions

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ColumnHeader(title: "INBOX").padding(.horizontal, 20).padding(.bottom, 6)
            ForEach(Tier.displayOrder) { tier in
                Button { selected = tier } label: {
                    HStack(spacing: 10) {
                        Circle().fill(Theme.tint(tier)).frame(width: 8, height: 8)
                        Text(tier.label).font(.body.weight(selected == tier ? .semibold : .regular))
                            .foregroundStyle(Theme.text)
                        Spacer()
                        Text("\(model.queue?.summary.count(for: tier) ?? 0)")
                            .font(.body.monospacedDigit()).foregroundStyle(Theme.textDim)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(selected == tier ? Color.white.opacity(0.07) : .clear,
                                in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
            }

            Spacer()

            ColumnHeader(title: "ACCOUNT").padding(.horizontal, 20).padding(.bottom, 6)
            if model.phase == .signedIn {
                sidebarAction("Open web inbox") { actions.onOpenWeb(nil) }
                sidebarAction("Sign out", dim: true) { actions.onSignOut() }
            } else {
                sidebarAction("Sign in with Google") { actions.onSignIn() }
            }
            sidebarAction("Quit Klorn", dim: true) { actions.onQuit() }
        }
        .padding(.horizontal, 8).padding(.vertical, 18)
    }

    private func sidebarAction(_ title: String, dim: Bool = false, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(title).font(.body).foregroundStyle(dim ? Theme.textDim : Theme.text)
                .padding(.horizontal, 12).padding(.vertical, 5)
                .frame(maxWidth: .infinity, alignment: .leading)
        }.buttonStyle(.plain)
    }
}

private struct FullList: View {
    @Environment(AppModel.self) private var model
    let tier: Tier
    let actions: TopBarActions

    private var items: [FirewallItem] { model.queue?.items(for: tier) ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Circle().fill(Theme.tint(tier)).frame(width: 9, height: 9)
                Text(tier.label).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                Text("\(items.count)").font(.title3.monospacedDigit()).foregroundStyle(Theme.textDim)
            }
            .padding(.horizontal, 24).padding(.vertical, 18)
            Divider().overlay(Theme.line)

            if items.isEmpty {
                Spacer()
                Text("Nothing in \(tier.label).").font(.title3).foregroundStyle(Theme.textDim)
                    .frame(maxWidth: .infinity)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(items) { item in
                            FullRow(item: item, actions: actions)
                            Divider().overlay(Theme.line).padding(.leading, 24)
                        }
                    }
                }
            }
        }
    }
}

private struct FullRow: View {
    @Environment(AppModel.self) private var model
    let item: FirewallItem
    let actions: TopBarActions

    private var selected: Bool { model.selectedItemId == item.id }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(item.email?.from ?? item.title).font(.body.weight(.semibold))
                    .foregroundStyle(Theme.text).lineLimit(1)
                Text(item.email?.subject ?? item.title).font(.callout)
                    .foregroundStyle(Theme.text.opacity(0.85)).lineLimit(1)
                if let reason = item.tierReason, !reason.isEmpty {
                    Text(reason).font(.caption).foregroundStyle(Theme.textDim).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Button { actions.onSnooze(item) } label: { Image(systemName: "moon.zzz") }
                .buttonStyle(.plain).foregroundStyle(Theme.textDim).help("Snooze to tomorrow 9am")
            Button { actions.onDismiss(item) } label: { Image(systemName: "xmark") }
                .buttonStyle(.plain).foregroundStyle(Theme.textDim).help("Dismiss")
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .background(selected ? Color.white.opacity(0.08) : .clear)
        .contentShape(Rectangle())
        .onTapGesture { actions.onSelect(item) }
    }
}

/// The reading pane: the selected email's content, loaded from GET /api/email/:id.
/// Clicking a row (a plain mouse click, delivered even to the non-focus-stealing
/// panel) loads it here — no need to leave the app for the browser.
private struct ReadingPane: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions
    @State private var replying = false
    @State private var replyText = ""
    @State private var sending = false

    private var item: FirewallItem? {
        guard let id = model.selectedItemId else { return nil }
        return model.queue?.item(id: id)
    }

    var body: some View {
        Group {
            if model.isLoadingEmail {
                centered { ProgressView().controlSize(.small) }
            } else if let err = model.emailError {
                centered { Text(err).font(.callout).foregroundStyle(Theme.textDim) }
            } else if let email = model.openedEmail {
                content(email)
            } else if model.selectedItemId != nil {
                centered { Text("No preview for this item.").font(.callout).foregroundStyle(Theme.textDim) }
            } else {
                centered { Text("Select a message to read it here.").font(.title3).foregroundStyle(Theme.textDim) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onChange(of: model.selectedItemId) { _, _ in replying = false; replyText = "" }
    }

    private func content(_ email: EmailDetail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text(email.subject ?? "(no subject)").font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.text).lineLimit(2)
                HStack {
                    Text(email.from ?? "").font(.callout).foregroundStyle(Theme.textDim).lineLimit(1)
                    Spacer()
                    Text(Self.formatDate(email.date)).font(.caption).foregroundStyle(Theme.textDim)
                }
                if let item {
                    HStack(spacing: 10) {
                        Button("Reply with AI") { startReply(item) }
                            .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
                        Button("Open in web") { actions.onOpenWeb(item) }
                            .buttonStyle(.bordered).controlSize(.small)
                        Button("Snooze") { actions.onSnooze(item) }
                            .buttonStyle(.bordered).controlSize(.small)
                        Button("Dismiss") { actions.onDismiss(item) }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                    .padding(.top, 2)
                }
            }
            .padding(24)
            Divider().overlay(Theme.line)
            klornBand(email)
            ScrollView {
                Text(email.text.isEmpty ? "(no content)" : email.text)
                    .font(.callout)
                    .foregroundStyle(Theme.text.opacity(0.92))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(24)
            }
            if replying, let item {
                Divider().overlay(Theme.line)
                replyComposer(item)
            }
        }
    }

    private func replyComposer(_ item: FirewallItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Reply to \(item.email?.from ?? "")")
                    .font(.caption).foregroundStyle(Theme.textDim).lineLimit(1)
                Spacer()
                if model.isDrafting {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini)
                        Text("Klorn is drafting…").font(.caption).foregroundStyle(Theme.textDim)
                    }
                } else {
                    Button { Task { if let d = await model.draftReply(item) { replyText = d } } } label: {
                        Label("Regenerate", systemImage: "sparkles").font(.caption)
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.accent)
                    .help("Ask Klorn to rewrite the draft")
                }
            }
            TextEditor(text: $replyText)
                .font(.callout).foregroundStyle(Theme.text)
                .scrollContentBackground(.hidden)
                .frame(height: 110)
                .padding(8)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.line))
            if let err = model.replyError {
                Text(err).font(.caption).foregroundStyle(.orange)
            }
            HStack {
                Spacer()
                Button("Cancel") { replying = false; replyText = "" }
                    .buttonStyle(.bordered).controlSize(.small)
                Button(sending ? "Sending…" : "Send") { send(item) }
                    .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
                    .disabled(sending || model.isDrafting || replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(16)
    }

    /// Klorn's per-email intelligence: why it landed in this tier, the AI summary,
    /// and whether it needs a reply. Hidden when there's nothing to show.
    @ViewBuilder
    private func klornBand(_ email: EmailDetail) -> some View {
        let reason = item?.tierReason
        let hasEngagement = (email.engagement?.outboundCount ?? 0) > 0
        let show = (reason?.isEmpty == false) || (email.summary?.isEmpty == false) || (email.needsReply == true) || hasEngagement
        if show {
            VStack(alignment: .leading, spacing: 6) {
                if let item, let reason, !reason.isEmpty {
                    HStack(spacing: 6) {
                        Circle().fill(Theme.tint(item.tier)).frame(width: 7, height: 7)
                        Text("Why \(item.tier.label) · \(reason)")
                            .font(.caption).foregroundStyle(Theme.textDim).lineLimit(2)
                    }
                }
                if let summary = email.summary, !summary.isEmpty {
                    Text(summary).font(.callout).foregroundStyle(Theme.text.opacity(0.9))
                }
                if email.needsReply == true {
                    HStack(spacing: 5) {
                        Image(systemName: "arrowshape.turn.up.left").font(.caption2)
                        Text((email.needsReplyReason?.isEmpty == false) ? email.needsReplyReason! : "Needs a reply")
                            .font(.caption)
                    }
                    .foregroundStyle(Theme.accent)
                }
                if let engagement = email.engagement, engagement.outboundCount > 0 {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.turn.up.left").font(.caption2)
                        Text(engagementLabel(engagement.outboundCount))
                            .font(.caption)
                    }
                    // Warm tint mirrors the web graph's "you engage" pink — the
                    // signal Klorn learned from the user's own replies.
                    .foregroundStyle(Color(red: 0.96, green: 0.45, blue: 0.71))
                }
            }
            .padding(.horizontal, 24).padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.white.opacity(0.04))
            Divider().overlay(Theme.line)
        }
    }

    /// "You've replied to this sender once / N times" — Klorn learned this sender
    /// matters from the user's own outbound replies. Singular-aware.
    private func engagementLabel(_ count: Int) -> String {
        let times = count == 1 ? "once" : "\(count) times"
        return "You engage with this sender · replied \(times)"
    }

    /// Open the composer and let Klorn's AI draft the reply into it. The user
    /// reviews/edits before Send (approval before action).
    private func startReply(_ item: FirewallItem) {
        replying = true
        replyText = ""
        Task {
            if let draft = await model.draftReply(item) { replyText = draft }
        }
    }

    private func send(_ item: FirewallItem) {
        sending = true
        Task {
            let ok = await model.reply(item, body: replyText)
            sending = false
            if ok { replying = false; replyText = "" }
        }
    }

    private func centered<Content: View>(@ViewBuilder _ c: () -> Content) -> some View {
        VStack { Spacer(); c(); Spacer() }.frame(maxWidth: .infinity)
    }

    private static func formatDate(_ iso: String?) -> String {
        guard let iso else { return "" }
        let iso1 = ISO8601DateFormatter(); iso1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let iso2 = ISO8601DateFormatter(); iso2.formatOptions = [.withInternetDateTime]
        guard let date = iso1.date(from: iso) ?? iso2.date(from: iso) else { return "" }
        let out = DateFormatter(); out.dateFormat = "MMM d · h:mm a"
        return out.string(from: date)
    }
}
