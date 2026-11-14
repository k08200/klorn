import AppKit
import SwiftUI

/// The assistant as a trailing panel of the main window (M3, 2026-11-13,
/// LOCKED; inside the content card since the DMG feedback), toggled by the window's "Assistant" toolbar button and ⌘J. It
/// replaced the floating circular button and its popover dock; the contents
/// are the dock's: the same thread as the Assistant section, plus the line
/// naming the mail it is looking at with you. The point is still CONTEXT
/// (founder, 2026-08-22: "탭을 옮겨가면서 해야해서 불편함") — the mail stays
/// on screen beside the panel.
///
/// A plain trailing column, not SwiftUI's `.inspector`: the inspector is an
/// AppKit split whose column the offscreen renderer draws empty (probe,
/// 2026-11-13), and the shell already avoids AppKit containers for the same
/// reason (see `MainShell`). Nothing here sends: the thread's own composer is
/// the only send path, unchanged.
struct AssistantPanel: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            // The anchor line: what the assistant is looking at with
            // you. Absent when nothing is open — never a fake claim.
            if let subject = model.openedEmail?.subject, !subject.isEmpty {
                HStack(spacing: Theme.s1) {
                    Image(systemName: "envelope").font(Theme.Typo.caption)
                        .foregroundStyle(Theme.todayInk3).accessibilityHidden(true)
                    Text(subject).font(Theme.Typo.caption).foregroundStyle(Theme.todayInk3)
                        .lineLimit(1).truncationMode(.tail)
                }
                .padding(.horizontal, Theme.s3).padding(.bottom, Theme.s2)
                .accessibilityLabel(L("assistant.dock.context.a11y", subject))
            }
            Rectangle().fill(Theme.todayLine).frame(height: Theme.hairline)
            AssistantThread(showsStarters: false)
        }
        .frame(width: AssistantPanelRules.width)
        .frame(maxHeight: .infinity, alignment: .top)
        // Its own card inside the content card (founder, 2026-11-13): the
        // content card's radius, the same 8pt inset from its edges.
        .background(Theme.todayRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.contentCard))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.contentCard))
    }

    private var header: some View {
        HStack(spacing: Theme.s2) {
            Image(systemName: AssistantToolbar.symbol).font(Theme.Typo.caption).foregroundStyle(Theme.accent)
                .accessibilityHidden(true)
            Text(L("section.assistant"))
                .font(Theme.Typo.head).foregroundStyle(Theme.todayInk1)
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: Theme.s1)
            Button {
                model.showAssistantPanel = false
            } label: {
                Image(systemName: "xmark").font(Theme.Typo.caption.weight(.semibold))
                    .frame(width: AssistantPanelRules.closeTarget, height: AssistantPanelRules.closeTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(Theme.todayInk2)
            .help(L("assistant.dock.close.a11y"))
            .accessibilityLabel(L("assistant.dock.close.a11y"))
        }
        .padding(.leading, Theme.s3).padding(.trailing, AssistantPanelRules.inset)
        .frame(height: AssistantPanelRules.headerHeight)
    }
}

/// Pure rules for the panel, pinned by the self-check.
enum AssistantPanelRules {
    /// The dock's old width less its card inset: wide enough for the
    /// thread's bubbles, narrow enough that main window floor + panel still
    /// fits a 1280pt display.
    static let width: CGFloat = 360
    /// The gap between the panel and the content card's edges, and between
    /// the close button and the panel's edge: the card's own 8pt inset.
    static let inset: CGFloat = Theme.s2
    /// The close button's hit target (≥28pt, founder 2026-11-13).
    static let closeTarget: CGFloat = 28
    static let headerHeight: CGFloat = 44

