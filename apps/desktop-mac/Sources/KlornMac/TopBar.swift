import SwiftUI

/// Actions the top bar delegates back to the controller / model.
struct TopBarActions {
    let onExpand: () -> Void
    let onCollapse: () -> Void
    let onSignIn: () -> Void
    let onSignOut: () -> Void
    /// Open an item on the web inbox; nil opens the inbox root.
    let onOpenWeb: (FirewallItem?) -> Void
    let onQuit: () -> Void
}

enum TopBarMetrics {
    static let collapsed = NSSize(width: 400, height: 52)
    static let expanded = NSSize(width: 900, height: 380)
    static let corner: CGFloat = 16
}

/// Root that switches between the two states. The controller animates the
/// window frame; this just renders the right content.
struct TopBarRoot: View {
    let expanded: Bool
    let actions: TopBarActions

    var body: some View {
        Group {
            if expanded { ExpandedPanel(actions: actions) }
            else { CollapsedBar(actions: actions) }
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
    var body: some View {
        Circle().strokeBorder(Theme.accent, lineWidth: 2).frame(width: 16, height: 16)
    }
}

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

            if model.phase == .signedIn {
                Button("Sign Out", action: actions.onSignOut)
                    .buttonStyle(.bordered).controlSize(.small)
            } else if model.phase == .signedOut {
                Button("Log In", action: actions.onSignIn)
                    .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
            }
        }
        .padding(.horizontal, 18).frame(height: 56)
    }

    private var columnDivider: some View {
        Rectangle().fill(Theme.line).frame(width: 1).padding(.vertical, 14)
    }
}

private struct ColumnHeader: View {
    let title: String
    var body: some View {
        Text(title).font(.caption2.weight(.semibold))
            .foregroundStyle(Theme.textDim).tracking(0.6)
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
                            Button { actions.onOpenWeb(item) } label: { pushRow(item) }
                                .buttonStyle(.plain)
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
