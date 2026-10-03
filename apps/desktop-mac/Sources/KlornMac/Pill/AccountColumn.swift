import SwiftUI

/// Column 3 — account + resources.
struct AccountColumn: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions
    @State private var updating = false
    /// Same stowing as the full sidebar: maintenance is occasional, the
    /// 380pt panel column doubly so. Support tools need an Option-click
    /// (see MaintenanceDisclosure).
    @State private var maintenance = MaintenanceDisclosure.State(expanded: false, supportTools: false)

    var body: some View {
        // The panel is a fixed 1140x380; this column grew past it when the
        // update/restart/diagnostics actions landed and the TOP silently
        // clipped (founder, 2026-08-10). Scroll instead of clip — never let
        // an added action push the header off-screen again.
        ScrollView(.vertical, showsIndicators: true) {
        VStack(alignment: .leading, spacing: 14) {
            ColumnHeader(title: L("prefs.section.account"))
            if model.phase == .signedIn {
                if let version = model.updateAvailable {
                    UpdateRow(version: version)
                }
                SubtleTextButton(title: L("prefs.account.signOut")) { actions.onSignOut() }
                // Always offered, not only when needsReconnect is already
                // true: a dead primary token is exactly the state where the
                // app cannot be trusted to know it is dead, and sending the
                // user to the web app to fix it is the bug we are closing.
                SubtleTextButton(title: L("account.reconnectPrimary")) {
                    Task { await model.reconnectPrimary() }
                }
                SubtleTextButton(title: L("account.add")) { Task { await model.addAccount() } }
                Divider()
                Button {
                    let next = MaintenanceDisclosure.toggled(
                        maintenance, optionHeld: MaintenanceDisclosure.optionHeld)
                    withAnimation(.easeOut(duration: 0.15)) { maintenance = next }
                } label: {
                    HStack(spacing: 6) {
                        Text(L("account.maintenance")).font(.callout).foregroundStyle(Theme.textDim)
                        Image(systemName: "chevron.right").font(.caption2)
                            .foregroundStyle(Theme.textDim)
                            .rotationEffect(maintenance.expanded ? .degrees(90) : .zero)
                            .accessibilityHidden(true)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("account.maintenance"))
                .accessibilityValue(maintenance.expanded ? L("a11y.expanded") : L("a11y.collapsed"))
                // VoiceOver / Switch Control / Full Keyboard Access path to
                // the Option-click support tools.
                .accessibilityAction(named: L("account.showSupportTools")) {
                    maintenance = MaintenanceDisclosure.revealed
                }
                if maintenance.expanded {
                    SubtleTextButton(title: L("menu.checkUpdates")) {
                        Task { await model.checkForUpdateNow() }
                    }
                    if let result = model.updateCheckResult {
                        Text(result).font(.caption2).foregroundStyle(Theme.textDim)
                    }
                    if maintenance.supportTools {
                        SubtleTextButton(title: L("menu.restart")) { AppRestart.relaunch() }
                        SubtleTextButton(title: L("menu.diagnostics")) {
                            Task { await model.runDiagnostics() }
                        }
                    }
                    // Sits with diagnostics on purpose: someone who just ran a
                    // diagnostic and is still stuck needs the next step in the
                    // same place, not on a legal page they have no reason to open.
                    SubtleTextButton(title: L("menu.contactSupport")) { openSupportMail() }
                    if maintenance.supportTools { DiagnosticsBlock() }
                }
                if let error = model.linkAccountError {
                    Text(error).font(.caption2).foregroundStyle(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                // Same pre-OAuth purpose pick as the full sidebar — the
                // expanded panel is the other place a sign-in starts.
                PurposePickRow(horizontalPadding: 0)
                SubtleTextButton(title: L("auth.signInGoogle"), dim: false) { actions.onSignIn() }
                ForEach(model.loginProviders.filter { $0 != "google" }, id: \.self) { provider in
                    SubtleTextButton(title: loginProviderLabel(provider), dim: false) {
                        Task { await model.signIn(provider: provider) }
                    }
                }
            }
            if model.phase == .signedIn, let usage = model.usage {
                VStack(alignment: .leading, spacing: 5) {
                    Text(L("section.aiToday")).font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.surfaceHover)
                            Capsule()
                                .fill(LinearGradient(
                                    colors: [Theme.accent, Theme.accentDeep],
                                    startPoint: .leading, endPoint: .trailing))
                                .frame(width: geo.size.width
                                       * usageFillFraction(used: usage.dailyUsed, cap: usage.dailyCap))
                        }
                    }
                    .frame(height: 5)
                    Text(usageLabel(used: usage.dailyUsed, cap: usage.dailyCap))
                        .font(.caption2.monospacedDigit()).foregroundStyle(Theme.textDim)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(L("aiUsage.a11y", usage.dailyUsed, usage.dailyCap))
                .padding(.top, 4)
            }

            SubtleTextButton(title: L("prefs.title")) { actions.onOpenPreferences() }
            SubtleTextButton(title: L("menu.quit")) { actions.onQuit() }
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
