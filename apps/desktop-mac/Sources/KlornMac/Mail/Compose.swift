import SwiftUI

/// New-mail composer (full-view overlay): to / subject / body, manual send
/// through POST /api/email/send. The user writes and sends — no AI in the
/// loop here, so there is nothing to approve. Server enforces the Pro gate.
struct ComposePanel: View {
    @Environment(AppModel.self) private var model
    @FocusState private var focusTo: Bool

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L(model.editingDraftGmailId == nil ? "compose.title" : "compose.editDraft"))
                    .font(Theme.Typo.head).foregroundStyle(Theme.text)
                Spacer()
                Button {
                    if !model.composeSending { model.showCompose = false }
                } label: { Image(systemName: "xmark").font(.caption.weight(.semibold)).iconTarget(28) }
                    .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                    .disabled(model.composeSending)
                    .accessibilityLabel(L("compose.close.a11y"))
            }

            field(L("compose.to"), text: $model.composeTo)
                .focused($focusTo)
            field(L("compose.subject"), text: $model.composeSubject)

            Group {
                if Theme.isRenderingOffscreen {
                    Text(model.composeBody.isEmpty ? L("compose.bodyPlaceholder") : model.composeBody)
                        .font(.callout).foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity, minHeight: 170, alignment: .topLeading)
                        .padding(8)
                } else {
                    TextEditor(text: $model.composeBody)
                        .font(.callout).foregroundStyle(Theme.text)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 170)
                        .padding(4)
                        .accessibilityLabel(L("compose.bodyPlaceholder"))
                }
            }
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))

            if let error = model.composeError {
                Text(error).font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Spacer()
                Button(L("compose.cancel")) {
                    model.discardComposeDraft()
                    model.showCompose = false
                }
                    .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                    .disabled(model.composeSending)
                    .keyboardShortcut(.cancelAction)
                Button {
                    Task { await model.submitCompose() }
                } label: {
                    Text(model.composeSending ? L("compose.sending") : L("compose.send"))
                        .font(.callout.weight(.semibold))
                        .padding(.horizontal, 14).padding(.vertical, 6)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)
                .background(Theme.accent, in: Capsule())
                .opacity(model.composeSending ? 0.6 : 1)
                .disabled(model.composeSending)
                .keyboardShortcut(.return, modifiers: .command)
                .accessibilityLabel(L("compose.send"))
            }
        }
        .padding(20)
        .frame(width: 540)
        .background(Theme.bg, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.line))
        .shadow(color: Theme.panelShadow, radius: 24, y: 8)
        .onAppear { focusTo = true }
    }

    @ViewBuilder
    private func field(_ label: String, text: Binding<String>) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(Theme.textDim)
                .frame(width: 56, alignment: .leading)
            if Theme.isRenderingOffscreen {
                Text(text.wrappedValue.isEmpty ? "…" : text.wrappedValue)
                    .font(.callout).foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                TextField("", text: text)
                    .textFieldStyle(.plain).font(.callout).foregroundStyle(Theme.text)
                    .accessibilityLabel(label)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
    }
}

/// Offscreen render harness for the composer (same reason as the briefing
/// probe: overlays inside the full view's ZStack are awkward to shoot).
struct ComposePanelRenderProbe: View {
    var body: some View {
        ComposePanel().padding(24)
    }
}
