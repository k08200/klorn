import SwiftUI

/// Native sign-in. Tapping the button runs the browser-bounce nonce-poll flow;
/// one Google consent signs in AND connects Gmail/Calendar, so the queue is
/// populated on return. The OS browser handles OAuth — nothing in-window.
struct SignInView: View {
    @Environment(AppModel.self) private var model

    private var signingIn: Bool { model.phase == .signingIn }

    var body: some View {
        VStack(spacing: 18) {
            Text("Klorn")
                .font(.system(size: 44, weight: .semibold, design: .rounded))
                .foregroundStyle(Theme.accent)
            Text("Your inbox firewall — PUSH · QUEUE · SILENT · AUTO")
                .font(.callout).foregroundStyle(.secondary)

            Button {
                Task { await model.signIn() }
            } label: {
                HStack(spacing: 8) {
                    if signingIn { ProgressView().controlSize(.small) }
                    Text(signingIn ? "Waiting for your browser…" : "Sign in with Google")
                        .fontWeight(.medium)
                }
                .frame(minWidth: 230).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .disabled(signingIn)

            if signingIn {
                Text("Finish in the browser that just opened, then come back here.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let err = model.signInError {
                Text(err).font(.footnote).foregroundStyle(.red)
                    .multilineTextAlignment(.center).frame(maxWidth: 340)
            }
        }
        .padding(40)
    }
}
