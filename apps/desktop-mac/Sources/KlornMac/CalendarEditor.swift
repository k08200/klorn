import SwiftUI

/// Create / edit one calendar event (2026-09-11). A card over the full view
/// like the other one-question surfaces: title, all-day, start, end,
/// location. Save POSTs (new) or PATCHes (edit) through AppModel, which
/// re-reads the visible range so the grid reflects the write; a Pro gate or
/// a validation refusal shows inline and keeps the draft. Never rendered
/// offscreen (the editor opens only on a user action).
struct CalendarEventEditor: View {
    @Environment(AppModel.self) private var model
    @State private var draft = CalendarEventDraft(
        title: "", allDay: false, start: Date(), end: Date(), location: "")
    @State private var seeded = false

    private var isEdit: Bool { model.editingEvent != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            Text(isEdit ? L("cal.editor.editTitle") : L("cal.editor.newTitle"))
                .font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
            TextField(L("cal.editor.title"), text: $draft.title)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel(L("cal.editor.title"))
            Toggle(L("calendar.allDay"), isOn: $draft.allDay)
                .toggleStyle(.switch).font(Theme.Typo.label)
            dateRow(L("cal.editor.start"), selection: $draft.start)
            dateRow(L("cal.editor.end"), selection: $draft.end)
            TextField(L("cal.editor.location"), text: $draft.location)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel(L("cal.editor.location"))
            if let error = model.eventEditorError {
                Text(error).font(.caption).foregroundStyle(Theme.tint(.push))
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: Theme.s2) {
                Button(L("cal.save")) {
                    Task {
                        if await model.saveEvent(draft) { model.dismissEventEditor() }
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .keyboardShortcut(.defaultAction)
                .disabled(!calendarDraftIsValid(draft) || model.eventEditorSaving)
                Button(L("compose.cancel")) { model.dismissEventEditor() }
                    .buttonStyle(.plain).font(Theme.Typo.label)
                    .foregroundStyle(Theme.textDim)
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.top, Theme.s1)
        }
        .padding(22)
        .frame(width: 440)
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.line))
        .shadow(color: Theme.panelShadow, radius: 24, y: 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(isEdit ? L("cal.editor.editTitle") : L("cal.editor.newTitle"))
        .onAppear {
            guard !seeded else { return }
            seeded = true
            draft = model.editingEvent.flatMap { calendarDraft(from: $0) }
                ?? newCalendarDraft(on: model.eventEditorAnchor)
        }
        // Moving the start past the end drags the end along (one hour) —
        // the Save button would otherwise just go grey with no hint why.
        .onChange(of: draft.start) { _, start in
            if !draft.allDay, draft.end <= start {
                draft.end = start.addingTimeInterval(3600)
            }
        }
    }

    private func dateRow(_ label: String, selection: Binding<Date>) -> some View {
        HStack(spacing: Theme.s2) {
            Text(label).font(Theme.Typo.label).foregroundStyle(Theme.textDim)
                .frame(width: 44, alignment: .leading)
            DatePicker(
                label, selection: selection,
                displayedComponents: draft.allDay ? [.date] : [.date, .hourAndMinute]
            )
            .labelsHidden()
            .datePickerStyle(.compact)
            .accessibilityLabel(label)
        }
    }
}
