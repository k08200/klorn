import SwiftUI

/// The Preferences sections backed by `/api/automations` — how much Klorn does
/// on its own, how its replies sound, and what is allowed to interrupt you.
///
/// These settings existed on the server and in the web app from the start; the
/// desktop app just never showed them, so the only way to answer "why did it
/// notify me" or "why does it write like that" was to open a browser.
struct AutomationPreferences: View {
    @Environment(AppModel.self) private var model

    /// The server-backed groups, which the Settings window splits across its
    /// Assistant and Notifications tabs. Order here is display order.
    enum Part: CaseIterable, Sendable { case mode, behaviour, replies, interrupts }

    /// Which groups to draw. Defaults to all of them (the preview renderer).
    var parts: [Part] = Part.allCases

    var body: some View {
        Group {
            ForEach(parts, id: \.self) { part in
                switch part {
                case .mode: section(L("mode.section")) { attentionModeSection }
                case .behaviour: section(L("auto.section.behaviour")) { modeSection }
                case .replies: section(L("auto.section.replies")) { replySection }
                case .interrupts: section(L("auto.section.interrupts")) { notificationSection }
                }
            }
        }
    }

    // MARK: Attention mode (기본 / auto) — the founder's headline switch, so
    // it leads the panel. BASIC = notify important mail + meetings only, the
    // human answers; AUTO = Klorn also answers eligible routine mail per the
    // guideline below (server enforces eligibility + entitlement).

    @State private var guidelineDraft = ""
    @State private var guidelineLoaded = false

