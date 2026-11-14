import SwiftUI

/// The main window's sidebar (M4b): the navigation items, Mail's secondary
/// facets while Mail is open, the connected accounts with their health, and
/// Settings at the foot. One unified list across accounts, so the accounts
/// group reports and never switches (FD-2).
struct NavSidebar: View {
    @Environment(AppModel.self) private var model
    let actions: ShellActions

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            OffscreenFriendlyScroll {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(FilesRules.sections(files: model.clientFlags.files)) { section in
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
            footer
        }
        .frame(width: NavRules.sidebarWidth)
    }

    private func sectionRow(_ section: NavSection) -> some View {
        let selected = FilesRules.displayed(model.mainNav.section, files: model.clientFlags.files) == section
        return Button { model.navigate(to: section) } label: {
            NavRowLabel(
                icon: section.icon, selectedIcon: section.selectedIcon, title: section.title,
                count: count(for: section), selected: selected)
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
        case .today, .calendar, .files:
            return nil
        }
    }

    private var footer: some View {
        HStack(spacing: Theme.s1) {
            Button(action: actions.onOpenPreferences) {
                HStack(spacing: Theme.s2) {
                    Image(systemName: "gearshape").font(Theme.Typo.body)
                        .foregroundStyle(Theme.accent)
                        .frame(width: 20)
                        .accessibilityHidden(true)
                    Text(L("prefs.title")).font(Theme.Typo.body)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Theme.sidebarInkDim)
                .frame(height: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L("prefs.title"))
        }
        .padding(.horizontal, Theme.s4).padding(.vertical, Theme.s2)
    }
}

/// A sidebar row: icon, title, optional count, on the account-tinted
/// chrome: sidebar inks and a pill for the selected row (M1). The icon is an
/// outline SF Symbol in the accent at the label's own font (M3, HIG: sidebar
/// icons take the accent); a selected row may swap in its `.fill` variant.
struct NavRowLabel: View {
    let icon: String
    var selectedIcon: String? = nil
    let title: String
    var count: Int? = nil
    let selected: Bool
    var indented = false
    @State private var hovering = false

