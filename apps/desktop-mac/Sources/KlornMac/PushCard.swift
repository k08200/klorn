import SwiftUI

/// Observable state for the one visible PushCard. Owned by PushCardController;
/// the SwiftUI view below renders it and delegates every action back.
@MainActor
@Observable
final class PushCardState {
    enum Drafts: Equatable {
        case loading
        case ready([ReplyOption])
        case needsPro
        case failed(String)
    }

    var item: FirewallItem?
    var pendingCount = 0
    var drafts: Drafts = .loading
    /// compact ↔ expanded (click toggles; expanding also arms the keyboard).
    var layout: CardLayout = .compact
    /// Email detail (Klorn summary) prefetched for the expanded view; nil until
    /// loaded or when the fetch failed (the view falls back to the snippet).
    var detail: EmailDetail?
    /// Index mid-send (spinner on that row); nil when idle.
    var sendingIndex: Int?
    /// Index that was sent (checkmark) just before the card advances.
    var sentIndex: Int?
    var sendError: String?
    /// True while the panel is key — the only state in which 1/2/3/⏎/esc work.
    var keysArmed = false
}

/// Actions the card delegates back to the controller.
struct PushCardActions {
    let onSend: (Int) -> Void
    let onOpen: () -> Void
    let onDismiss: () -> Void
    /// Snooze the item server-side; it resurfaces at the chosen time.
    let onSnooze: (SnoozeOption) -> Void
    let onRetry: () -> Void
    /// Click on the card: toggle compact ↔ expanded (expanding arms the keys).
    let onToggleExpand: () -> Void
    /// "Show all N" — open the bar's panel with the whole PUSH list.
    let onShowAll: () -> Void
}

enum PushCardMetrics {
    static let compact = NSSize(width: 460, height: 344)
    static let expanded = NSSize(width: 560, height: 600)
    static let corner: CGFloat = 16

    static func size(for layout: CardLayout) -> NSSize {
        layout == .compact ? compact : expanded
    }

    /// Where the present-morph begins: a thin strip hugging the target's top
    /// edge (so the card appears to unroll downward from the pill), centered on
    /// the same axis. Pure for testing.
    static func presentStartFrame(target: NSRect) -> NSRect {
        let height: CGFloat = 60
        let width = target.width * 0.8
        return NSRect(
            x: target.midX - width / 2,
            y: target.maxY - height,
            width: width,
            height: height)
    }
}

/// The interrupt card for one PUSH email: sender · subject · why-PUSH, then the
/// 3 tone drafts (click to send), then the key hints. Never steals focus on
/// appear; clicking the card (or the global hotkey) arms the keyboard.
struct PushCard: View {
    let state: PushCardState
    let actions: PushCardActions
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        let size = PushCardMetrics.size(for: state.layout)
        VStack(alignment: .leading, spacing: 10) {
            header
            Divider().overlay(Theme.line)
            if state.layout == .expanded {
                summarySection
                bodySection
            }
            content
            Spacer(minLength: 0)
            footer
        }
        .padding(14)
        .frame(width: size.width, height: size.height, alignment: .top)
        .background(
            RoundedRectangle(cornerRadius: PushCardMetrics.corner)
                .fill(Color.black.opacity(Theme.panelOpacity(reduceTransparency: reduceTransparency)))
                .overlay(
                    RoundedRectangle(cornerRadius: PushCardMetrics.corner)
                        .strokeBorder(state.keysArmed ? Theme.accent.opacity(0.6) : Theme.line))
        )
        .clipShape(RoundedRectangle(cornerRadius: PushCardMetrics.corner))
        .contentShape(RoundedRectangle(cornerRadius: PushCardMetrics.corner))
        .onTapGesture { actions.onToggleExpand() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Urgent email card")
        .accessibilityHint(state.layout == .compact ? "Click to expand" : "Click to collapse")
    }

