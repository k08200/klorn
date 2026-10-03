import Carbon.HIToolbox
import SwiftUI

/// One tab of the Settings window: the sections `SettingsTab` assigns to it,
/// in a scroll view pinned to the top (a short window scrolls; it never
/// clips the first section). The sections themselves are the ones the old
/// in-window Preferences overlay showed — regrouped, not redesigned.
struct PreferencesView: View {
    @Environment(AppModel.self) private var model
    let tab: SettingsTab

    // Login-item state is owned by the OS (System Settings can flip it behind
    // our back), so it's read live on appear rather than persisted here.
    @State private var launchAtLogin = false
    @State private var loginItemError: String?
    @State private var updateChecking = false
    @State private var updateOutcome: UpdateCheck.Outcome?
    @State private var recordingShortcut = false

    var body: some View {
        let visible = tab.visibleSections(signedIn: model.phase == .signedIn)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if visible.isEmpty {
                    // Only the server-backed tabs can end up empty, and only
                    // while signed out — say why instead of showing nothing.
                    Text(L("settings.signedOutNote"))
                        .font(.callout).foregroundStyle(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, 12)
                }
                ForEach(visible, id: \.self) { section in
                    sectionView(section)
                }
            }
            .padding(.horizontal, 24).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .onAppear { launchAtLogin = LoginItem.isEnabled }
        // Re-ask the server whether device calendars exist each time Settings shows
        // this tab, so a server-side flip shows (or hides) the section without a relaunch.
        .task {
            if model.phase == .signedIn && tab.sections.contains(.deviceCalendars) {
                await model.deviceCalendars.refreshAvailability()
            }
        }
    }

    @ViewBuilder
    private func sectionView(_ kind: PrefsSection) -> some View {
        switch kind {
        case .mode: AutomationPreferences(parts: [.mode])
        case .behaviour: AutomationPreferences(parts: [.behaviour])
        case .replies: AutomationPreferences(parts: [.replies])
        case .interrupts: AutomationPreferences(parts: [.interrupts])
        case .banners: bannersSection
        case .appearance: appearanceSection
        case .mail: mailSection
        case .general: generalSection
        case .topBar: topBarSection
        case .keyboard: keyboardSection
        case .language: languageSection
        case .account: accountSection
        case .inboxes:
            section(L("prefs.section.inboxes")) { InboxAccountsSection(model: model) }
        case .deviceCalendars:
            // Step C6: drawn only while the server has the feature (its 404 hides it).
            if model.deviceCalendars.availability == .available {
                section(L("prefs.section.deviceCalendars")) {
                    DeviceCalendarSection(bridge: model.deviceCalendars)
                }
            }
        case .about:
            section(L("prefs.section.about")) {
                infoRow(L("prefs.about.version"), AppInfo.version)
                infoRow(L("prefs.about.api"), Config.apiBaseURL)
            }
        }
    }

    // MARK: Sections

    @ViewBuilder
    private var bannersSection: some View {
        @Bindable var settings = model.settings
        section(L("prefs.section.notifications")) {
            Toggle(isOn: $settings.notificationsEnabled) {
                Text(L("prefs.banners")).foregroundStyle(Theme.text)
            }
            .toggleStyle(.switch).tint(Theme.accent)
            Text(L("prefs.banners.detail"))
                .font(.caption).foregroundStyle(Theme.textDim).fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var appearanceSection: some View {
        @Bindable var settings = model.settings
        section(L("prefs.section.appearance")) {
            Picker(L("prefs.appearance"), selection: $settings.appearance) {
                ForEach(AppearanceChoice.allCases, id: \.self) { choice in
                    Text(choice.label).tag(choice)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityLabel(L("prefs.appearance"))
            Text(L("prefs.appearance.detail"))
                .font(.caption).foregroundStyle(Theme.textDim).fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var mailSection: some View {
        @Bindable var settings = model.settings
        section(L("prefs.section.mail")) {
            Toggle(isOn: $settings.loadRemoteImages) {
                Text(L("prefs.remoteImages")).foregroundStyle(Theme.text)
            }
            .toggleStyle(.switch).tint(Theme.accent)
            Text(L("prefs.remoteImages.detail"))
                .font(.caption).foregroundStyle(Theme.textDim).fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var generalSection: some View {
        section(L("prefs.section.general")) {
            if LoginItem.isAvailable {
                Toggle(isOn: $launchAtLogin) {
                    Text(L("prefs.launchAtLogin")).foregroundStyle(Theme.text)
                }
                .toggleStyle(.switch).tint(Theme.accent)
                .onChange(of: launchAtLogin) { _, wanted in
                    guard wanted != LoginItem.isEnabled else { return }
                    if let error = LoginItem.setEnabled(wanted) {
                        loginItemError = error
                        launchAtLogin = LoginItem.isEnabled  // revert to OS truth
                    } else {
                        loginItemError = nil
                    }
                }
                if let loginItemError {
                    Text(loginItemError).font(.caption).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                infoRow(L("prefs.launchAtLogin.unavailable.label"), L("prefs.launchAtLogin.unavailable.value"))
            }
            updatesRow
            MainWindowBetaToggle(settings: model.settings)
        }
    }

    private var updatesRow: some View {
        HStack {
            Text(L("prefs.updates")).font(.body).foregroundStyle(Theme.text)
            Spacer()
            switch updateOutcome {
            case .updateAvailable(let version):
                Button(L("prefs.updates.get", version)) { UpdateCheck.openReleasePage() }
                    .buttonStyle(PrimaryButtonStyle())
            case .upToDate:
                Text(L("prefs.updates.upToDate", AppInfo.version))
                    .font(.caption).foregroundStyle(Theme.textDim)
            case .unknown:
                Text(L("prefs.updates.unknown"))
                    .font(.caption).foregroundStyle(Theme.textDim)
            case nil:
                EmptyView()
            }
            Button(updateChecking ? L("prefs.updates.checking") : L("prefs.updates.check")) {
                updateChecking = true
                Task {
                    updateOutcome = await UpdateCheck.run()
                    updateChecking = false
                }
            }
            .buttonStyle(.bordered).controlSize(.small).disabled(updateChecking)
        }
    }

    @ViewBuilder
    private var topBarSection: some View {
        @Bindable var settings = model.settings
        section(L("prefs.section.topBar")) {
            Toggle(isOn: $settings.pillVisible) {
                Text(L("prefs.pillVisible")).foregroundStyle(Theme.text)
            }
            .toggleStyle(.switch).tint(Theme.accent)
            Text(L("prefs.pillVisible.detail"))
                .font(.caption).foregroundStyle(Theme.textDim).fixedSize(horizontal: false, vertical: true)

            Toggle(isOn: $settings.showInDock) {
                Text(L("prefs.showInDock")).foregroundStyle(Theme.text)
            }
            .toggleStyle(.switch).tint(Theme.accent)
            Text(L("prefs.showInDock.detail"))
                .font(.caption).foregroundStyle(Theme.textDim).fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var keyboardSection: some View {
        section(L("prefs.section.keyboard")) {
            HStack {
                Text(L("prefs.shortcut")).font(.body).foregroundStyle(Theme.text)
                Spacer()
                ShortcutRecorder(
                    shortcut: model.settings.shortcut,
                    recording: recordingShortcut,
                    onStartRecording: {
                        recordingShortcut = true
                        model.settings.onShortcutRecordingChanged?(true)
                    },
                    onCapture: { model.settings.shortcut = $0 },
                    onFinished: {
                        recordingShortcut = false
                        model.settings.onShortcutRecordingChanged?(false)
                    },
                    onReset: {
                        recordingShortcut = false
                        model.settings.onShortcutRecordingChanged?(false)
                        model.settings.shortcut = .defaultToggle
                    })
            }
            Text(recordingShortcut
                 ? L("prefs.shortcut.recording")
                 : L("prefs.shortcut.idle"))
                .font(.caption).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var languageSection: some View {
        @Bindable var settings = model.settings
        section(L("prefs.section.language")) {
            HStack {
                Text(L("lang.label")).font(.body).foregroundStyle(Theme.text)
                Spacer()
                Picker(L("lang.label"), selection: $settings.appLanguage) {
                    ForEach(AppLanguage.allCases, id: \.self) { language in
                        Text(language.label).tag(language)
                    }
                }
                .labelsHidden().pickerStyle(.menu).frame(width: 160)
                .accessibilityLabel(L("lang.label"))
            }
            Text(L("lang.detail"))
                .font(.caption).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var accountSection: some View {
        section(L("prefs.section.account")) {
            infoRow(L("prefs.account.status"),
                    model.phase == .signedIn ? L("prefs.account.signedIn") : L("prefs.account.signedOut"))
            if model.phase == .signedIn {
                Button(L("prefs.account.signOut")) { model.signOut() }
                    .buttonStyle(.bordered).controlSize(.small)
                Button(L("account.add")) { Task { await model.addAccount() } }
                    .buttonStyle(.bordered).controlSize(.small)
                Text(L("account.add.hint"))
                    .font(.caption).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                if let error = model.linkAccountError {
                    Text(error).font(.caption).foregroundStyle(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: Layout

    @ViewBuilder
    private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ColumnHeader(title: title)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 12)
        Divider().overlay(Theme.line)
    }

    /// A read-only label · value row; the value is selectable (e.g. the API URL).
    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.body).foregroundStyle(Theme.text)
            Spacer()
            Text(value).font(.callout.monospacedDigit()).foregroundStyle(Theme.textDim)
                .textSelection(.enabled).lineLimit(1).truncationMode(.middle)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(L("prefs.infoRow.a11y", label, value))
    }
}

/// A macOS-style shortcut recorder: shows the current chord (⌥⌘K); click to
/// record, then the next valid key-with-modifier chord is captured via a local
/// NSEvent monitor (the Preferences panel is key while open). Esc cancels; the
/// ⌫ button resets to the default.
private struct ShortcutRecorder: View {
    let shortcut: Shortcut
    let recording: Bool
    let onStartRecording: () -> Void
    let onCapture: (Shortcut) -> Void
    let onFinished: () -> Void
    let onReset: () -> Void
    @State private var monitor: Any?

    var body: some View {
        HStack(spacing: 6) {
            Button(recording ? L("prefs.shortcut.typePrompt") : ShortcutFormat.display(shortcut)) {
                onStartRecording()
            }
            .buttonStyle(.bordered).controlSize(.small)
            .tint(recording ? Theme.accent : nil)
            .frame(minWidth: 96)
            .accessibilityLabel(L("prefs.shortcut.change.a11y", ShortcutFormat.display(shortcut)))

            Button(action: onReset) {
                Image(systemName: "arrow.uturn.backward").font(.caption)
            }
            .buttonStyle(.borderless).controlSize(.small)
            .help(L("prefs.shortcut.reset.help"))
            .accessibilityLabel(L("prefs.shortcut.reset.a11y"))
        }
        .onChange(of: recording) { _, isRecording in
            if isRecording { startCapture() } else { stopCapture() }
        }
        .onDisappear { stopCapture() }
    }

    private func startCapture() {
        stopCapture()
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == UInt16(kVK_Escape) {  // cancel, no change
                onFinished()
                return nil
            }
            let carbon = ShortcutFormat.carbonModifiers(from: event.modifierFlags)
            guard ShortcutFormat.isValid(carbonModifiers: carbon) else {
                return nil  // modifier-less / shift-only: ignore, keep listening
            }
            onCapture(Shortcut(keyCode: UInt32(event.keyCode), carbonModifiers: carbon))
            onFinished()
            return nil  // consume so the key doesn't leak into the app
        }
    }

    private func stopCapture() {
        if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
    }
}

/// Connected mailboxes: every inbox Klorn reads, what it is, and — for the
/// IMAP ones the desktop can manage directly — a way to add or remove them.
/// Google inboxes are OAuth-linked in the browser (see the Account section),
/// so they are listed read-only here.
private struct InboxAccountsSection: View {
    let model: AppModel
    @State private var naverEmail = ""
    @State private var naverPassword = ""
    @State private var showConnectForm = false
    @State private var pendingDisconnect: ImapAccount?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(model.inboxes) { inbox in
                accountRow(
                    email: inbox.email ?? L("inbox.unknownAddress"),
                    provider: providerLabel(inbox.provider),
                    needsReconnect: inbox.needsReconnect,
                    detail: nil,
                    onDisconnect: nil)
            }
            ForEach(model.imapAccounts) { account in
                accountRow(
                    email: account.email,
                    provider: providerLabel("NAVER"),
                    needsReconnect: account.needsReconnect,
                    detail: account.host,
                    onDisconnect: { pendingDisconnect = account })
            }
            if model.inboxes.isEmpty && model.imapAccounts.isEmpty {
                Text(L("prefs.inboxes.empty"))
                    .font(.caption).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if showConnectForm {
                connectForm
            } else {
                Button(L("account.naver.connect")) { showConnectForm = true }
                    .buttonStyle(.bordered).controlSize(.small)
            }
            if let error = model.imapError {
                Text(error).font(.caption).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task { await model.refreshImapAccounts() }
        .confirmationDialog(
            L("account.disconnect.confirm", pendingDisconnect?.email ?? ""),
            isPresented: Binding(
                get: { pendingDisconnect != nil },
                set: { if !$0 { pendingDisconnect = nil } })
        ) {
            Button(L("account.disconnect"), role: .destructive) {
                guard let account = pendingDisconnect else { return }
                pendingDisconnect = nil
                Task { await model.disconnectNaverInbox(email: account.email) }
            }
            Button(L("common.cancel"), role: .cancel) { pendingDisconnect = nil }
        }
    }

    private var connectForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L("account.naver.password.hint"))
                .font(.caption).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
            textInput($naverEmail, label: L("account.naver.email"), secure: false)
            textInput($naverPassword, label: L("account.naver.password"), secure: true)
            HStack(spacing: 8) {
                Button(L("account.naver.submit")) {
                    Task {
                        let ok = await model.connectNaverInbox(
                            email: naverEmail.trimmingCharacters(in: .whitespacesAndNewlines),
                            password: naverPassword)
                        if ok {
                            // Clear the credential from memory the moment the
                            // server has verified it; keep nothing around.
                            naverPassword = ""
                            naverEmail = ""
                            showConnectForm = false
                        }
                    }
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
                .disabled(
                    model.isConnectingImap
                        || !canSubmitImapConnect(email: naverEmail, password: naverPassword))
                Button(L("common.cancel")) {
                    naverPassword = ""
                    showConnectForm = false
                }
                .buttonStyle(.bordered).controlSize(.small)
            }
        }
    }

    private func accountRow(
        email: String, provider: String, needsReconnect: Bool, detail: String?,
        onDisconnect: (() -> Void)?
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(email).font(.body).foregroundStyle(Theme.text)
                    .lineLimit(1).truncationMode(.middle)
                Text(detail.map { "\(provider) · \($0)" } ?? provider)
                    .font(.caption).foregroundStyle(Theme.textDim)
            }
            Spacer()
            if needsReconnect {
                Text(L("inbox.needsReconnect"))
                    .font(.caption).foregroundStyle(Theme.textDim)
            }
            if let onDisconnect {
                Button(L("account.disconnect"), action: onDisconnect)
                    .buttonStyle(.bordered).controlSize(.small)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// AppKit-backed fields paint as placeholder glyphs in the offscreen
    /// design renderer, so mirror the box with plain text there (same shape
    /// as the quiet-hours field).
    @ViewBuilder
    private func textInput(_ text: Binding<String>, label: String, secure: Bool) -> some View {
        if Theme.isRenderingOffscreen {
            Text(secure ? "••••••••" : (text.wrappedValue.isEmpty ? label : text.wrappedValue))
                .font(.callout).foregroundStyle(Theme.textDim)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(height: 22)
                .padding(.horizontal, 6)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.field))
        } else if secure {
            SecureField(label, text: text)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel(label)
        } else {
            TextField(label, text: text)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel(label)
        }
    }
}