    @ViewBuilder
    private var attentionModeSection: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            ForEach(AttentionMode.allCases, id: \.self) { mode in
                ChoiceRow(
                    title: mode.label,
                    detail: mode.explanation,
                    selected: model.automation.attentionMode == mode,
                    disabled: model.automationSaving
                ) {
                    model.updateAutomation { $0.attentionMode = mode }
                }
            }
            if model.automation.attentionMode == .auto {
                Text(L("mode.guideline")).font(.body).foregroundStyle(Theme.text)
                    .padding(.top, Theme.s2)
                Text(L("mode.guideline.detail"))
                    .font(.caption).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                if Theme.isRenderingOffscreen {
                    Text(guidelineDraft.isEmpty ? L("mode.guideline") : guidelineDraft)
                        .font(.callout).foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity, minHeight: 64, alignment: .topLeading)
                        .padding(6)
                        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.field))
                } else {
                    TextEditor(text: $guidelineDraft)
                        .font(.callout)
                        .frame(minHeight: 88, maxHeight: 140)
                        .scrollContentBackground(.hidden)
                        .padding(4)
                        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.field))
                        .accessibilityLabel(L("mode.guideline"))
                }
                HStack(spacing: Theme.s2) {
                    Button(L("mode.guideline.save")) {
                        let trimmed = guidelineDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                        model.updateAutomation { $0.autoReplyGuideline = trimmed.isEmpty ? nil : trimmed }
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(model.automationSaving)
                    Text(L("mode.guideline.resetHint"))
                        .font(.caption2).foregroundStyle(Theme.textDim)
                }
            }
        }
        .onChange(of: model.automation.autoReplyGuideline, initial: true) { _, _ in
            seedGuidelineDraft()
        }
        .onChange(of: model.automation.autoReplyGuidelineDefault) { _, _ in
            seedGuidelineDraft()
        }
    }

    /// Prefill once per fresh server state: the user's override, else the
    /// founder default — the default is the editable starting draft.
    private func seedGuidelineDraft() {
        let server = model.automation.autoReplyGuideline
            ?? model.automation.autoReplyGuidelineDefault ?? ""
        if !guidelineLoaded || guidelineDraft.isEmpty {
            guidelineDraft = server
            guidelineLoaded = true
        }
    }

    // MARK: Agent mode

    @ViewBuilder
    private var modeSection: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            ForEach(AgentMode.allCases, id: \.self) { mode in
                ChoiceRow(
                    title: mode.label,
                    detail: mode.explanation,
                    selected: model.automation.agentMode == mode,
                    disabled: model.automationSaving
                ) {
                    model.updateAutomation { $0.agentMode = mode }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("auto.section.behaviour.a11y"))
    }

    // MARK: Reply tone

    @ViewBuilder
    private var replySection: some View {
        // A Picker, not another stack of cards: the tone list is longer and
        // secondary to the mode choice, and a menu keeps the panel readable.
        HStack {
            Text(L("auto.tone")).font(.body).foregroundStyle(Theme.text)
            Spacer()
            if Theme.isRenderingOffscreen {
                OffscreenPickerLabel(title: model.automation.replyTone.label)
            } else {
                Picker(L("auto.tone"), selection: toneBinding) {
                    ForEach(ReplyTone.allCases, id: \.self) { tone in
                        Text(tone.label).tag(tone)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(width: 160)
                .disabled(model.automationSaving)
                .accessibilityLabel(L("auto.tone.a11y"))
            }
        }
        Text(model.automation.replyTone.explanation)
            .font(.caption).foregroundStyle(Theme.textDim)
            .fixedSize(horizontal: false, vertical: true)
        Text(L("auto.tone.scope"))
            .font(.caption).foregroundStyle(Theme.textDim)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var toneBinding: Binding<ReplyTone> {
        Binding(
            get: { model.automation.replyTone },
            set: { tone in model.updateAutomation { $0.replyTone = tone } })
    }

    // MARK: Notifications

    @ViewBuilder
    private var notificationSection: some View {
        HStack(spacing: Theme.s2) {
            PresetChip(
                title: L("auto.preset.essentials"),
                selected: model.automation.isEssentialsOnly,
                disabled: model.automationSaving
            ) {
                model.updateAutomation { $0 = $0.applyingEssentialsOnly() }
            }
            PresetChip(
                title: L("auto.preset.everything"),
                selected: model.automation.isEverything,
                disabled: model.automationSaving
            ) {
                model.updateAutomation { $0 = $0.applyingEverything() }
            }
            Spacer()
        }
        Text(L("auto.preset.detail"))
            .font(.caption).foregroundStyle(Theme.textDim)
            .fixedSize(horizontal: false, vertical: true)

        VStack(alignment: .leading, spacing: Theme.s2) {
            ForEach(NotifyCategory.all) { category in
                HStack(alignment: .top, spacing: Theme.s3) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(category.title).foregroundStyle(Theme.text)
                        Text(category.detail).font(.caption).foregroundStyle(Theme.textDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: Theme.s2)
                    if Theme.isRenderingOffscreen {
                        OffscreenSwitch(on: category.read(model.automation))
                    } else {
                        Toggle("", isOn: categoryBinding(category))
                            .labelsHidden()
                            .toggleStyle(.switch).tint(Theme.accent)
                            .disabled(model.automationSaving)
                            .accessibilityLabel(category.title)
                    }
                }
            }
        }
        .padding(.top, Theme.s1)

        // Focus window: during calendar blocks only urgent mail and meetings
        // interrupt; the rest arrive as one digest when the block ends.
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(L("auto.focusWindow")).font(Theme.Typo.body).foregroundStyle(Theme.text)
                Text(L("auto.focusWindow.detail"))
                    .font(Theme.Typo.caption).foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Toggle("", isOn: Binding(
                get: { model.automation.focusWindowEnabled },
                set: { on in model.updateAutomation { $0.focusWindowEnabled = on } }
            ))
            .toggleStyle(.switch).labelsHidden()
            .disabled(model.automationSaving)
            .accessibilityLabel(L("auto.focusWindow"))
        }
        .padding(.top, Theme.s2)

        QuietHoursField(
            start: model.automation.quietHoursStart,
            end: model.automation.quietHoursEnd,
            disabled: model.automationSaving
        ) { start, end in
            model.updateAutomation {
                $0.quietHoursStart = start
                $0.quietHoursEnd = end
            }
        }

        if let error = model.automationError {
            Text(error).font(.caption).foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isStaticText)
        }
    }

    private func categoryBinding(_ category: NotifyCategory) -> Binding<Bool> {
        Binding(
            get: { category.read(model.automation) },
            set: { on in model.updateAutomation { category.write(&$0, on) } })
    }

    // MARK: Layout

    @ViewBuilder
    private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            ColumnHeader(title: title)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, Theme.s3)
        Divider().overlay(Theme.line)
    }
}

/// Stand-ins for the AppKit-backed controls while the offscreen renderer runs.
/// A `Toggle(.switch)` and a `.menu` Picker both paint as a "restricted"
/// placeholder glyph under ImageRenderer, which would otherwise be what the
/// landing page shows of Preferences.
private struct OffscreenSwitch: View {
    let on: Bool
    var body: some View {
        Capsule().fill(on ? Theme.accent : Theme.surfaceHover)
            .frame(width: 38, height: 22)
            .overlay(alignment: on ? .trailing : .leading) {
                Circle().fill(.white).frame(width: 18, height: 18).padding(2)
                    .shadow(color: .black.opacity(0.18), radius: 1, y: 1)
            }
            .overlay(Capsule().strokeBorder(Theme.line))
    }
}

private struct OffscreenPickerLabel: View {
    let title: String
    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.callout).foregroundStyle(Theme.text)
            Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(Theme.textDim)
        }
        .padding(.horizontal, 11).padding(.vertical, 5)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Theme.line))
    }
}

