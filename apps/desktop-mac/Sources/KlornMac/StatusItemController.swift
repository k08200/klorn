import AppKit

/// The macOS menu-bar anchor while the pill is OFF — proof the firewall is
/// still running, and the place to quit or bring the bar back. Dogfood
/// feedback (2026-07-16): hiding the pill must not mean "invisible AND
/// unkillable"; the icon appears exactly when the pill disappears, so there
/// is always ONE anchor on screen — never both, never neither. While the
/// pill is visible it is the anchor (Quit lives in its expanded panel).
@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    private let model: AppModel
    private let topBar: TopBarController
    private var statusItem: NSStatusItem?

    init(model: AppModel, topBar: TopBarController) {
        self.model = model
        self.topBar = topBar
        super.init()
    }

    /// The one-anchor rule. Pure for testing.
    nonisolated static func shouldShow(pillVisible: Bool) -> Bool {
        !pillVisible
    }

    /// Keep the icon's presence in sync with the pill setting, from wherever
    /// it changes (pill ✕, Preferences toggle, this menu). @Observable
    /// tracking re-arms after every change.
    func startSyncing() {
        withObservationTracking {
            setInstalled(Self.shouldShow(pillVisible: model.settings.pillVisible))
            // Reading the push count here re-arms tracking on queue changes,
            // so the center dot follows PUSH>0 live.
            refreshIcon()
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in self?.startSyncing() }
        }
    }

    private func setInstalled(_ wanted: Bool) {
        if wanted, statusItem == nil {
            install()
        } else if !wanted, let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
            statusItem = nil
        }
    }

    private func install() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            // Hand-drawn bold ring (the SF "circle" hairline read as anemic —
            // dogfood screenshot 2026-07-20). Template = correct in light/dark
            // menu bars; a center dot appears while PUSH mail is waiting.
            button.image = Self.ringIcon(pushWaiting: (model.queue?.summary.push ?? 0) > 0)
        }
        let menu = NSMenu()
        // Rebuilt on every open (menuNeedsUpdate); manual enabling so the
        // status line can be a disabled, non-clickable readout.
        menu.autoenablesItems = false
        menu.delegate = self
        item.menu = menu
        statusItem = item
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        let status = NSMenuItem(
            title: Self.statusLine(
                signedIn: model.phase == .signedIn,
                pushCount: model.queue?.summary.push ?? 0),
            action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        menu.addItem(.separator())

        // The icon only exists while the pill is hidden, so this is always "Show".
        menu.addItem(actionItem("Show top bar", #selector(showBar)))
        menu.addItem(actionItem("Open web inbox", #selector(openWeb)))
        menu.addItem(actionItem("Preferences…", #selector(openPreferences)))
        menu.addItem(.separator())
        if model.phase == .signedIn {
            menu.addItem(actionItem("Sign out", #selector(signOut)))
        } else {
            menu.addItem(actionItem("Sign in…", #selector(signIn)))
        }
        menu.addItem(actionItem("Quit Klorn", #selector(quit), key: "q"))
    }

    private func actionItem(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.isEnabled = true
        return item
    }

    // MARK: - Pure (self-check)

    /// Top readout of the menu: running proof + the number that matters.
    /// The menu-bar glyph: the Klorn "K" (rounded heavy — same letterform as
    /// the app icon), with a corner dot while PUSH mail waits. Template so it
    /// renders correctly in light/dark menu bars.
    static func ringIcon(pushWaiting: Bool) -> NSImage {
        let side: CGFloat = 18
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { _ in
            let base = NSFont.systemFont(ofSize: 14, weight: .heavy)
            let font: NSFont =
                base.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: 14) }
                ?? base
            let k = NSAttributedString(
                string: "K", attributes: [.font: font, .foregroundColor: NSColor.black])
            let textSize = k.size()
            k.draw(at: NSPoint(x: (side - textSize.width) / 2, y: (side - textSize.height) / 2 - 0.5))
            if pushWaiting {
                let dot: CGFloat = 5
                NSBezierPath(
                    ovalIn: NSRect(x: side - dot - 0.5, y: side - dot - 0.5, width: dot, height: dot))
                    .fill()
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = pushWaiting ? "Klorn — urgent mail waiting" : "Klorn"
        return image
    }

    /// Refresh the glyph when the PUSH count crosses zero (called by the sync).
    func refreshIcon() {
        statusItem?.button?.image = Self.ringIcon(pushWaiting: (model.queue?.summary.push ?? 0) > 0)
    }

    nonisolated static func statusLine(signedIn: Bool, pushCount: Int) -> String {
        guard signedIn else { return "Klorn — not signed in" }
        return pushCount == 0 ? "Klorn — no urgent mail" : "Klorn — \(pushCount) PUSH waiting"
    }

    // MARK: - Actions

    @objc private func showBar() {
        model.settings.pillVisible = true  // observation removes the icon
        topBar.refresh()
    }

    @objc private func openWeb() {
        if let url = URL(string: Config.webBaseURL) { NSWorkspace.shared.open(url) }
    }

    @objc private func openPreferences() {
        topBar.openPreferences()
    }

    @objc private func signOut() {
        model.signOut()
    }

    @objc private func signIn() {
        Task { await model.signIn() }
    }

    @objc private func quit() {
        NSApplication.shared.terminate(nil)
    }
}