    /// Expanded-only: Klorn's AI summary of the email (snippet fallback while
    /// the detail loads or when the email has no summary).
    @ViewBuilder
    private var summarySection: some View {
        if let text = cardDetailText(
            summary: state.detail?.summary, snippet: state.item?.email?.snippet)
        {
            VStack(alignment: .leading, spacing: 4) {
                Text("Summary")
                    .font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
                Text(text)
                    .font(.caption).foregroundStyle(Theme.text)
                    .lineLimit(5).multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(10)
            .background(Color.white.opacity(0.03), in: RoundedRectangle(cornerRadius: 10))
            Divider().overlay(Theme.line)
        }
    }

    /// Expanded-only: the email body inline, so the user can read it in the
    /// card without leaving for the web inbox. Scrolls; reading here never
    /// marks the mail read (the detail fetch is a plain GET, no markRead).
    @ViewBuilder
    private var bodySection: some View {
        if let body = cardBodyText(state.detail?.text) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Message").font(.caption2.weight(.semibold)).foregroundStyle(Theme.textDim)
                ScrollView {
                    Text(body).font(.caption).foregroundStyle(Theme.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 120)
            }
            Divider().overlay(Theme.line)
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle().fill(Theme.tint(.push)).frame(width: 8, height: 8).padding(.top, 5)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(state.item?.email?.from ?? state.item?.title ?? "")
                    .font(.callout.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(1)
                Text(state.item?.email?.subject ?? state.item?.title ?? "")
                    .font(.caption).foregroundStyle(Theme.textDim).lineLimit(1)
                if let reason = state.item?.tierReason, !reason.isEmpty {
                    Text(reason).font(.caption2).foregroundStyle(Theme.textDim.opacity(0.8)).lineLimit(1)
                }
            }
            Spacer()
            if let label = showAllLabel(pendingCount: state.pendingCount) {
                Button(label, action: actions.onShowAll)
                    .buttonStyle(.plain).font(.caption2.weight(.semibold))
                    .foregroundStyle(Theme.accent)
                    .accessibilityLabel("Show all queued urgent emails")
            }
            Menu {
                ForEach(PushCardSnooze.options) { option in
                    Button(option.label) { actions.onSnooze(option) }
                }
            } label: {
                Image(systemName: "moon.zzz")
                    .font(.caption.weight(.semibold)).foregroundStyle(Theme.textDim)
                    .frame(width: 28, height: 28)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .help("Snooze until later")
            .accessibilityLabel("Snooze this email")
            Button(action: actions.onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold)).foregroundStyle(Theme.textDim)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss card")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch state.drafts {
        case .loading:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Drafting replies…").font(.caption).foregroundStyle(Theme.textDim)
            }
            .frame(maxWidth: .infinity, minHeight: 180)
        case .needsPro:
            VStack(alignment: .leading, spacing: 8) {
                Text("Quick replies need Klorn Pro.")
                    .font(.callout).foregroundStyle(Theme.text)
                Text("Press ⏎ or click Open to handle it on the web inbox.")
                    .font(.caption).foregroundStyle(Theme.textDim)
            }
            .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                Text(message).font(.caption).foregroundStyle(Theme.textDim)
                Button("Try again", action: actions.onRetry)
                    .buttonStyle(.bordered).controlSize(.small).tint(Theme.accent)
            }
            .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
        case .ready(let options):
            VStack(spacing: 6) {
                ForEach(Array(options.prefix(3).enumerated()), id: \.offset) { index, option in
                    OptionRow(
                        index: index,
                        option: option,
                        bodyLines: state.layout == .expanded ? 4 : 2,
                        isSending: state.sendingIndex == index,
                        isSent: state.sentIndex == index,
                        disabled: state.sendingIndex != nil || state.sentIndex != nil,
                        send: { actions.onSend(index) })
                }
                if let sendError = state.sendError {
                    Text(sendError).font(.caption2).foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private var footer: some View {
        HStack {
            Text(state.keysArmed
                 ? "1 · 2 · 3 send   ⏎ open   esc dismiss"
                 : state.layout == .compact
                     ? "click to expand · ⏎ open on web"
                     : "click to collapse · ⏎ open on web")
                .font(.caption2).foregroundStyle(Theme.textDim)
            Spacer()
            Button("Open", action: actions.onOpen)
                .buttonStyle(.plain).font(.caption.weight(.semibold)).foregroundStyle(Theme.accent)
                .accessibilityLabel("Open on web inbox")
        }
    }
}

/// One selectable draft: tone chip + two-line preview. Click = send, exactly
/// what keys 1/2/3 do when armed.
private struct OptionRow: View {
    let index: Int
    let option: ReplyOption
    let bodyLines: Int
    let isSending: Bool
    let isSent: Bool
    let disabled: Bool
    let send: () -> Void
    @State private var hovering = false

    private var toneColor: Color {
        switch option.tone {
        case "accept": .green
        case "decline": .orange
        default: .blue
        }
    }

    var body: some View {
        Button(action: send) {
            HStack(alignment: .top, spacing: 8) {
                Text("\(index + 1)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(Theme.textDim)
                    .frame(width: 14, alignment: .center)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    Text(option.toneLabel)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(toneColor)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(toneColor.opacity(0.15), in: Capsule())
                    Text(option.body)
                        .font(.caption).foregroundStyle(Theme.text)
                        .lineLimit(bodyLines).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                if isSending {
                    ProgressView().controlSize(.small).padding(.top, 2)
                } else if isSent {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green).padding(.top, 2)
                        .accessibilityLabel("Sent")
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(hovering && !disabled ? Color.white.opacity(0.08) : Color.white.opacity(0.03)))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .onHover { hovering = $0 }
        .accessibilityLabel("Send \(option.toneLabel) reply: \(option.body)")
    }
}
