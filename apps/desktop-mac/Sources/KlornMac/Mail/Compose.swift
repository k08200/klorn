import SwiftUI

/// Where the composer is drawn: a card over the bar's full view, or filling
/// its own window (M5, `macMainWindow`).
enum ComposeStyle { case overlay, window }

/// New-mail composer: to / subject / body, manual send through
/// POST /api/email/send. The user writes and sends — no AI in the loop here,
/// so there is nothing to approve. Server enforces the Pro gate.
struct ComposePanel: View {
    @Environment(AppModel.self) private var model
    @FocusState private var focusTo: Bool
    var style: ComposeStyle = .overlay
    /// The window's Discard Draft: the controller confirms, then discards.
    var onDiscard: () -> Void = {}

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 12) {
            // The window's title bar carries the title and the close button.
            if style == .overlay {
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
            }

            field(L("compose.to"), text: $model.composeTo)
                .focused($focusTo)
            field(L("compose.subject"), text: $model.composeSubject)

            Group {
                if Theme.isRenderingOffscreen {
                    Text(model.composeBody.isEmpty ? L("compose.bodyPlaceholder") : model.composeBody)
                        .font(.callout).foregroundStyle(Theme.textDim)
                        .frame(
                            maxWidth: .infinity, minHeight: 170, maxHeight: bodyMaxHeight,
                            alignment: .topLeading)
                        .padding(8)
                } else {
                    TextEditor(text: $model.composeBody)
                        .font(.callout).foregroundStyle(Theme.text)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 170, maxHeight: bodyMaxHeight)
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
                if style == .overlay {
                    Button(L("compose.cancel")) {
                        model.discardComposeDraft()
                        model.showCompose = false
                    }
                        .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                        .disabled(model.composeSending)
                        .keyboardShortcut(.cancelAction)
                } else {
                    // Named for what it does, and never on Escape: in a
                    // window, closing (⌘W) keeps the draft.
                    Button(L("compose.discard"), action: onDiscard)
                        .buttonStyle(.plain).font(Theme.Typo.label)
                        .foregroundStyle(Theme.textDim)
                        .disabled(model.composeSending)
                        .padding(.trailing, Theme.s2)
                }
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
        .modifier(ComposeChrome(style: style))
        .onAppear { focusTo = true }
    }

    /// The body grows with the window; the overlay card keeps its height.
    private var bodyMaxHeight: CGFloat? { style == .window ? .infinity : nil }

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

/// The composer's outer chrome: a floating card as an overlay, the window's
/// own surface edge to edge in the compose window.
private struct ComposeChrome: ViewModifier {
    let style: ComposeStyle

    func body(content: Content) -> some View {
        switch style {
        case .overlay:
            content
                .padding(20)
                .frame(width: 540)
                .background(Theme.bg, in: RoundedRectangle(cornerRadius: 18))
                .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.line))
                .shadow(color: Theme.panelShadow, radius: 24, y: 8)
        case .window:
            content
                .padding(Theme.s4)
                .frame(
                    minWidth: ComposeWindowRules.minSize.width, maxWidth: .infinity,
                    minHeight: ComposeWindowRules.minSize.height, maxHeight: .infinity,
                    alignment: .top)
                .background(Theme.bg)
        }
    }
}

/// Offscreen render harness for the composer (same reason as the briefing
/// probe: overlays inside the full view's ZStack are awkward to shoot).
struct ComposePanelRenderProbe: View {
    var body: some View {
        ComposePanel().padding(24)
    }
}
