import Carbon.HIToolbox
import SwiftUI

/// The Preferences overlay shown over the full view. A self-contained dark card:
/// notification control, hotkey reference, account, and about. Dismissed via
/// "Done" (default keyboard action) or by clicking the scrim (see FullView).
struct PreferencesView: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

    // Login-item state is owned by the OS (System Settings can flip it behind
    // our back), so it's read live on appear rather than persisted here.
    @State private var launchAtLogin = false
    @State private var loginItemError: String?
    @State private var updateChecking = false
    @State private var updateOutcome: UpdateCheck.Outcome?
    @State private var recordingShortcut = false

    var body: some View {
        // Local @Bindable so the Toggle can write into the nested settings object.
        @Bindable var settings = model.settings

        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Preferences").font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                Spacer()
                Button("Done") { model.showPreferences = false }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.bottom, 12)

            section("NOTIFICATIONS") {
                Toggle(isOn: $settings.notificationsEnabled) {
                    Text("Show a macOS notification for new PUSH").foregroundStyle(Theme.text)
                }
                .toggleStyle(.switch).tint(Theme.accent)
                Text("The top bar always updates its PUSH count — this only controls the system banner.")
                    .font(.caption).foregroundStyle(Theme.textDim).fixedSize(horizontal: false, vertical: true)
            }

            section("GENERAL") {
                if LoginItem.isAvailable {
                    Toggle(isOn: $launchAtLogin) {
                        Text("Start Klorn at login").foregroundStyle(Theme.text)
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
                    infoRow("Start at login", "Packaged app only")
                }

                HStack {
                    Text("Updates").font(.body).foregroundStyle(Theme.text)
                    Spacer()
                    switch updateOutcome {
                    case .updateAvailable(let version):
                        Button("Get v\(version)") { UpdateCheck.openReleasePage() }
                            .buttonStyle(.borderedProminent).controlSize(.small).tint(Theme.accent)
                    case .upToDate:
                        Text("Up to date (v\(AppInfo.version))")
                            .font(.caption).foregroundStyle(Theme.textDim)
                    case .unknown:
                        Text("Couldn't check — try the releases page")
                            .font(.caption).foregroundStyle(Theme.textDim)
                    case nil:
                        EmptyView()
                    }
                    Button(updateChecking ? "Checking…" : "Check for updates") {
                        updateChecking = true
                        Task {
                            updateOutcome = await UpdateCheck.run()
                            updateChecking = false
                        }
                    }
                    .buttonStyle(.bordered).controlSize(.small).disabled(updateChecking)
                }
            }

            section("TOP BAR") {
                Toggle(isOn: $settings.pillVisible) {
                    Text("Always show the top bar").foregroundStyle(Theme.text)
                }
                .toggleStyle(.switch).tint(Theme.accent)
                Text("Off: the bar stays hidden until ⌥⌘K summons it. Urgent-email cards still appear.")
                    .font(.caption).foregroundStyle(Theme.textDim).fixedSize(horizontal: false, vertical: true)
            }

            section("KEYBOARD") {
                HStack {
                    Text("Summon / expand").font(.body).foregroundStyle(Theme.text)
                    Spacer()
                    ShortcutRecorder(
                        shortcut: model.settings.shortcut,
                        recording: recordingShortcut,
                        onStartRecording: { recordingShortcut = true },
                        onCapture: { model.settings.shortcut = $0 },
                        onFinished: { recordingShortcut = false },
                        onReset: {
                            recordingShortcut = false
                            model.settings.shortcut = .defaultToggle
                        })
                }
                Text(recordingShortcut
                     ? "Type a shortcut — must include ⌘, ⌥, or ⌃. Esc to cancel."
                     : "Global shortcut to summon the bar. Click to change.")
                    .font(.caption).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }

            section("ACCOUNT") {
                infoRow("Status", model.phase == .signedIn ? "Signed in" : "Not signed in")
                if model.phase == .signedIn {
                    Button("Sign out") { model.showPreferences = false; actions.onSignOut() }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            }

            section("ABOUT") {
                infoRow("Version", AppInfo.version)
                infoRow("API", Config.apiBaseURL)
            }
        }
        .onAppear { launchAtLogin = LoginItem.isEnabled }
        .padding(22)
        .frame(width: 440)
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.line))
        .shadow(radius: 24, y: 8)
    }

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
        .accessibilityLabel("\(label): \(value)")
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
            Button(recording ? "Type shortcut…" : ShortcutFormat.display(shortcut)) {
                onStartRecording()
            }
            .buttonStyle(.bordered).controlSize(.small)
            .tint(recording ? Theme.accent : nil)
            .frame(minWidth: 96)
            .accessibilityLabel("Change summon shortcut, currently \(ShortcutFormat.display(shortcut))")

            Button(action: onReset) {
                Image(systemName: "arrow.uturn.backward").font(.caption)
            }
            .buttonStyle(.borderless).controlSize(.small)
            .help("Reset to ⌥⌘K")
            .accessibilityLabel("Reset shortcut to default")
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
