import AppKit
import SwiftUI

/// The one connect form for app-password IMAP providers (Naver Mail and
/// iCloud Mail, both beta), opened in place in Settings ▸ Accounts — the app
/// presents no SwiftUI sheets (SelfCheckWindows). The app password lives only
/// in this view's state and the single POST that verifies it; the fields are
/// cleared on success and whenever the form closes.
struct ImapConnectForm: View {
    let provider: ImapMailProvider
    let model: AppModel
    /// Closes the form (Cancel, or a connect the server accepted).
    let onClose: () -> Void
    @State private var email: String
    @State private var password: String
    @State private var failure: ImapConnectFailure?
    /// Render seam: the offscreen renderer cannot hold a request in flight.
    private let showsConnecting: Bool

    init(
        provider: ImapMailProvider, model: AppModel, onClose: @escaping () -> Void,
        email: String = "", password: String = "", failure: ImapConnectFailure? = nil,
        showsConnecting: Bool = false
    ) {
        self.provider = provider
        self.model = model
        self.onClose = onClose
        _email = State(initialValue: email)
        _password = State(initialValue: password)
        _failure = State(initialValue: failure)
        self.showsConnecting = showsConnecting
    }

    /// Whether Connect may be pressed: valid fields and nothing in flight. Pure.
    static func canSubmit(email: String, password: String, isConnecting: Bool) -> Bool {
        !isConnecting && canSubmitImapConnect(email: email, password: password)
    }

    private var isConnecting: Bool { showsConnecting || model.isConnectingImap }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            HStack(spacing: Theme.s2) {
                Text(L(provider.titleKey)).font(Theme.Typo.head).foregroundStyle(Theme.text)
                BetaChip()
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            if let bodyKey = provider.bodyKey {
                caption(L(bodyKey))
            }
            field(L(provider.emailKey), text: $email, placeholder: provider.emailPlaceholder, secure: false)
            field(L(provider.passwordKey), text: $password, placeholder: provider.passwordPlaceholder, secure: true)
            caption(L(provider.hintKey))
            if let url = provider.appPasswordHelpURL, let linkKey = provider.helpLinkKey {
                if Theme.isRenderingOffscreen {
                    // The AppKit-backed link button paints a placeholder offscreen.
                    Text(L(linkKey)).font(Theme.Typo.caption).foregroundStyle(Theme.accentDeep)
                } else {
                    Button(L(linkKey)) { NSWorkspace.shared.open(url) }
                        .buttonStyle(.link).font(Theme.Typo.caption)
                        .help(url.absoluteString)
                }
            }
            if let failure {
                Text(failure.message(for: provider))
                    .font(Theme.Typo.caption).foregroundStyle(Theme.dangerInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel(failure.message(for: provider))
                if failure == .needsPro { UpgradeToProLink() }
            }
            actions
        }
        .padding(Theme.s4)
        .frame(maxWidth: 440, alignment: .topLeading)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.md))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).strokeBorder(Theme.line, lineWidth: Theme.hairline))
        .onChange(of: email) { failure = nil }
        .onChange(of: password) { failure = nil }
        .onDisappear {
            // Nothing outlives the form: not the password, not the address.
            password = ""
            email = ""
        }
    }

    private var actions: some View {
        HStack(spacing: Theme.s2) {
            Spacer()
            Button(L("common.cancel"), action: onClose)
                .keyboardShortcut(.cancelAction)
                .disabled(isConnecting)
            Button(action: submit) {
                HStack(spacing: Theme.s1) {
                    if isConnecting && !Theme.isRenderingOffscreen { ProgressView().controlSize(.small) }
                    Text(isConnecting ? L("account.imap.connecting") : L("account.imap.submit"))
                }
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)
            .disabled(!Self.canSubmit(email: email, password: password, isConnecting: isConnecting))
        }
    }

    private func submit() {
        guard Self.canSubmit(email: email, password: password, isConnecting: isConnecting) else { return }
        failure = nil
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let secret = password
        Task {
            switch await model.connectImapInbox(provider, email: address, secret: secret) {
            case .connected:
                password = ""
                email = ""
                onClose()
            case .failed(let reason):
                failure = reason
            case .ignored:
                break
            }
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text).font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// AppKit-backed fields paint as placeholder glyphs in the offscreen
    /// renderer, so mirror the box with plain text there (as Settings does).
    @ViewBuilder
    private func field(_ label: String, text: Binding<String>, placeholder: String, secure: Bool) -> some View {
        VStack(alignment: .leading, spacing: Theme.s1) {
            Text(label).font(Theme.Typo.label).foregroundStyle(Theme.text)
            if Theme.isRenderingOffscreen {
                let value = text.wrappedValue
                Text(value.isEmpty ? placeholder : (secure ? String(repeating: "•", count: value.count) : value))
                    .font(Theme.Typo.body)
                    .foregroundStyle(value.isEmpty ? Theme.textDim : Theme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: 22)
                    .padding(.horizontal, 6)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.field))
            } else if secure {
                SecureField(placeholder, text: text)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel(label)
            } else {
                TextField(placeholder, text: text)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .accessibilityLabel(label)
            }
        }
    }
}
