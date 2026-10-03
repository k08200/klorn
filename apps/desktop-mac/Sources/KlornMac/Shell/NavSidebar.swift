import SwiftUI

/// The main window's sidebar (M4b): the navigation items, Mail's secondary
/// facets while Mail is open, the connected accounts with their health, and
/// Settings at the foot. One unified list across accounts, so the accounts
/// group reports and never switches (FD-2).
struct NavSidebar: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            OffscreenFriendlyScroll {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(NavSection.allCases) { section in
                        sectionRow(section)
                        if section == .mail, model.mainNav.section == .mail {
                            MailFacetRows()
                        }
                    }
                    NavGroupHeader(title: L("nav.accounts"))
                        .padding(.top, Theme.s4)
                    AccountRows(actions: actions)
                }
                .padding(.horizontal, Theme.s2).padding(.top, Theme.s3).padding(.bottom, Theme.s2)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .frame(maxHeight: .infinity, alignment: .top)
            Rectangle().fill(Theme.line).frame(height: 1)
            footer
        }
        .frame(width: NavRules.sidebarWidth)
    }

    private func sectionRow(_ section: NavSection) -> some View {
        let selected = model.mainNav.section == section
        return Button { model.navigate(to: section) } label: {
            NavRowLabel(
                icon: section.icon, title: section.title, count: count(for: section),
                selected: selected)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(section.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// Mail counts what its lanes can show; Assistant counts what waits on
    /// the user. Today and Calendar carry no number.
    private func count(for section: NavSection) -> Int? {
        switch section {
        case .mail:
            guard let summary = model.queue?.summary else { return nil }
            let count = NavRules.mailCount(summary.count(for:))
            return count > 0 ? count : nil
        case .assistant:
            return model.pendingActions.isEmpty ? nil : model.pendingActions.count
        case .today, .calendar:
            return nil
        }
    }

    private var footer: some View {
        HStack(spacing: Theme.s1) {
            Button(action: actions.onOpenPreferences) {
                HStack(spacing: Theme.s2) {
                    Image(systemName: "gearshape").font(Theme.Typo.icon).accessibilityHidden(true)
                    Text(L("prefs.title")).font(Theme.Typo.body)
                    Spacer(minLength: 0)
                }
                .frame(height: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).hoverDim()
            .accessibilityLabel(L("prefs.title"))
            // The compact panel is still one click away from the window.
            Button(action: actions.onRestore) {
                Image(systemName: "arrow.down.right.and.arrow.up.left")
                    .font(Theme.Typo.icon).iconTarget()
            }
            .buttonStyle(.plain).hoverDim()
            .help(L("bar.smaller.help"))
            .accessibilityLabel(L("bar.smaller"))
        }
        .padding(.horizontal, Theme.s4).padding(.vertical, Theme.s2)
    }
}

/// A sidebar row: icon, title, optional count. Same selection language as
/// the mail list (accent bar plus the selected rung).
struct NavRowLabel: View {
    let icon: String
    let title: String
    var count: Int? = nil
    let selected: Bool
    var indented = false
    @State private var hovering = false

    var body: some View {
        HStack(spacing: Theme.s2) {
            Image(systemName: icon)
                .font(Theme.Typo.icon)
                .foregroundStyle(selected ? Theme.text : Theme.textDim)
                .frame(width: 20)
                .accessibilityHidden(true)
            Text(title)
                .font(indented ? Theme.Typo.body : Theme.Typo.body.weight(selected ? .semibold : .regular))
                .foregroundStyle(Theme.text)
                .lineLimit(1)
            Spacer(minLength: Theme.s1)
            if let count {
                Text("\(count)")
                    .font(Theme.Typo.caption.monospacedDigit())
                    .foregroundStyle(Theme.textDim)
            }
        }
        .padding(.leading, indented ? Theme.s6 : Theme.s2).padding(.trailing, Theme.s3)
        .frame(height: indented ? 28 : 32)
        .background(alignment: .leading) {
            if selected {
                RoundedRectangle(cornerRadius: 1.5).fill(Theme.accent)
                    .frame(width: 3).padding(.vertical, 7)
            }
        }
        .background(
            selected ? Theme.surfaceSelected : hovering ? Theme.surfaceHover : .clear,
            in: RoundedRectangle(cornerRadius: Theme.Radius.sm))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

/// Group label in the sidebar: 11pt caption, never the retired 10pt micro.
struct NavGroupHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(Theme.Typo.caption.weight(.semibold))
            .foregroundStyle(Theme.textDim)
            .padding(.horizontal, Theme.s2).padding(.bottom, Theme.s1)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Mail's secondary facets: the folders, then the labels that hold mail.
/// Lanes are the primary filter and live above the list, not here.
private struct MailFacetRows: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        facet(.waitingOn, icon: "clock.arrow.circlepath", title: L("waiting.title"),
              count: model.waitingOn.isEmpty ? nil : model.waitingOn.count)
        ForEach(MailboxKind.allCases) { box in
            facet(.mailbox(box), icon: box.icon, title: box.label,
                  count: model.mailboxItems[box]?.count)
        }
        ForEach(LabelFilter.allCases) { filter in
            let count = model.queue?.items(matching: filter).count ?? 0
            if count > 0 || model.listMode == .label(filter) {
                facet(.label(filter), icon: filter.icon, title: filter.label, count: count)
            }
        }
    }

    private func facet(_ mode: ListMode, icon: String, title: String, count: Int?) -> some View {
        let selected = model.listMode == mode
        return Button { model.go(to: mode) } label: {
            NavRowLabel(icon: icon, title: title, count: count, selected: selected, indented: true)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Connected inboxes with a health dot. The state is always a word too
/// (tooltip, VoiceOver, and a visible line when it needs the user).
private struct AccountRows: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    var body: some View {
        if model.phase != .signedIn {
            Text(L("nav.accounts.signedOut"))
                .font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Theme.s2)
        } else if model.inboxes.isEmpty {
            Text(L("nav.accounts.none"))
                .font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                .padding(.horizontal, Theme.s2)
        } else {
            ForEach(model.inboxes) { inbox in
                Button(action: actions.onOpenPreferences) { row(inbox) }
                    .buttonStyle(.plain)
                    .help(status(inbox))
                    .accessibilityLabel(
                        "\(inboxDisplayLabel(email: inbox.email, kind: inbox.kind)). \(status(inbox))")
            }
        }
    }

    private func status(_ inbox: InboxOption) -> String {
        inbox.needsReconnect ? L("nav.accounts.needsReconnect") : L("nav.accounts.connected")
    }

    private func row(_ inbox: InboxOption) -> some View {
        HStack(spacing: Theme.s2) {
            SourceBadge(provider: inbox.provider)
            VStack(alignment: .leading, spacing: 1) {
                Text(inboxDisplayLabel(email: inbox.email, kind: inbox.kind))
                    .font(Theme.Typo.label).foregroundStyle(Theme.text)
                    .lineLimit(1).truncationMode(.middle)
                if inbox.needsReconnect {
                    Text(L("nav.accounts.needsReconnect"))
                        .font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: Theme.s1)
            Circle()
                .fill(inbox.needsReconnect ? Theme.warning : Theme.success)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, Theme.s2)
        .frame(minHeight: 32)
        .contentShape(Rectangle())
    }
}