    var body: some View {
        HStack(spacing: Theme.s2) {
            Image(systemName: selected ? (selectedIcon ?? icon) : icon)
                .font(Theme.Typo.body)
                .foregroundStyle(Theme.accent)
                .frame(width: 20)
                .accessibilityHidden(true)
            Text(title)
                .font(indented ? Theme.Typo.body : Theme.Typo.body.weight(selected ? .semibold : .regular))
                .foregroundStyle(Theme.sidebarInk)
                .lineLimit(1)
            Spacer(minLength: Theme.s1)
            if let count {
                Text("\(count)")
                    .font(Theme.Typo.caption.monospacedDigit())
                    .foregroundStyle(Theme.sidebarInkDim)
            }
        }
        .padding(.leading, indented ? Theme.s6 : Theme.s2).padding(.trailing, Theme.s3)
        .frame(height: indented ? 28 : 32)
        // On the tinted chrome (M1): a white (dark) / black (light) pill,
        // with the semibold title as the non-color cue.
        .background(
            selected ? Theme.sidebarPill : hovering ? Theme.sidebarHover : .clear,
            in: RoundedRectangle(cornerRadius: Theme.Radius.control))
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
            .foregroundStyle(Theme.sidebarInkDim)
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

/// Connected inboxes, each with its identity color (M1, 2026-11-13). With
/// two or more, a row picks the scope the whole window shows — "All
/// accounts" or one account — and the chrome takes that account's tone.
/// A single account opens Settings, as before. The health is a word too
/// (tooltip, VoiceOver, and a visible line when it needs the user).
private struct AccountRows: View {
    @Environment(AppModel.self) private var model
    let actions: ShellActions

    private var selects: Bool { model.inboxes.count >= 2 }

    var body: some View {
        if model.phase != .signedIn {
            Text(L("nav.accounts.signedOut"))
                .font(Theme.Typo.caption).foregroundStyle(Theme.sidebarInkDim)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Theme.s2)
        } else if model.inboxes.isEmpty {
            Text(L("nav.accounts.none"))
                .font(Theme.Typo.caption).foregroundStyle(Theme.sidebarInkDim)
                .padding(.horizontal, Theme.s2)
        } else {
            if selects {
                Button { model.selectInbox("all") } label: {
                    AccountRowLabel(
                        title: L("nav.accounts.all"), detail: nil,
                        dot: AnyShapeStyle(allDot), selected: model.selectedInbox == "all")
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("nav.accounts.all"))
                .accessibilityAddTraits(model.selectedInbox == "all" ? .isSelected : [])
            }
            ForEach(model.inboxes) { inbox in
                Button { pick(inbox) } label: { row(inbox) }
                    .buttonStyle(.plain)
                    .help(status(inbox))
                    .accessibilityLabel(a11yLabel(inbox))
                    .accessibilityAddTraits(isSelected(inbox) ? .isSelected : [])
            }
        }
    }

    /// Every account's color around one dot: "all of them".
    private var allDot: AngularGradient {
        let colors = model.inboxes.indices.map { Theme.color(AccountIdentity.color(at: $0)) }
        return AngularGradient(colors: colors + colors.prefix(1), center: .center)
    }

    private func isSelected(_ inbox: InboxOption) -> Bool {
        selects && model.selectedInbox == inbox.selectionValue
    }

    private func pick(_ inbox: InboxOption) {
        if selects { model.selectInbox(inbox.selectionValue) } else { actions.onOpenPreferences() }
    }

    private func a11yLabel(_ inbox: InboxOption) -> String {
        let name = inboxDisplayLabel(email: inbox.email, kind: inbox.kind)
        let beta = MailSourceCatalog.isBeta(inbox.provider) ? ", \(L("common.beta"))" : ""
        let lead = selects ? L("nav.accounts.showOnly.a11y", name) : name
        return "\(lead)\(beta). \(status(inbox))"
    }

    private func status(_ inbox: InboxOption) -> String {
        inbox.needsReconnect ? L("nav.accounts.needsReconnect") : L("nav.accounts.connected")
    }

    private func row(_ inbox: InboxOption) -> some View {
        // No visible beta chip or source badge: they truncated the address.
        // VoiceOver still says "beta" (`a11yLabel`); Settings ▸ Accounts shows it.
        let color = AccountIdentity.color(for: inbox, among: model.inboxes).map(Theme.color)
        return AccountRowLabel(
            title: inboxDisplayLabel(email: inbox.email, kind: inbox.kind),
            detail: inbox.needsReconnect ? L("nav.accounts.needsReconnect") : nil,
            dot: AnyShapeStyle(color ?? Theme.sidebarInkDim), selected: isSelected(inbox))
    }
}

/// One account row on the chrome: its color dot, the address, and a
/// reconnect line when it needs the user.
private struct AccountRowLabel: View {
    let title: String
    let detail: String?
    let dot: AnyShapeStyle
    let selected: Bool
    @State private var hovering = false

    var body: some View {
        HStack(spacing: Theme.s2) {
            Circle().fill(dot).frame(width: 10, height: 10)
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(Theme.Typo.sidebarRow.weight(selected ? .semibold : .regular))
                    .foregroundStyle(Theme.sidebarInk)
                    .lineLimit(1).truncationMode(.middle)
                if let detail {
                    Text(detail).font(Theme.Typo.caption).foregroundStyle(Theme.warningInk)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: Theme.s1)
        }
        .padding(.horizontal, Theme.s2)
        .frame(minHeight: 32)
        .background(
            selected ? Theme.sidebarPill : hovering ? Theme.sidebarHover : .clear,
            in: RoundedRectangle(cornerRadius: Theme.Radius.control))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}
