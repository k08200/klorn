import SwiftUI

/// The assistant column: an in-session thread with the mail/calendar agent.
/// Synchronous turns (the API returns the full reply); the composer disables
/// while a turn is in flight. Never steals focus — lives in the key-able full
/// view like the reply composer.
/// The assistant column (sidebar tab): section header + the shared thread.
/// Thread + composer — the assistant itself, with no chrome of its own. Shared
/// by the sidebar tab and the floating dock so both stay one conversation
/// (the model owns the messages), and a fix lands in both at once.
struct AssistantThread: View {
    var showsStarters = true
    /// The main window's thread is laid out directly under the offscreen
    /// renderer; the dock keeps its scroller there, as before.
    var inlineWhenOffscreen = false
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if Theme.isRenderingOffscreen && inlineWhenOffscreen {
                // ImageRenderer draws nothing inside a ScrollView.
                messages
                Spacer(minLength: 0)
            } else {
                ScrollViewReader { proxy in
                    ScrollView { messages }
                        .onChange(of: model.chatMessages) { _, _ in
                            withAnimation { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                        }
                }
            }

            HStack(spacing: Theme.s2) {
                if Theme.isRenderingOffscreen {
                    // TextField is AppKit-backed; ImageRenderer paints it as
                    // its "restricted" placeholder.
                    Text(draft.isEmpty ? L("assistant.placeholder") : draft)
                        .font(.callout).foregroundStyle(draft.isEmpty ? Theme.textDim : Theme.text)
                        .lineLimit(1...4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    TextField(L("assistant.placeholder"), text: $draft, axis: .vertical)
                        .textFieldStyle(.plain).font(.callout).foregroundStyle(Theme.text)
                        .lineLimit(1...4)
                        .focused($composerFocused)
                        .onSubmit { send() }
                        .accessibilityLabel(L("assistant.placeholder.a11y"))
                }
                Button { send() } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .buttonStyle(.plain)
                .foregroundStyle(canSendChat(draft, busy: model.isChatting) ? Theme.accent : Theme.textDim)
                .disabled(!canSendChat(draft, busy: model.isChatting))
                .accessibilityLabel(L("assistant.send.a11y"))
            }
            .padding(.horizontal, Theme.s3).padding(.vertical, 10)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12)
                .strokeBorder(composerFocused ? Theme.accent.opacity(0.5) : Theme.field))
            .padding(.horizontal, Theme.s4).padding(.vertical, Theme.s3)
        }
        .onAppear { composerFocused = true }
        // Continue the last conversation after a relaunch (once per session).
        .task {
            if !Theme.isRenderingOffscreen { await model.restoreChatHistory() }
        }
    }

    private var messages: some View {
        LazyVStack(alignment: .leading, spacing: 10) {
            if model.chatMessages.isEmpty {
                VStack(spacing: Theme.s4) {
                    EmptyState(
                        icon: "sparkles",
                        title: L("assistant.empty"))
                    // One-click starters: discoverability beats a
                    // blank prompt. Each sends immediately. The
                    // dock is too narrow for them — it opens with
                    // the mail already in context instead.
                    if showsStarters {
                    VStack(spacing: Theme.s2) {
                        ForEach([
                            L("assistant.starter.1"),
                            L("assistant.starter.2"),
                            L("assistant.starter.3"),
                        ], id: \.self) { suggestion in
                            Button {
                                Task { await model.sendChat(suggestion) }
                            } label: {
                                Text(suggestion)
                                    .font(.caption).foregroundStyle(Theme.text)
                                    .padding(.horizontal, Theme.s3)
                                    .padding(.vertical, Theme.s2)
                                    .background(Theme.surfaceRaised, in: Capsule())
                                    .overlay(Capsule().strokeBorder(Theme.line))
                            }
                            .buttonStyle(.plain)
                            .disabled(model.isChatting)
                        }
                    }
                    }
                }
                .padding(.top, Theme.s6)
            }
            ForEach(model.chatMessages) { message in
                ChatBubble(message: message)
            }
            if model.isChatting {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(L("assistant.thinking")).font(.caption).foregroundStyle(Theme.textDim)
                }
                .padding(.horizontal, 16)
            }
            Color.clear.frame(height: 1).id("chat-bottom")
        }
        .padding(.vertical, 12)
    }

    private func send() {
        let text = draft
        guard canSendChat(text, busy: model.isChatting) else { return }
        draft = ""
        Task { await model.sendChat(text) }
    }
}

private struct ChatBubble: View {
    @Environment(AppModel.self) private var model
    let message: ChatMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                if message.role == .user { Spacer(minLength: 40) }
                // Assistant replies carry markdown (**bold** rendered literally
                // on screen, design audit 2026-07-20); user/failure text stays raw.
                (message.role == .assistant
                    ? Text(chatMarkdown(message.text)) : Text(message.text))
                    .font(.callout)
                    .foregroundStyle(message.role == .failure ? Theme.accent : Theme.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(
                        message.role == .user ? Theme.surfaceSelected : Theme.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: 10))
                if message.role != .user { Spacer(minLength: 40) }
            }
            .accessibilityLabel(
                message.role == .user ? L("assistant.message.user.a11y", message.text)
                    : message.role == .failure ? L("assistant.message.failure.a11y", message.text)
                    : L("assistant.message.reply.a11y", message.text))

            // A plan refusal (Pro-only action, the free daily AI allowance).
            if message.offersUpgrade { UpgradeToProLink() }

            // Agent-drafted event: nothing is written until the user clicks.
            if let draft = message.eventDraft {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: "calendar.badge.plus").font(.caption)
                            .foregroundStyle(Theme.accent).accessibilityHidden(true)
                        Text(eventDraftLabel(draft))
                            .font(.caption).foregroundStyle(Theme.text).lineLimit(2)
                    }
                    // Invitees must be visible BEFORE approval — approving is
                    // what sends the invitations (team mode P2).
                    if let attendees = draft.attendees, !attendees.isEmpty {
                        Text(L("calendar.invitees", attendees.joined(separator: ", ")))
                            .font(.caption2).foregroundStyle(Theme.textDim).lineLimit(2)
                    }
                    HStack(spacing: 8) {
                        Button(L("calendar.addToCalendar")) {
                            Task { await model.createEvent(from: draft, messageId: message.id) }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        Button(L("calendar.ignore")) { model.clearEventDraft(message.id) }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                }
                .padding(10)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line))
                .accessibilityElement(children: .contain)
                .accessibilityLabel(L("calendar.proposed.a11y", eventDraftLabel(draft)))
            }
        }
        .padding(.horizontal, 16)
    }
}
