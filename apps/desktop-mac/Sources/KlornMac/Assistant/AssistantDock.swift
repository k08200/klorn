import SwiftUI

/// Floating assistant dock — bottom-right of the full view, the way the web
/// app docks it. The point is CONTEXT: the sidebar tab makes you leave the
/// mail you are reading to ask about it (founder, 2026-08-22: "탭을 옮겨가면서
/// 해야해서 불편함"), while the dock keeps the mail on screen and the model is
/// told which mail that is. Same conversation as the tab — one thread, two
/// surfaces.
struct AssistantDock: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .trailing, spacing: 10) {
            if model.showAssistantDock {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 8) {
                        Image(systemName: "sparkles").font(.caption).foregroundStyle(Theme.accent)
                            .accessibilityHidden(true)
                        Text(L("section.assistant"))
                            .font(.callout.weight(.semibold)).foregroundStyle(Theme.text)
                        Spacer(minLength: 4)
                        Button {
                            model.showAssistantDock = false
                        } label: {
                            Image(systemName: "xmark").font(.caption2.weight(.semibold))
                                .iconTarget(26)
                        }
                        .buttonStyle(.plain).foregroundStyle(Theme.textDim)
                        .accessibilityLabel(L("assistant.dock.close.a11y"))
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    // The anchor line: what the assistant is looking at with
                    // you. Absent when nothing is open — never a fake claim.
                    if let subject = model.openedEmail?.subject, !subject.isEmpty {
                        HStack(spacing: 5) {
                            Image(systemName: "envelope").font(.caption2)
                                .foregroundStyle(Theme.textDim).accessibilityHidden(true)
                            Text(subject).font(.caption2).foregroundStyle(Theme.textDim)
                                .lineLimit(1).truncationMode(.tail)
                        }
                        .padding(.horizontal, 12).padding(.bottom, 8)
                        .accessibilityLabel(L("assistant.dock.context.a11y", subject))
                    }
                    Divider().overlay(Theme.line)
                    AssistantThread(showsStarters: false)
                }
                .frame(width: 380, height: 460)
                .background(Theme.bg, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.line))
                .shadow(color: Theme.panelShadow, radius: 22, y: 8)
                .transition(
                    reduceMotion
                        ? .opacity
                        : .scale(scale: 0.97, anchor: .bottomTrailing).combined(with: .opacity))
            }
            Button {
                // Reduce Motion gets the state change with no animation at
                // all, not a shorter one.
                withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.86)) {
                    model.showAssistantDock.toggle()
                }
            } label: {
                Image(systemName: model.showAssistantDock ? "xmark" : "sparkles")
                    .font(.title3.weight(.medium))
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
                    .background(Theme.accent, in: Circle())
                    .shadow(color: Theme.accent.opacity(0.35), radius: 12, y: 4)
            }
            .buttonStyle(.plain)
            .keyboardShortcut("j", modifiers: .command)
            .help(L("assistant.dock.toggle"))
            .accessibilityLabel(L("assistant.dock.toggle"))
        }
        .padding(.trailing, 20).padding(.bottom, 20)
    }
}

/// Offscreen render harness for the dock (ImageRenderer draws ScrollView
/// content empty, so the dock gets its own shot like the other overlays).
struct AssistantDockRenderProbe: View {
    var body: some View {
        AssistantDock().padding(16)
    }
}
