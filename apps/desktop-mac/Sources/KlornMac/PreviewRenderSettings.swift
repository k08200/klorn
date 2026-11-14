import AppKit
import SwiftUI

// The Settings panes for `--render-previews` (M4). General and Privacy are
// grouped Forms, which ImageRenderer draws as nothing (they scroll), so these
// shots go through a window-less NSHostingView's own display cache instead:
// no window is created or shown, nothing takes focus.

extension PreviewRender {
    /// One PNG per Settings tab, at the pane's own fitted height (what the
    /// Settings window sizes itself to), signed out like a first launch.
    static func renderSettingsPanes(dir: URL, dark: Bool) -> Bool {
        let model = AppModel(tokenStore: InMemoryTokenStore())
        var ok = true
        for tab in SettingsTab.allCases {
            ok = writeHostedShot("settings-pane-\(tab.rawValue)", dir: dir, dark: dark) {
                tab.pane
                    .environment(model)
                    .background(Theme.bg)
                    .environment(\.colorScheme, dark ? .dark : .light)
            } && ok
        }
        return ok
    }

    /// Render `content` at its fitting size through AppKit's display cache.
    static func writeHostedShot(
        _ name: String, dir: URL, dark: Bool, @ViewBuilder _ content: () -> some View
    ) -> Bool {
        let host = NSHostingView(rootView: content())
        host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            print("  ✗ \(name) — no bitmap for \(host.bounds.size)")
            return false
        }
        host.cacheDisplay(in: host.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            print("  ✗ \(name) — PNG encoding failed")
            return false
        }
        do {
            try png.write(to: dir.appendingPathComponent("\(name).png"))
            print("  ✓ \(name)  \(Int(host.bounds.width))×\(Int(host.bounds.height))")
            return true
        } catch {
            print("  ✗ \(name) — \(error.localizedDescription)")
            return false
        }
    }
}
