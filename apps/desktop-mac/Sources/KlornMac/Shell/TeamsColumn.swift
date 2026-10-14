import SwiftUI

/// "Tue, Aug 25 · 15:00–16:00" — shared by the team screen (ReadingPane has
/// a private twin; unify if a third caller appears).
private func slotRangeLabel(_ startIso: String, _ endIso: String) -> String {
    let iso = ISO8601DateFormatter()
    guard let start = iso.date(from: startIso), let end = iso.date(from: endIso) else {
        return startIso
    }
    let day = DateFormatter()
    day.setLocalizedDateFormatFromTemplate("EdMMM")
    let time = DateFormatter()
    time.setLocalizedDateFormatFromTemplate("HHmm")
    return "\(day.string(from: start)) · \(time.string(from: start))–\(time.string(from: end))"
}

/// Team mode's dedicated screen: manage teams, see when the WHOLE team is
/// free, and book the meeting from a slot. Booking is the approval — the
/// button names every invitee, and the POST goes to the human-approval
/// endpoint that actually sends invitations.
struct TeamsColumn: View {
    @Environment(AppModel.self) private var model
    @State private var selectedTeamId: String?
    @State private var duration = 60
    @State private var meetingTitle = ""
    @State private var name = ""
    @State private var membersText = ""
    @State private var saving = false

    private var selectedTeam: TeamWire? { model.teams.first { $0.id == selectedTeamId } }

    var body: some View {
        OffscreenFriendlyScroll {
            VStack(alignment: .leading, spacing: 14) {
                Text(L("teams.title")).font(Theme.Typo.display).foregroundStyle(Theme.text)
                Text(L("teams.subtitle")).font(.caption).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)

                ForEach(model.teams) { team in
                    teamRow(team)
                }
                if model.teams.isEmpty {
                    Text(L("teams.empty")).font(.caption).foregroundStyle(Theme.textDim)
                }

                Divider().overlay(Theme.line)
                Text(L("teams.addHeader")).font(.caption.weight(.semibold)).foregroundStyle(Theme.textDim)
                TextField(L("teams.namePlaceholder"), text: $name)
                    .textFieldStyle(.roundedBorder).font(.callout)
                TextField(L("teams.membersPlaceholder"), text: $membersText)
                    .textFieldStyle(.roundedBorder).font(.callout)
                HStack(spacing: 8) {
                    Button(saving ? L("teams.saving") : L("teams.add")) {
                        saving = true
                        Task {
                            await model.createTeam(name: name, membersText: membersText)
                            if model.teamError == nil { name = ""; membersText = "" }
                            saving = false
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty
                              || membersText.trimmingCharacters(in: .whitespaces).isEmpty)
                    if let error = model.teamError {
                        Text(error).font(.caption2).foregroundStyle(Theme.textDim)
                    }
                }
                Text(L("teams.visibilityNote")).font(.caption2).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task { await model.refreshTeams() }
    }

    @ViewBuilder
    private func teamRow(_ team: TeamWire) -> some View {
        let isSelected = selectedTeamId == team.id
        VStack(alignment: .leading, spacing: 8) {
            Button {
                selectedTeamId = isSelected ? nil : team.id
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: isSelected ? "chevron.down" : "chevron.right")
                        .font(.caption2).foregroundStyle(Theme.textDim).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(team.name).font(.callout.weight(.medium)).foregroundStyle(Theme.text)
                        Text(team.members.joined(separator: ", "))
                            .font(.caption2).foregroundStyle(Theme.textDim).lineLimit(2)
                    }
                    Spacer()
                    Button(L("teams.remove")) { Task { await model.deleteTeam(id: team.id) } }
                        .buttonStyle(.plain).font(.caption).foregroundStyle(Theme.textDim)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isSelected {
                HStack(spacing: 8) {
                    Picker("", selection: $duration) {
                        Text(L("teams.min30")).tag(30)
                        Text(L("teams.min60")).tag(60)
                    }
                    .pickerStyle(.segmented).labelsHidden().frame(width: 120)
                    Button(model.checkingTeamId == team.id ? L("teams.checking") : L("teams.findSlots")) {
                        Task { await model.checkTeamAvailability(teamId: team.id, durationMinutes: duration) }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(model.checkingTeamId != nil)
                }
                if let result = model.teamBookingResult {
                    Text(result).font(.caption).foregroundStyle(Theme.textDim)
                }
                if let availability = model.teamAvailability {
                    if !availability.unknownMembers.isEmpty {
                        Text(L("teams.unknown", availability.unknownMembers.joined(separator: ", ")))
                            .font(.caption2).foregroundStyle(Theme.textDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if availability.slots.isEmpty {
                        Text(L("teams.noSlots")).font(.caption).foregroundStyle(Theme.textDim)
                    } else {
                        TextField(L("teams.meetingTitlePlaceholder"), text: $meetingTitle)
                            .textFieldStyle(.roundedBorder).font(.callout)
                        ForEach(availability.slots) { slot in
                            HStack(spacing: 8) {
                                Text(slotRangeLabel(slot.startTime, slot.endTime))
                                    .font(.caption.monospacedDigit()).foregroundStyle(Theme.text)
                                Spacer()
                                // The button IS the approval: it names what it sends.
                                Button(L("teams.book", "\(team.members.count)")) {
                                    Task {
                                        _ = await model.bookTeamMeeting(
                                            title: meetingTitle.isEmpty ? team.name : meetingTitle,
                                            slot: slot, members: team.members)
                                    }
                                }
                                .buttonStyle(.bordered).controlSize(.small)
                            }
                        }
                        Text(L("teams.bookNote")).font(.caption2).foregroundStyle(Theme.textDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(10)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line))
    }
}
