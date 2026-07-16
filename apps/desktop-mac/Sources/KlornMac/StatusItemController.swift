import AppKit

/// The macOS menu-bar anchor — proof the firewall is running, and the one
/// place the app can ALWAYS be quit from. An `.accessory` app has no Dock
/// icon, and with the pill hidden (Preferences → top bar) nothing else is
/// visible at rest; dogfood feedback was literal: "once it's on there's no
/// way to turn it off". The pill/panel/PushCard remain the primary surfaces —
/// this is lifecycle chrome, not a second inbox.
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

    func install() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            // Template ring echoing the pill's LogoRing; template = correct
            // rendering in light/dark menu bars and with tinted accents.
            let image = NSImage(systemSymbolName: "circle", accessibilityDescription: "Klorn")
            image?.isTemplate = true
            button.image = image
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

        menu.addItem(actionItem(
            Self.barToggleTitle(pillVisible: model.settings.pillVisible), #selector(toggleBar)))
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
    nonisolated static func statusLine(signedIn: Bool, pushCount: Int) -> String {
        guard signedIn else { return "Klorn — not signed in" }
        return pushCount == 0 ? "Klorn — no urgent mail" : "Klorn — \(pushCount) PUSH waiting"
    }

    /// The toggle mirrors the pillVisible setting (Preferences has the same switch).
    nonisolated static func barToggleTitle(pillVisible: Bool) -> String {
        pillVisible ? "Hide top bar" : "Show top bar"
    }

    // MARK: - Actions

    @objc private func toggleBar() {
        model.settings.pillVisible.toggle()
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
