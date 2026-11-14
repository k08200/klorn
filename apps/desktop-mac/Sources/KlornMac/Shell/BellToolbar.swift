import AppKit

/// The toolbar's bell (NC2-A, founder decision 2026-11-13), between the
/// theme toggle and the Assistant button. Clicking it toggles the floating
/// notification panel; a numeric badge counts unread "now" + "today" rows
/// (`NotificationFeedRules.badgeCount`). AppKit, like `AssistantToolbar`:
/// the window is an AppKit `NSWindow` (see `MainWindowController`).
@MainActor
enum BellToolbar {
    static let itemIdentifier = NSToolbarItem.Identifier("klorn.notifications")
    static let symbol = "bell"
    static let labelKey = "nc.toolbar.label"
    /// The badge's diameter and its offset into the button's top-right corner.
    static let badgeHeight: CGFloat = 15
    static let badgeInset: CGFloat = 1

    /// The button plus its badge, in one view the toolbar item hosts.
    final class BellView: NSView {
        let button: NSButton
        let badge: NSTextField

        init(target: AnyObject, action: Selector) {
            button = NSButton(
                image: NSImage(systemSymbolName: BellToolbar.symbol, accessibilityDescription: nil) ?? NSImage(),
                target: target, action: action)
            button.bezelStyle = .toolbar
            button.imagePosition = .imageOnly
            button.setButtonType(.pushOnPushOff)
            badge = NSTextField(labelWithString: "")
            super.init(frame: .zero)
            badge.font = .monospacedDigitSystemFont(ofSize: 10, weight: .semibold)
            badge.textColor = BellToolbar.nsColor((1, 1, 1, 1))
            badge.alignment = .center
            badge.wantsLayer = true
            badge.layer?.backgroundColor = BellToolbar.nsColor(Theme.todayPushInkComponents(dark: false)).cgColor
            badge.layer?.cornerRadius = BellToolbar.badgeHeight / 2
            badge.isHidden = true
            badge.setAccessibilityElement(false)
            for view in [button, badge] {
                view.translatesAutoresizingMaskIntoConstraints = false
                addSubview(view)
            }
            NSLayoutConstraint.activate([
                button.leadingAnchor.constraint(equalTo: leadingAnchor),
                button.trailingAnchor.constraint(equalTo: trailingAnchor),
                button.topAnchor.constraint(equalTo: topAnchor),
                button.bottomAnchor.constraint(equalTo: bottomAnchor),
                badge.topAnchor.constraint(equalTo: topAnchor, constant: -BellToolbar.badgeInset),
                badge.trailingAnchor.constraint(equalTo: trailingAnchor, constant: BellToolbar.badgeInset),
                badge.heightAnchor.constraint(equalToConstant: BellToolbar.badgeHeight),
                badge.widthAnchor.constraint(greaterThanOrEqualToConstant: BellToolbar.badgeHeight),
            ])
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { nil }
    }

    static func makeItem(target: AnyObject, action: Selector) -> (NSToolbarItem, BellView) {
        let view = BellView(target: target, action: action)
        let item = NSToolbarItem(itemIdentifier: itemIdentifier)
        item.label = L(labelKey)
        item.paletteLabel = L(labelKey)
        item.toolTip = L("nc.toolbar.help")
        item.view = view
        update(view, count: 0, open: false)
        return (item, view)
    }

    /// Point the bell at the unread count and the panel's state.
    static func update(_ view: BellView?, count: Int, open: Bool) {
        guard let view else { return }
        let text = NotificationFeedRules.badgeText(count)
        view.badge.stringValue = text.map { " \($0) " } ?? ""
        view.badge.isHidden = text == nil
        view.button.state = open ? .on : .off
        let label = accessibilityLabel(count: count)
        view.button.toolTip = L("nc.toolbar.help")
        view.button.setAccessibilityLabel(label)
    }

    /// "Notifications" or "Notifications, 3 unread". Pure.
    static func accessibilityLabel(count: Int) -> String {
        count > 0 ? L("nc.toolbar.a11y.unread", count) : L(labelKey)
    }

    static func nsColor(_ c: Theme.RGBA) -> NSColor {
        NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: c.a)
    }
}
