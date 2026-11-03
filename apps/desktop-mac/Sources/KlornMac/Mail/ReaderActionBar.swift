import SwiftUI

/// The reader's action row. At the window's floor the reading pane is about
/// 240pt wide, so the row steps down the native way instead of truncating
/// labels to "AI로… / 미…": full labels, then the primary keeps its words
/// while the rest go icon-only, then every action icon-only. Icon-only
/// controls keep their words as tooltip and spoken label.
struct ReaderActionBar: View {
    let item: FirewallItem
    let hasDraft: Bool
    let actions: ShellActions
    let onReply: () -> Void

    var body: some View {
        // First variant whose ideal width fits wins; the last always renders.
        ViewThatFits(in: .horizontal) {
            ForEach(ReaderActionRules.densities, id: \.self) { density in
                row(density)
            }
        }
    }

    private var replyTitle: String { hasDraft ? L("reading.openDraft") : L("reading.replyWithAI") }
    private var snoozeTitle: String { L("mail.snoozePrefix").trimmingCharacters(in: .whitespaces) }

    private func row(_ density: ReaderActionDensity) -> some View {
        HStack(spacing: Theme.s2) {
            primary(iconOnly: density == .icons)
            if Theme.isRenderingOffscreen {
                OffscreenMenuLabel(
                    title: snoozeTitle,
                    systemImage: density.iconOnlySecondary ? ReaderActionRules.snoozeIcon : nil)
                OffscreenMenuLabel(
                    title: ReaderActionRules.moveLabel,
                    systemImage: density.iconOnlySecondary ? ReaderActionRules.moveIcon : nil)
            } else {
                snoozeMenu(iconOnly: density.iconOnlySecondary)
                moveMenu(iconOnly: density.iconOnlySecondary)
            }
            dismiss(iconOnly: density.iconOnlySecondary)
        }
        .fixedSize()
    }

    /// The pane's one primary action: .borderedProminent in accentSolid.
    private func primary(iconOnly: Bool) -> some View {
        Button(action: onReply) {
            // The system draws a prominent label white: 2:1 on the dark
            // #38BDF8. The accent's own ink is 9.2:1.
            Group {
                if iconOnly {
                    Image(systemName: hasDraft ? ReaderActionRules.draftIcon : ReaderActionRules.replyIcon)
                } else {
                    Text(replyTitle).fontWeight(.semibold)
                }
            }
            .foregroundStyle(Theme.onAccentSolid)
        }
        .buttonStyle(.borderedProminent).tint(Theme.accentSolid)
        .controlSize(ReaderActionRules.controlSize)
        .help(replyTitle)
        .accessibilityLabel(replyTitle)
    }

    private func snoozeMenu(iconOnly: Bool) -> some View {
        // menuIndicator(.hidden) + a chevron inside ONE Text: a separate
        // Image gets reordered to the leading edge by the menu button's
        // label styling (0.4.80007).
        SnoozeMenu(item: item, onSnooze: actions.onSnooze) {
            menuTitle(iconOnly ? nil : snoozeTitle, icon: ReaderActionRules.snoozeIcon)
        }
        .menuStyle(.button).buttonStyle(.bordered)
        .controlSize(ReaderActionRules.controlSize)
        .menuIndicator(.hidden).fixedSize()
        .help(snoozeTitle)
        .accessibilityLabel(snoozeTitle)
    }

    private func moveMenu(iconOnly: Bool) -> some View {
        // Never names the current lane: the menu moves AWAY from it ("Move
        // to Push" on a Push mail read as a no-op).
        TierMenu(
            item: item, onSetTier: actions.onSetTier,
            onPinSender: actions.onPinSender, onUnpinSender: actions.onUnpinSender
        ) {
            menuTitle(iconOnly ? nil : ReaderActionRules.moveLabel, icon: ReaderActionRules.moveIcon)
        }
        .menuStyle(.button).buttonStyle(.bordered)
        .controlSize(ReaderActionRules.controlSize)
        .menuIndicator(.hidden).fixedSize()
        .help(ReaderActionRules.moveLabel)
        .accessibilityLabel(ReaderActionRules.moveLabel)
    }

    /// "Title ⌄" with words, "◷ ⌄" without — the chevron still says menu.
    private func menuTitle(_ title: String?, icon: String) -> Text {
        let lead = title.map { Text($0) } ?? Text(Image(systemName: icon))
        return lead + Text(verbatim: " ") + Text(Image(systemName: "chevron.down"))
    }

    private func dismiss(iconOnly: Bool) -> some View {
        Button { actions.onDismiss(item) } label: {
            if iconOnly {
                Image(systemName: ReaderActionRules.dismissIcon)
            } else {
                Text(L("mail.dismiss"))
            }
        }
        .buttonStyle(.bordered).controlSize(ReaderActionRules.controlSize)
        .help(L("mail.dismiss"))
        .accessibilityLabel(L("mail.dismiss"))
    }
}

/// How much of the action row keeps its words.
enum ReaderActionDensity: Hashable, CaseIterable, Sendable {
    /// Every action labelled.
    case full
    /// The primary labelled, the secondary actions icon-only.
    case primaryLabel
    /// Every action icon-only (the window's floor).
    case icons

    var iconOnlySecondary: Bool { self != .full }
}
