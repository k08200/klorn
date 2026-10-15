import SwiftUI

/// Login button label per advertised provider id. Data-driven from
/// GET /api/auth/providers, so a provider the founder flips on later (naver)
/// appears WITHOUT an app update; an id the app has no string for degrades
/// to the capitalized id rather than hiding the button.
func loginProviderLabel(_ id: String) -> String {
    switch id {
    case "apple": L("auth.signInApple")
    case "naver": L("auth.signInNaver")
    default: id.capitalized
    }
}

/// Open the user's mail client on the pinned support address.
///
/// k0820086@gmail.com, not anything @klorn.ai: the domain has no MX record, so
/// a klorn.ai address would bounce silently. The subject carries the app
/// version so a report arrives with the one fact every triage starts from.
@MainActor
func openSupportMail() {
    let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
    var components = URLComponents()
    components.scheme = "mailto"
    components.path = "k0820086@gmail.com"
    components.queryItems = [URLQueryItem(name: "subject", value: "Klorn for Mac \(version)")]
    guard let url = components.url else { return }
    NSWorkspace.shared.open(url)
}

/// The update affordance in the panel's ACCOUNT column. Never a popup (never-steal-focus) — but no longer
/// invisible either: a tinted capsule with a pulsing dot and a gentle
/// appear transition says "one click waiting" the moment the row exists.
/// Pulse respects Reduce Motion.
/// Compact per-account readiness readout: one line per check, colored by
/// status. Renders nothing until the user asks for it.
struct DiagnosticsBlock: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.diagnosticsInFlight {
                Text(L("diagnostics.checking")).font(.caption2).foregroundStyle(Theme.textDim)
            }
            if let error = model.diagnosticsError {
                Text(error).font(.caption2).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(model.diagnostics) { check in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Circle().fill(statusColor(check.status))
                        .frame(width: 6, height: 6)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        // Status is never color-only: the localized word
                        // carries it alongside the dot.
                        Text("\(localizedLabel(check)) · \(statusWord(check.status))")
                            .font(.caption2.weight(check.status == "ok" ? .regular : .semibold))
                            .foregroundStyle(check.status == "ok" ? Theme.textDim : Theme.text)
                        Text(check.message)
                            .font(.caption2)
                            .foregroundStyle(Theme.textDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    /// The server sends English-only labels; known check keys render through
    /// the catalogue and unknown ones fall back to the server label so a new
    /// server-side check degrades to English instead of an L10n key.
    private func localizedLabel(_ check: ReadinessCheck) -> String {
        let key = "diag.\(check.key)"
        let localized = L(key)
        return localized == key ? check.label : localized
    }

    private func statusWord(_ status: String) -> String {
        switch status {
        case "ok": return L("diag.status.ok")
        case "warning": return L("diag.status.warning")
        default: return L("diag.status.error")
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "ok": return Theme.success
        case "warning": return Theme.warning
        default: return Theme.danger
        }
    }
}

struct UpdateRow: View {
    let version: String
    @State private var updating = false
    @State private var pulsing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            guard !updating else { return }
            updating = true
            Task {
                _ = await SelfUpdate.run(version: version)
                updating = false  // reached only on fallback
            }
        } label: {
            HStack(spacing: 8) {
                ZStack {
                    if !reduceMotion {
                        Circle()
                            .fill(Theme.accent.opacity(0.35))
                            .frame(width: 7, height: 7)
                            .scaleEffect(pulsing ? 2.1 : 1.0)
                            .opacity(pulsing ? 0.0 : 0.7)
                    }
                    Circle().fill(Theme.accent).frame(width: 7, height: 7)
                }
                Text(updating ? L("update.updating") : L("update.installVersion", version))
                    .font(.body.weight(.medium))
                    .foregroundStyle(Theme.accent)
                Spacer(minLength: 0)
                Image(systemName: updating ? "arrow.triangle.2.circlepath" : "arrow.down.circle.fill")
                    .foregroundStyle(Theme.accent)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Theme.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
            .overlay(
                RoundedRectangle(cornerRadius: 9)
                    .strokeBorder(Theme.accent.opacity(0.25), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(updating)
        .accessibilityLabel(updating
            ? L("update.a11y.updating", version)
            : L("update.a11y.available", version))
        .transition(.opacity.combined(with: .move(edge: .top)))
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) {
                pulsing = true
            }
        }
    }
}
