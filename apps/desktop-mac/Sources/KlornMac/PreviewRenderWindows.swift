import AppKit
import SwiftUI

// Offscreen shots of the compose window and the main window's sheets (M5),
// part of `--render-previews`. A native window or sheet cannot be drawn
// offscreen, so each shot is the content the window or sheet hosts, at the
// size it gets there. Fixture DATA lives in JSON like the other shots.

extension PreviewRender {
    private static let composeDraftJSON = """
    {"to":"sarah.kim@northwind-partners.com",
     "subject":"Contract review: signed copy attached",
     "body":"Hi Sarah,\\n\\nBoth changes to clause 4 read fine. The signed copy is on its way from legal this afternoon.\\n\\nOne question before the counterparty signs: does the notice period start on the signing date or on delivery?\\n\\nThanks,\\nYong"}
    """

    static func renderWindows(dir: URL, dark: Bool) -> Bool {
        var ok = true
        func shot(_ name: String, size: CGSize, _ model: AppModel, @ViewBuilder _ content: () -> some View) {
            ok = writeShot(name, size: size, align: .top, model: model, dir: dir, dark: dark, content) && ok
        }

        // Never the default store: see `run`.
        let model = AppModel(tokenStore: InMemoryTokenStore())
        model.seedForPreview(firewallJSON: "", emailJSON: "", selectedItemId: nil)
        if let draft = try? JSONDecoder().decode([String: String].self, from: Data(composeDraftJSON.utf8)) {
            model.composeTo = draft["to"] ?? ""
            model.composeSubject = draft["subject"] ?? ""
            model.composeBody = draft["body"] ?? ""
        }
        shot("compose-window", size: ComposeWindowRules.defaultSize, model) {
            ComposePanel(style: .window)
        }
        // The floor the window can be dragged to: nothing may clip there.
        shot("compose-window-min", size: ComposeWindowRules.minSize, model) {
            ComposePanel(style: .window)
        }
        let empty = AppModel(tokenStore: InMemoryTokenStore())
        empty.seedForPreview(firewallJSON: "", emailJSON: "", selectedItemId: nil)
        shot("compose-window-empty", size: ComposeWindowRules.defaultSize, empty) {
            ComposePanel(style: .window)
        }

        // The sheets, at the size each card asks for.
        shot("sheet-tier-guide", size: CGSize(width: 504, height: 470), model) {
            MainSheetContent(sheet: .tierGuide)
        }
        shot("sheet-purpose-prompt", size: CGSize(width: 474, height: 200), model) {
            MainSheetContent(sheet: .purposePrompt)
        }
        return ok
    }
}
