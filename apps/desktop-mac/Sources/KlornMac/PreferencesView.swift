import SwiftUI

/// The Preferences overlay shown over the full view. A self-contained dark card:
/// notification control, hotkey reference, account, and about. Dismissed via
/// "Done" (default keyboard action) or by clicking the scrim (see FullView).
struct PreferencesView: View {
    @Environment(AppModel.self) private var model
    let actions: TopBarActions

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

            section("TOP BAR") {
                Toggle(isOn: $settings.pillVisible) {
                    Text("Always show the top bar").foregroundStyle(Theme.text)
                }
                .toggleStyle(.switch).tint(Theme.accent)
                Text("Off: the bar stays hidden until ⌥⌘K summons it. Urgent-email cards still appear.")
                    .font(.caption).foregroundStyle(Theme.textDim).fixedSize(horizontal: false, vertical: true)
            }

            section("KEYBOARD") {
                infoRow("Expand / collapse", "⌥⌘K")
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
