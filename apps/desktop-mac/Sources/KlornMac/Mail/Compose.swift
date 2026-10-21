import SwiftUI

/// New-mail composer: to / subject / body, manual send through
/// POST /api/email/send. The user writes and sends — no AI in the loop here,
/// so there is nothing to approve. Server enforces the Pro gate. Fills its
/// own window (M5); the window's title bar carries the title and the close
/// button.
struct ComposePanel: View {
    @Environment(AppModel.self) private var model
    @FocusState private var focusTo: Bool
    /// The window's Discard Draft: the controller confirms, then discards.
    var onDiscard: () -> Void = {}

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 12) {
            field(L("compose.to"), text: $model.composeTo)
                .focused($focusTo)
            field(L("compose.subject"), text: $model.composeSubject)

            Group {
                if Theme.isRenderingOffscreen {
                    Text(model.composeBody.isEmpty ? L("compose.bodyPlaceholder") : model.composeBody)
                        .font(.callout)
                        .foregroundStyle(model.composeBody.isEmpty ? Theme.textDim : Theme.text)
                        .frame(
                            maxWidth: .infinity, minHeight: 170, maxHeight: .infinity,
                            alignment: .topLeading)
                        .padding(8)
                } else {
                    TextEditor(text: $model.composeBody)
                        .font(.callout).foregroundStyle(Theme.text)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 170, maxHeight: .infinity)
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
                // Named for what it does, and never on Escape: in a
                // window, closing (⌘W) keeps the draft.
                Button(L("compose.discard"), action: onDiscard)
                    .buttonStyle(.plain).font(Theme.Typo.label)
                    .foregroundStyle(Theme.textDim)
                    .disabled(model.composeSending)
                    .padding(.trailing, Theme.s2)
                Button {
                    Task { await model.submitCompose() }
                } label: {
                    Text(model.composeSending ? L("compose.sending") : L("compose.send"))
                        .font(.callout.weight(.semibold))
                        .padding(.horizontal, 14).padding(.vertical, 6)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.onAccentSolid)
                .background(Theme.accentSolid, in: Capsule())
                .opacity(model.composeSending ? 0.6 : 1)
                .disabled(model.composeSending)
                .keyboardShortcut(.return, modifiers: .command)
                .accessibilityLabel(L("compose.send"))
            }
        }
        .padding(Theme.s4)
        .frame(
            minWidth: ComposeWindowRules.minSize.width, maxWidth: .infinity,
            minHeight: ComposeWindowRules.minSize.height, maxHeight: .infinity,
            alignment: .top)
        .background(Theme.bg)
        .onAppear { focusTo = true }
    }

    @ViewBuilder
    private func field(_ label: String, text: Binding<String>) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(Theme.textDim)
                .frame(width: 56, alignment: .leading)
            if Theme.isRenderingOffscreen {
                // An empty field renders empty, as the live TextField does.
                Text(text.wrappedValue)
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