/// A radio-style option: title, one line of consequence, and a check when
/// chosen. A whole-row button so the target clears 44pt without a custom hit
/// area, and `.isSelected` so VoiceOver announces state rather than colour.
private struct ChoiceRow: View {
    let title: String
    let detail: String
    let selected: Bool
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: Theme.s3) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Theme.accent : Theme.textDim)
                    .font(.body)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.body.weight(selected ? .semibold : .regular))
                        .foregroundStyle(Theme.text)
                    Text(detail).font(.caption).foregroundStyle(Theme.textDim)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, Theme.s2)
            .padding(.horizontal, Theme.s3)
            .frame(minHeight: 44, alignment: .top)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(selected ? Theme.surfaceSelected : Theme.surfaceRaised))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(selected ? Theme.accent.opacity(0.5) : Theme.line))
            // Ideal-height pin on the WHOLE card (background included), not on
            // the inner Text: inside a Button label a text-level fixedSize can
            // measure taller than the card draws, painting the last wrapped
            // line BELOW the border (founder report 2026-08-21); without any
            // pin the detail truncates instead. Pinning here keeps background
            // and text one unit — full wrap, never an escape.
            .fixedSize(horizontal: false, vertical: true)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title). \(detail)")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// A one-click notification preset. Selected state is derived from the actual
/// toggles, so flipping a single switch drops the chip out of its preset
/// instead of leaving a lie on screen.
private struct PresetChip: View {
    let title: String
    let selected: Bool
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.callout.weight(selected ? .semibold : .regular))
                .foregroundStyle(selected ? Theme.accentDeep : Theme.text)
                .padding(.horizontal, Theme.s3)
                .frame(minHeight: 44)
                .background(
                    Capsule().fill(selected ? Theme.surfaceSelected : Theme.surfaceRaised))
                .overlay(
                    Capsule().strokeBorder(selected ? Theme.accent.opacity(0.5) : Theme.line))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// Quiet-hours window. Committed on Enter or focus loss rather than per
/// keystroke — "2" on the way to "22:00" is not a value worth PATCHing.
/// Clearing either field clears the window.
private struct QuietHoursField: View {
    let start: String?
    let end: String?
    let disabled: Bool
    let onCommit: (String?, String?) -> Void

    @State private var startText = ""
    @State private var endText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s1) {
            HStack(spacing: Theme.s2) {
                Text(L("auto.quietHours")).font(.body).foregroundStyle(Theme.text)
                Spacer()
                field($startText, label: L("auto.quietHours.start.a11y"))
                Text("→").foregroundStyle(Theme.textDim)
                field($endText, label: L("auto.quietHours.end.a11y"))
            }
            Text(invalid ? L("auto.quietHours.invalid") : L("auto.quietHours.detail"))
                .font(.caption)
                .foregroundStyle(invalid ? .orange : Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, Theme.s2)
        .onAppear { syncFromModel() }
        .onChange(of: start) { _, _ in syncFromModel() }
        .onChange(of: end) { _, _ in syncFromModel() }
    }

    /// Both fields blank = deliberately cleared, which is valid. Anything else
    /// that doesn't parse as a full window is flagged.
    private var invalid: Bool {
        let bothBlank = startText.trimmingCharacters(in: .whitespaces).isEmpty
            && endText.trimmingCharacters(in: .whitespaces).isEmpty
        if bothBlank { return false }
        let pair = QuietHours.pair(start: startText, end: endText)
        return pair.start == nil
    }

    @ViewBuilder
    private func field(_ text: Binding<String>, label: String) -> some View {
        if Theme.isRenderingOffscreen {
            // TextField is AppKit-backed and paints as a placeholder glyph
            // offscreen; this keeps the same box for the design renderer.
            Text(text.wrappedValue.isEmpty ? "--:--" : text.wrappedValue)
                .font(.callout).foregroundStyle(Theme.textDim)
                .frame(width: 76, height: 22)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.field))
        } else {
            TextField("--:--", text: text)
                .textFieldStyle(.roundedBorder)
                .frame(width: 76)
                .multilineTextAlignment(.center)
                .disabled(disabled)
                .accessibilityLabel(label)
                .onSubmit(commit)
        }
    }

    private func syncFromModel() {
        startText = start ?? ""
        endText = end ?? ""
    }

    private func commit() {
        let pair = QuietHours.pair(start: startText, end: endText)
        onCommit(pair.start, pair.end)
        // Echo the normalized values back so "9:5" visibly becomes "09:05";
        // an unparseable entry keeps what was typed so it can be corrected.
        if let s = pair.start, let e = pair.end {
            startText = s
            endText = e
        }
    }
}