    /// The panel's frame in the window (top-left origin): inside the content
    /// card, which is inset `inset` from the window's trailing and bottom
    /// edges and starts `inset` below the title bar. The panel was a full-
    /// height column under the transparent title bar, so its close button
    /// sat beneath the toolbar's own Assistant button (the clipped X).
    static func frame(windowWidth: CGFloat, windowHeight: CGFloat, titlebarHeight: CGFloat) -> CGRect {
        let top = titlebarHeight + inset
        return CGRect(
            x: windowWidth - 2 * inset - width, y: top,
            width: width, height: max(0, windowHeight - top - 2 * inset))
    }

    /// The close button inside a panel frame: trailing, centred in the header.
    static func closeButtonFrame(panel: CGRect) -> CGRect {
        CGRect(
            x: panel.maxX - inset - closeTarget, y: panel.minY + (headerHeight - closeTarget) / 2,
            width: closeTarget, height: closeTarget)
    }

    /// Whole on screen: inside the window's width and below the title bar,
    /// where nothing of the toolbar can cover it.
    static func isWhollyVisible(_ rect: CGRect, windowWidth: CGFloat, titlebarHeight: CGFloat) -> Bool {
        rect.minX >= 0 && rect.maxX <= windowWidth && rect.minY >= titlebarHeight
    }

    /// Whether the panel is on screen. Signed out has no thread; a modal
    /// owns the window; the Assistant section already IS the thread.
    static func isVisible(open: Bool, signedIn: Bool, modalOpen: Bool, section: NavSection) -> Bool {
        open && signedIn && !modalOpen && section != .assistant
    }

    /// The main window's usable-width floor: the shell's own floor, plus the
    /// panel while it shows, so opening it never squeezes the mail columns
    /// below what they need.
    static func minContentWidth(panelVisible: Bool) -> CGFloat {
        MainWindowRules.minSize.width + (panelVisible ? width : 0)
    }
}

extension AppModel {
    /// `AssistantPanelRules.isVisible` for the live model.
    var assistantPanelVisible: Bool {
        AssistantPanelRules.isVisible(
            open: showAssistantPanel, signedIn: phase == .signedIn, modalOpen: fullViewModalOpen,
            section: mainNav.section)
    }

    /// Whether the toggle (toolbar button, ⌘J) can do anything visible.
    var canToggleAssistantPanel: Bool {
        phase == .signedIn && !fullViewModalOpen && mainNav.section != .assistant
    }
}

/// The main window's trailing toolbar button: the `text.bubble` symbol with
/// its "Assistant" label visible beside it (M3). AppKit, because the window
/// is an AppKit `NSWindow` (see `MainWindowController`). ⌘J lives on the
/// View menu item, which owns the key equivalent for every window.
@MainActor
enum AssistantToolbar {
    static let itemIdentifier = NSToolbarItem.Identifier("klorn.assistant")
    static let symbol = "text.bubble"
    static let labelKey = "assistant.toolbar.label"

    static func makeButton(target: AnyObject, action: Selector) -> NSButton {
        let image = NSImage(
            systemSymbolName: symbol, accessibilityDescription: nil)
        let button = NSButton(title: L(labelKey), image: image ?? NSImage(), target: target, action: action)
        button.imagePosition = .imageLeading
        button.bezelStyle = .toolbar
        button.setButtonType(.pushOnPushOff)
        button.toolTip = L("assistant.toolbar.help")
        button.setAccessibilityLabel(L(labelKey))
        return button
    }

    static func makeItem(target: AnyObject, action: Selector) -> NSToolbarItem {
        let item = NSToolbarItem(itemIdentifier: itemIdentifier)
        item.label = L(labelKey)
        item.paletteLabel = L(labelKey)
        item.toolTip = L("assistant.toolbar.help")
        item.view = makeButton(target: target, action: action)
        return item
    }
}

/// Offscreen render harness for the panel (ImageRenderer draws ScrollView
/// content empty, so the panel gets its own shot like the other overlays).
struct AssistantPanelRenderProbe: View {
    var body: some View {
        AssistantPanel().frame(height: 460)
    }
}
