import SwiftUI

// MARK: - Collapsed

/// Collapsed pill: always visible at the top, glanceable state.
struct CollapsedBar: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    private var pushCount: Int { model.queue?.summary.push ?? 0 }

    var body: some View {
        HStack(spacing: 12) {
            Button(action: actions.onExpand) {
                Image(systemName: "line.3.horizontal").font(.body.weight(.medium)).iconTarget(30)
            }
            .buttonStyle(.plain).foregroundStyle(Theme.text)
            .focusEffectDisabled()  // the default ring reads as an artifact on the capsule
            .help(L("bar.expand"))
            .accessibilityLabel(L("bar.expand.a11y"))

            LogoRing()
            Text("Klorn").font(.system(.callout, design: .rounded).weight(.bold)).foregroundStyle(Theme.text)

            Spacer()

            switch model.phase {
            case .signedIn:
                if pushCount > 0 {
                    // The one loud element Klorn allows itself: a glowing
                    // signal dot + tinted chip. Everything else stays quiet
                    // so this is unmissable at a glance.
                    HStack(spacing: 5) {
                        Circle().fill(Theme.tint(.push)).frame(width: 7, height: 7)
                            .shadow(color: Theme.tint(.push).opacity(0.8), radius: 3)
                        Text(L("bar.push", pushCount))
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(Theme.text)
                    }
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Theme.tint(.push).opacity(0.12), in: Capsule())
                }
                // NOT an else-branch: a frozen board WITH push items used to
                // show no error at all, forever — staleness matters MORE when
                // the user believes urgent items are live (2026-08-10, the
                // 403-freeze hole).
                if let notice = model.pillNotice {
                    // "Offline" only when the network is the cause, and the
                    // chip is the retry (M6); it used to read "offline" for
                    // every failure and do nothing.
                    Button {
                        Task { await model.retryLoad() }
                    } label: {
                        HStack(spacing: 5) {
                            Circle().fill(Theme.tint(.push).opacity(0.7)).frame(width: 6, height: 6)
                                .accessibilityHidden(true)
                            Text(notice.shortLabel).font(.caption)
                        }
                        .foregroundStyle(Theme.textDim)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Theme.surfaceRaised, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(!SurfaceStateRules.mayRetry(isLoading: model.isLoadingQueue))
                    .help(L("bar.retry.help"))
                    .accessibilityLabel(L("bar.retry.a11y", notice.shortLabel))
                } else if pushCount == 0 {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark").font(.caption2.weight(.semibold))
                            .accessibilityHidden(true)
                        Text(L("bar.allClear")).font(.caption)
                    }
                    .foregroundStyle(Theme.textDim)
                }
            case .signingIn:
                Text(L("bar.signingIn")).font(.caption).foregroundStyle(Theme.textDim)
            case .signedOut:
                Button(L("auth.logIn"), action: actions.onSignIn)
                    .buttonStyle(PrimaryButtonStyle())
                ForEach(model.loginProviders.filter { $0 != "google" }, id: \.self) { provider in
                    Button(loginProviderLabel(provider)) {
                        Task { await model.signIn(provider: provider) }
                    }
                    .buttonStyle(.bordered)
                }
            }

            Button(action: actions.onHideBar) {
                Image(systemName: "xmark").font(.caption.weight(.semibold)).iconTarget(30)
            }
            .buttonStyle(.plain).hoverDim()
            .focusEffectDisabled()
            .help(L("bar.hide"))
            .accessibilityLabel(L("bar.hide.a11y"))
        }
        .padding(.leading, 18).padding(.trailing, 16)
        .frame(width: TopBarMetrics.collapsed.width, height: TopBarMetrics.collapsed.height)
    }
}
