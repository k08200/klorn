import SwiftUI

/// Preferences › Device calendars (step C6). One master switch — the only control
/// that asks macOS for calendar access — then one switch per calendar on this Mac,
/// all off until the user turns one on. Only the calendars switched on are uploaded.
struct DeviceCalendarSection: View {
    let bridge: DeviceCalendarBridge

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            switchRow(
                title: L("deviceCalendars.upload"),
                detail: L("deviceCalendars.detail"),
                isOn: Binding(
                    get: { bridge.uploadEnabled },
                    set: { on in Task { await bridge.setUploadEnabled(on) } }),
                disabled: bridge.isBusy)

            if bridge.access == .denied {
                deniedNote
            } else if bridge.uploadEnabled {
                calendarList
            }
            if let error = bridge.lastError {
                Text(error).font(.caption).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var deniedNote: some View {
        VStack(alignment: .leading, spacing: Theme.s1) {
            Text(L("deviceCalendars.denied"))
                .font(.caption).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
            Button(L("deviceCalendars.openSettings")) { bridge.openPrivacySettings() }
                .buttonStyle(.bordered).controlSize(.small)
        }
    }

    @ViewBuilder
    private var calendarList: some View {
        if bridge.calendars.isEmpty {
            Text(L("deviceCalendars.empty"))
                .font(.caption).foregroundStyle(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text(L("deviceCalendars.count", bridge.enabledIds.intersection(bridge.calendars.map(\.id)).count))
                .font(.caption).foregroundStyle(Theme.textDim)
            ForEach(bridge.calendars) { calendar in
                switchRow(
                    title: calendar.title.isEmpty ? L("deviceCalendars.untitled") : calendar.title,
                    detail: calendar.account.isEmpty ? nil : calendar.account,
                    isOn: Binding(
                        get: { bridge.enabledIds.contains(calendar.id) },
                        set: { on in Task { await bridge.setCalendar(calendar.id, enabled: on) } }),
                    disabled: false)
            }
        }
    }

    private func switchRow(title: String, detail: String?, isOn: Binding<Bool>, disabled: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.s2) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.middle)
                if let detail {
                    Text(detail).font(.caption).foregroundStyle(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: Theme.s2)
            Toggle("", isOn: isOn)
                .toggleStyle(.switch).labelsHidden().tint(Theme.accent)
                .disabled(disabled)
                .accessibilityLabel(title)
        }
    }
}
